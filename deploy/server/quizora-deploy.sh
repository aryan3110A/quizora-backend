#!/bin/bash
# quizora-deploy: safe, automatic deployment of Quizora on this EC2 instance (pull-based CD).
#
# WHAT IT DOES (every step can stop the deployment; nothing is changed until all the checks before it have passed)
#   1. fetch the configured branch of the backend and frontend repositories from GitHub; nothing to do if neither changed
#   2. preflight: both working trees clean, the new commit descends from the running one (fast-forward only), disk space, and the
#      application is healthy NOW (/health/ready: database reachable). We never roll out on top of a broken system.
#   3. CI gate: GitHub Actions must have finished successfully for that exact commit (ci_gate.py; fail-closed)
#   4. remember the running images as ":rollback", move the working trees to the new commits, build the new images
#   5. run the database migration with the NEW image BEFORE touching the running containers (a failing migration stops here)
#   6. recreate the containers, restart nginx (it caches container addresses), and wait for the health checks
#   7. if anything after step 4 fails: automatically restore the previous code and images, and report it
#
# USAGE   quizora-deploy [--auto] [--force] [--skip-ci] [--skip-db-check] [--dry-run] [--rollback]
#   --auto      called by the systemd timer: silent when nothing changed; does nothing unless AUTO_DEPLOY=true in deploy.conf
#   --force     rebuild and redeploy even if the commits did not change
#   --skip-ci   do not require a green CI (emergency / testing only; it is logged)
#   --dry-run   fetch and report what would happen, change nothing
#   --rollback  restore the images and code saved before the last deployment
# Configuration (no secrets): /home/ubuntu/quizora/deploy.conf   Logs: deploy-history.log (one line per event), deploy-last.log (last build output)
#
# DATABASE MIGRATIONS ARE FORWARD-ONLY. A rollback restores the previous *code*, not the database. Write migrations that the previous version
# can still run against (add columns/tables first, remove them in a later release), or take an RDS snapshot before a risky one.
set -uo pipefail

APP_DIR="${QUIZORA_DIR:-/home/ubuntu/quizora}"
CONF="${QUIZORA_DEPLOY_CONF:-$APP_DIR/deploy.conf}"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

OWNER="${GITHUB_OWNER:-aryan3110A}"
BACKEND_REPO="${BACKEND_REPO:-quizora-backend}"
FRONTEND_REPO="${FRONTEND_REPO:-quizora-frontend}"
BACKEND_BRANCH="${BACKEND_BRANCH:-main}"
FRONTEND_BRANCH="${FRONTEND_BRANCH:-main}"
AUTO_DEPLOY="${AUTO_DEPLOY:-false}"
REQUIRE_CI="${REQUIRE_CI:-true}"
HEALTH_URL="${HEALTH_URL:-http://localhost}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-150}"
MIN_FREE_MB="${MIN_FREE_MB:-3000}"
GATE="${QUIZORA_GATE:-/usr/local/lib/quizora/ci_gate.py}"
POLL="${QUIZORA_POLL_SECONDS:-3}"

BACKEND_DIR="$APP_DIR/student-quiz-backend"
FRONTEND_DIR="$APP_DIR/student-quiz-frontend"
HISTORY="$APP_DIR/deploy-history.log"
LAST="$APP_DIR/deploy-last.log"
STATE="$APP_DIR/.deploy-state"

AUTO=0; FORCE=0; SKIP_CI=0; SKIP_DB=0; DRY=0; ROLLBACK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --auto) AUTO=1 ;; --force) FORCE=1 ;; --skip-ci) SKIP_CI=1 ;; --skip-db-check) SKIP_DB=1 ;;
    --dry-run) DRY=1 ;; --rollback) ROLLBACK_ONLY=1 ;;
    *) echo "unknown option: $arg"; exit 64 ;;
  esac
done

# run as the application user (files and Docker access belong to it)
if [ "$(id -un)" != "ubuntu" ] && [ "$(id -u)" -eq 0 ]; then exec sudo -u ubuntu -E bash "$0" "$@"; fi

say() { local line; line="$(date -u +%FT%TZ) $*"; echo "$line"; echo "$line" >> "$HISTORY"; }
quiet() { if [ "$AUTO" -eq 1 ]; then return 0; else say "$@"; fi; }   # in --auto mode stay silent unless something happens

[ "$AUTO" -eq 1 ] && [ "$AUTO_DEPLOY" != "true" ] && exit 0
cd "$APP_DIR" || { echo "no $APP_DIR"; exit 1; }
exec 9> "$APP_DIR/.deploy.lock"
flock -n 9 || { quiet "another deployment is running; exiting"; exit 0; }

gitb() { git -C "$BACKEND_DIR" "$@"; }
gitf() { git -C "$FRONTEND_DIR" "$@"; }
http_code() { curl -s -o /dev/null -w '%{http_code}' -m 8 "$1" 2> /dev/null; }
cid_of() { docker compose ps -q "$1" < /dev/null 2> /dev/null | head -1; }
health_of() { local c; c="$(cid_of "$1")"; [ -n "$c" ] && docker inspect -f '{{.State.Health.Status}}' "$c" 2> /dev/null; }

wait_healthy() { # waits for container health + HTTP checks through nginx
  # The deadline uses the shell's real-time clock ($SECONDS), not a running total of sleeps, so it cannot be skipped or looped forever
  # whatever the poll interval is (a poll interval of 0 would otherwise never reach the timeout).
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(health_of backend)" = "healthy" ] && [ "$(health_of frontend)" = "healthy" ] \
      && [ "$(http_code "$HEALTH_URL/health/ready")" = "200" ] && [ "$(http_code "$HEALTH_URL/login")" = "200" ] \
      && [ "$(http_code "$HEALTH_URL/api/v1/health")" = "200" ]; then
      return 0
    fi
    sleep "$POLL"
  done
  return 1
}

recreate_all() {
  # nginx is included so a changed compose/nginx configuration (for example log rotation) is applied; it is only recreated if it changed
  docker compose up -d --no-deps --remove-orphans backend worker frontend nginx < /dev/null || return 1
  docker compose restart nginx < /dev/null || return 1
}

# ---------------------------------------------------------------- manual rollback ----------------------------------------------------
restore_previous() { # restores code + images saved by the last deployment attempt
  # shellcheck disable=SC1090
  [ -f "$STATE" ] && . "$STATE"
  if [ -z "${PREV_BACKEND_SHA:-}" ] && [ -z "${PREV_FRONTEND_SHA:-}" ]; then say "ROLLBACK: no previous state recorded; nothing to restore"; return 1; fi
  [ -n "${PREV_BACKEND_SHA:-}" ] && gitb checkout -q -B "${PREV_BACKEND_BRANCH:-$BACKEND_BRANCH}" "$PREV_BACKEND_SHA"
  [ -n "${PREV_FRONTEND_SHA:-}" ] && gitf checkout -q -B "${PREV_FRONTEND_BRANCH:-$FRONTEND_BRANCH}" "$PREV_FRONTEND_SHA"
  for img in quizora-backend quizora-frontend; do
    docker image inspect "$img:rollback" > /dev/null 2>&1 && docker tag "$img:rollback" "$img:latest"
  done
  recreate_all || return 1
  wait_healthy
}

if [ "$ROLLBACK_ONLY" -eq 1 ]; then
  say "MANUAL ROLLBACK requested"
  if restore_previous; then say "MANUAL ROLLBACK ok: previous version is serving and healthy"; exit 0; fi
  say "MANUAL ROLLBACK FAILED: check 'docker compose ps' and 'docker compose logs'"; exit 2
fi

# ---------------------------------------------------------------- 1. what changed? -----------------------------------------------------
fetch_target() { # <git-func> <branch> -> prints target sha
  "$1" fetch --quiet origin "+refs/heads/$2:refs/remotes/origin/$2" 2> /dev/null && "$1" rev-parse "refs/remotes/origin/$2"
}
B_CUR="$(gitb rev-parse HEAD 2> /dev/null)"; F_CUR="$(gitf rev-parse HEAD 2> /dev/null)"
B_CUR_BRANCH="$(gitb branch --show-current)"; F_CUR_BRANCH="$(gitf branch --show-current)"
B_NEW="$(fetch_target gitb "$BACKEND_BRANCH")"; F_NEW="$(fetch_target gitf "$FRONTEND_BRANCH")"
[ -n "$B_NEW" ] && [ -n "$F_NEW" ] || { say "ABORT: cannot fetch branch '$BACKEND_BRANCH' (backend) or '$FRONTEND_BRANCH' (frontend) from GitHub"; exit 1; }

B_CHANGED=0; F_CHANGED=0
{ [ "$B_CUR" != "$B_NEW" ] || [ "$B_CUR_BRANCH" != "$BACKEND_BRANCH" ]; } && B_CHANGED=1
{ [ "$F_CUR" != "$F_NEW" ] || [ "$F_CUR_BRANCH" != "$FRONTEND_BRANCH" ]; } && F_CHANGED=1
if [ "$B_CHANGED" -eq 0 ] && [ "$F_CHANGED" -eq 0 ] && [ "$FORCE" -eq 0 ]; then
  quiet "up to date: backend ${B_CUR:0:7} ($BACKEND_BRANCH), frontend ${F_CUR:0:7} ($FRONTEND_BRANCH)"
  exit 0
fi
say "CHANGE DETECTED: backend ${B_CUR:0:7}($B_CUR_BRANCH) -> ${B_NEW:0:7}($BACKEND_BRANCH) | frontend ${F_CUR:0:7}($F_CUR_BRANCH) -> ${F_NEW:0:7}($FRONTEND_BRANCH)$([ "$FORCE" -eq 1 ] && echo ' [forced]')"

# ---------------------------------------------------------------- 2. preflight ---------------------------------------------------------
refuse() { say "REFUSED: $*"; exit 1; }
[ -z "$(gitb status --porcelain)" ] || refuse "backend working tree has local changes ($(gitb status --porcelain | wc -l) file(s)); commit or discard them first"
[ -z "$(gitf status --porcelain)" ] || refuse "frontend working tree has local changes ($(gitf status --porcelain | wc -l) file(s)); commit or discard them first"
if [ "$B_CHANGED" -eq 1 ]; then gitb merge-base --is-ancestor "$B_CUR" "$B_NEW" || refuse "backend: ${B_NEW:0:7} does not descend from the running ${B_CUR:0:7} (not a fast-forward)"; fi
if [ "$F_CHANGED" -eq 1 ]; then gitf merge-base --is-ancestor "$F_CUR" "$F_NEW" || refuse "frontend: ${F_NEW:0:7} does not descend from the running ${F_CUR:0:7} (not a fast-forward)"; fi
FREE_MB="$(df -m --output=avail / | tail -1 | tr -d ' ')"
if [ "$FREE_MB" -lt "$MIN_FREE_MB" ]; then
  say "low disk (${FREE_MB} MB free); pruning dangling images and old build cache"
  docker image prune -f > /dev/null 2>&1; docker builder prune -f --filter until=72h > /dev/null 2>&1
  FREE_MB="$(df -m --output=avail / | tail -1 | tr -d ' ')"
  [ "$FREE_MB" -ge "$MIN_FREE_MB" ] || refuse "only ${FREE_MB} MB free after cleanup (need ${MIN_FREE_MB} MB)"
fi
if [ "$SKIP_DB" -eq 0 ]; then
  [ "$(http_code "$HEALTH_URL/health/ready")" = "200" ] || refuse "the application is not healthy now (/health/ready is not 200: database stopped or unreachable?). Fix that first, or use --skip-db-check"
fi

# ---------------------------------------------------------------- 3. CI gate -----------------------------------------------------------
gate() { # <repo> <sha>
  [ "$SKIP_CI" -eq 1 ] || [ "$REQUIRE_CI" != "true" ] && { say "CI gate skipped for $1 (--skip-ci or REQUIRE_CI=false)"; return 0; }
  local out code
  out="$(python3 "$GATE" "$OWNER" "$1" "$2" 2>&1)"; code=$?
  say "CI gate: $out"
  return "$code"
}
GATE_CODE=0
if [ "$B_CHANGED" -eq 1 ] || [ "$FORCE" -eq 1 ]; then gate "$BACKEND_REPO" "$B_NEW"; c=$?; [ "$c" -ne 0 ] && GATE_CODE=$c; fi
if [ "$GATE_CODE" -eq 0 ] && { [ "$F_CHANGED" -eq 1 ] || [ "$FORCE" -eq 1 ]; }; then gate "$FRONTEND_REPO" "$F_NEW"; c=$?; [ "$c" -ne 0 ] && GATE_CODE=$c; fi
if [ "$GATE_CODE" -ne 0 ]; then
  [ "$GATE_CODE" -eq 3 ] && { say "NOT DEPLOYED: CI is not finished yet; will retry"; exit 3; }
  say "NOT DEPLOYED: the CI gate did not pass (code $GATE_CODE)"; exit 1
fi
if [ "$DRY" -eq 1 ]; then say "DRY RUN: all checks passed; a real run would now build, migrate, deploy and health-check"; exit 0; fi

# ---------------------------------------------------------------- 4. save rollback point, move code, build -------------------------------
cat > "$STATE" << EOF
PREV_BACKEND_SHA=$B_CUR
PREV_BACKEND_BRANCH=$B_CUR_BRANCH
PREV_FRONTEND_SHA=$F_CUR
PREV_FRONTEND_BRANCH=$F_CUR_BRANCH
ATTEMPT_AT=$(date -u +%FT%TZ)
EOF
for img in quizora-backend quizora-frontend; do
  docker image inspect "$img:latest" > /dev/null 2>&1 && docker tag "$img:latest" "$img:rollback"
done

do_rollback() { # <reason>
  say "FAILED: $1 -- rolling back to the previous version"
  local after_migrate="${2:-}"
  if restore_previous; then
    say "ROLLED BACK: previous version (backend ${B_CUR:0:7}, frontend ${F_CUR:0:7}) is serving and healthy"
    [ -n "$after_migrate" ] && say "NOTE: the new database migration HAD already been applied; it is not undone (migrations are forward-only)"
    exit 1
  fi
  say "ROLLBACK FAILED: manual intervention needed (docker compose ps; docker compose logs). Run: quizora-deploy --rollback"
  exit 2
}

if [ "$B_CHANGED" -eq 1 ]; then gitb checkout -q -B "$BACKEND_BRANCH" "$B_NEW" || refuse "could not switch the backend to $BACKEND_BRANCH"; fi
if [ "$F_CHANGED" -eq 1 ]; then gitf checkout -q -B "$FRONTEND_BRANCH" "$F_NEW" || { [ "$B_CHANGED" -eq 1 ] && gitb checkout -q -B "$B_CUR_BRANCH" "$B_CUR"; refuse "could not switch the frontend to $FRONTEND_BRANCH"; }; fi

say "BUILD: backend ${B_NEW:0:7}, frontend ${F_NEW:0:7} (output: $LAST)"
BUILD_TARGETS=()
{ [ "$B_CHANGED" -eq 1 ] || [ "$FORCE" -eq 1 ]; } && BUILD_TARGETS+=(backend migrate)
{ [ "$F_CHANGED" -eq 1 ] || [ "$FORCE" -eq 1 ]; } && BUILD_TARGETS+=(frontend)
if ! docker compose build "${BUILD_TARGETS[@]}" < /dev/null > "$LAST" 2>&1; then
  say "build output (last lines): $(tail -3 "$LAST" | tr '\n' ' ' | cut -c1-300)"
  do_rollback "image build failed"
fi

# ---------------------------------------------------------------- 5. migrate BEFORE swapping containers --------------------------------
if [ "$B_CHANGED" -eq 1 ] || [ "$FORCE" -eq 1 ]; then
  say "MIGRATE: running prisma migrate deploy with the new image"
  if ! docker compose run --rm --no-deps migrate < /dev/null > "$LAST.migrate" 2>&1; then
    say "migration output (last lines): $(tail -4 "$LAST.migrate" | tr '\n' ' ' | cut -c1-300)"
    do_rollback "database migration failed (the running containers were not touched)"
  fi
  say "MIGRATE: ok ($(grep -E 'No pending migrations|successfully applied' "$LAST.migrate" | head -1 | cut -c1-80))"
fi

# ---------------------------------------------------------------- 6. swap + verify ------------------------------------------------------
say "DEPLOY: recreating containers"
recreate_all || do_rollback "could not recreate the containers" after_migrate
if ! wait_healthy; then
  say "health check failed after ${HEALTH_TIMEOUT}s: backend=$(health_of backend) frontend=$(health_of frontend) ready=$(http_code "$HEALTH_URL/health/ready") login=$(http_code "$HEALTH_URL/login")"
  do_rollback "the new version did not become healthy" after_migrate
fi

cat > "$STATE" << EOF
BACKEND_SHA=$B_NEW
BACKEND_BRANCH=$BACKEND_BRANCH
FRONTEND_SHA=$F_NEW
FRONTEND_BRANCH=$FRONTEND_BRANCH
DEPLOYED_AT=$(date -u +%FT%TZ)
PREV_BACKEND_SHA=$B_CUR
PREV_BACKEND_BRANCH=$B_CUR_BRANCH
PREV_FRONTEND_SHA=$F_CUR
PREV_FRONTEND_BRANCH=$F_CUR_BRANCH
EOF
docker image prune -f > /dev/null 2>&1
say "SUCCESS: backend ${B_NEW:0:7} ($BACKEND_BRANCH) and frontend ${F_NEW:0:7} ($FRONTEND_BRANCH) are deployed and healthy"
exit 0
