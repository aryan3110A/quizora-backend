#!/bin/bash
# Tests quizora-deploy.sh end to end WITHOUT Docker, GitHub or AWS: real git (local bare repositories play GitHub), stubbed docker / curl / CI gate.
# Every decision path is covered: nothing-to-do, CI pending/failed, dirty tree, non-fast-forward, unhealthy database, build failure,
# migration failure (containers must NOT be touched), unhealthy new version (automatic rollback), success, dry-run, manual rollback, locking.
#   docker run --rm -v "<repo>/deploy:/mnt:ro" ubuntu:24.04 bash /mnt/server/test_deploy.sh
set -u
if [ "$(id -u)" -eq 0 ]; then   # one-time setup as root, then re-run this very script as an unprivileged user (the real script re-execs as `ubuntu` for root)
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq > /dev/null && apt-get install -y -qq git python3 util-linux > /dev/null 2>&1
  id tester > /dev/null 2>&1 || useradd -m tester
  rm -rf /tmp/qz && mkdir -p /tmp/qz && cp -r /mnt/server /tmp/qz/server && chown -R tester:tester /tmp/qz
  exec su -s /bin/bash tester -c "bash /tmp/qz/server/test_deploy.sh"
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME"
git config --global user.name tester; git config --global user.email t@t; git config --global init.defaultBranch main; git config --global protocol.file.allow always
APP="$T/app"; ORIGIN="$T/origin"; BIN="$T/bin"; mkdir -p "$APP" "$ORIGIN" "$BIN"
CALLS="$T/calls.log"; : > "$CALLS"

# ---- fake GitHub: bare repos with a main branch ----
mk_repo() { # <name>
  git init -q --bare "$ORIGIN/$1.git"
  git clone -q "$ORIGIN/$1.git" "$T/seed_$1" 2> /dev/null
  ( cd "$T/seed_$1" && echo "v1" > app.txt && git add -A && git commit -q -m "v1" && git push -q origin HEAD:main )
  git clone -q "$ORIGIN/$1.git" "$APP/$2"
}
mk_repo be student-quiz-backend; mk_repo fe student-quiz-frontend
push_commit() { ( cd "$T/seed_$1" && echo "$2" >> app.txt && git add -A && git commit -q -m "$2" && git push -q origin HEAD:"${3:-main}" ); }

# ---- stubs ----
cat > "$BIN/docker" << 'STUB'
#!/bin/bash
echo "docker $*" >> "$CALLS"
case "$1 $2" in
  "compose build") exit "${BUILD_RC:-0}" ;;
  "compose run") exit "${MIGRATE_RC:-0}" ;;
  "compose ps") echo "cid-$4"; exit 0 ;;
  "compose up") touch "$T/recreated"; exit 0 ;;
  "compose restart") exit 0 ;;
esac
case "$1" in
  tag) [ "$2" = "quizora-backend:rollback" ] && touch "$T/rolled_back"; exit 0 ;;
  image) exit 0 ;;
  builder) exit 0 ;;
  inspect) # health of the backend/frontend container: the "new version" is unhealthy until the rollback tag has been restored
    if [ "${NEW_UNHEALTHY:-0}" = "1" ] && [ -f "$T/recreated" ] && [ ! -f "$T/rolled_back" ]; then echo unhealthy; else echo healthy; fi; exit 0 ;;
esac
exit 0
STUB
cat > "$BIN/curl" << 'STUB'
#!/bin/bash
url="${*: -1}"
case "$url" in
  */health/ready) if [ "${DB_DOWN:-0}" = "1" ]; then printf 503; elif [ "${NEW_UNHEALTHY:-0}" = "1" ] && [ -f "$T/recreated" ] && [ ! -f "$T/rolled_back" ]; then printf 503; else printf 200; fi ;;
  *) printf 200 ;;
esac
STUB
chmod +x "$BIN/docker" "$BIN/curl"
cat > "$T/gate.py" << 'STUB'
import os, sys
print("fake gate answer for", " ".join(sys.argv[1:]))
sys.exit(int(os.environ.get("GATE_RC", "0")))
STUB

export T CALLS PATH="$BIN:$PATH"
export QUIZORA_DIR="$APP" QUIZORA_DEPLOY_CONF="$T/deploy.conf" QUIZORA_GATE="$T/gate.py" QUIZORA_POLL_SECONDS=1 MIN_FREE_MB=1
printf 'BACKEND_BRANCH=main\nFRONTEND_BRANCH=main\nAUTO_DEPLOY=true\nREQUIRE_CI=true\nHEALTH_TIMEOUT=2\nGITHUB_OWNER=o\n' > "$T/deploy.conf"

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok   $1"; else fail=$((fail+1)); echo "  FAIL $1: expected [$3] got [$2]"; fi; }
deploy() { : > "$CALLS"; rm -f "$T/recreated" "$T/rolled_back"; bash "$HERE/quizora-deploy.sh" "$@" > "$T/out.txt" 2>&1; echo $?; }
calls_with() { grep -c "$1" "$CALLS" | tr -d ' '; }
head_of() { git -C "$APP/$1" rev-parse HEAD; }
origin_head() { git --git-dir="$ORIGIN/$1.git" rev-parse main; }
said() { grep -c "$1" "$T/out.txt" | tr -d ' '; }
sync_state() { : > "$APP/.deploy-state"; }

echo "1. nothing changed -> silent in --auto mode, no docker calls"
check "exit" "$(deploy --auto)" 0; check "no docker calls" "$(wc -l < "$CALLS" | tr -d ' ')" 0; check "no output in --auto mode" "$(wc -c < "$T/out.txt" | tr -d ' ')" 0

echo "2. --auto does nothing unless AUTO_DEPLOY=true"
push_commit be "change-2"; sed -i 's/AUTO_DEPLOY=true/AUTO_DEPLOY=false/' "$T/deploy.conf"
check "exit" "$(deploy --auto)" 0; check "no docker calls" "$(wc -l < "$CALLS" | tr -d ' ')" 0; check "code not moved" "$([ "$(head_of student-quiz-backend)" != "$(origin_head be)" ] && echo yes)" yes
sed -i 's/AUTO_DEPLOY=false/AUTO_DEPLOY=true/' "$T/deploy.conf"

echo "3. CI still running (gate exit 3) -> exit 3, nothing built, code not moved"
GATE_RC=3 check "exit code 3" "$(GATE_RC=3 deploy)" 3; check "no build" "$(calls_with 'compose build')" 0; check "code not moved" "$([ "$(head_of student-quiz-backend)" != "$(origin_head be)" ] && echo yes)" yes

echo "4. CI failed (gate exit 2) -> refused, nothing built"
check "exit code 1" "$(GATE_RC=2 deploy)" 1; check "no build" "$(calls_with 'compose build')" 0; check "says gate failed" "$(said 'NOT DEPLOYED: the CI gate did not pass')" 1

echo "5. CI unreachable (gate exit 4) -> fail closed"
check "exit code 1" "$(GATE_RC=4 deploy)" 1; check "no build" "$(calls_with 'compose build')" 0

echo "6. application not healthy now (database down) -> refuse to roll out on a broken system"
check "exit code 1" "$(DB_DOWN=1 deploy)" 1; check "refused" "$(said 'REFUSED: the application is not healthy now')" 1; check "no build" "$(calls_with 'compose build')" 0

echo "7. local changes in a working tree -> refused"
echo dirty >> "$APP/student-quiz-backend/app.txt"
check "exit code 1" "$(deploy)" 1; check "refused" "$(said 'REFUSED: backend working tree has local changes')" 1; check "no build" "$(calls_with 'compose build')" 0
git -C "$APP/student-quiz-backend" checkout -q -- app.txt

echo "8. someone committed on the server and upstream moved on (not a fast-forward) -> refused"
git -C "$APP/student-quiz-backend" commit -q --allow-empty -m "server-only commit"
push_commit be "upstream-8"
check "exit code 1" "$(deploy)" 1; check "refused" "$(said 'not a fast-forward')" 1; check "no build" "$(calls_with 'compose build')" 0
# re-align the local clone with upstream for the next scenarios
git -C "$APP/student-quiz-backend" fetch -q origin && git -C "$APP/student-quiz-backend" reset -q --hard origin/main

echo "9. image build fails -> rolled back, code restored"
push_commit be "change-9"; PRE="$(head_of student-quiz-backend)"
check "exit code 1" "$(BUILD_RC=1 deploy)" 1; check "says rolled back" "$(said 'ROLLED BACK')" 1; check "backend code restored to the previous commit" "$(head_of student-quiz-backend)" "$PRE"; check "migration never ran" "$(calls_with 'compose run')" 0

echo "10. migration fails -> running containers are NEVER touched, code restored"
check "exit code 1" "$(MIGRATE_RC=1 deploy)" 1; check "migration attempted" "$(calls_with 'compose run')" 1; check "NO container recreate (compose up) was issued before the rollback restore" "$(awk '/compose run/{f=1} f&&/compose up/{c++} END{print c+0}' "$CALLS")" 1; check "code restored" "$(head_of student-quiz-backend)" "$PRE"; check "reason logged" "$(said 'database migration failed (the running containers were not touched)')" 1

echo "11. new version unhealthy after the swap -> automatic rollback to the previous images"
check "exit code 1" "$(NEW_UNHEALTHY=1 deploy)" 1; check "retagged the rollback image to latest" "$(calls_with 'tag quizora-backend:rollback quizora-backend:latest')" 1; check "says rolled back and healthy" "$(said 'ROLLED BACK: previous version')" 1; check "mentions migration is not undone" "$(said 'migrations are forward-only')" 1; check "code restored" "$(head_of student-quiz-backend)" "$PRE"

echo "12. dry run: all checks, no changes"
check "exit code 0" "$(deploy --dry-run)" 0; check "no build" "$(calls_with 'compose build')" 0; check "code not moved" "$(head_of student-quiz-backend)" "$PRE"; check "says dry run" "$(said 'DRY RUN')" 1

echo "13. success: build, migrate, swap, healthy -> state recorded, code moved"
NEW="$(origin_head be)"
check "exit code 0" "$(deploy)" 0; check "backend code is now the new commit" "$(head_of student-quiz-backend)" "$NEW"; check "built backend+migrate only (frontend unchanged)" "$(calls_with 'compose build backend migrate')" 1; check "migration ran before the swap" "$(awk '/compose run/{r=NR} /compose up/{u=NR} END{print (r>0 && u>r)?"yes":"no"}' "$CALLS")" yes; check "nginx restarted" "$(calls_with 'compose restart nginx')" 1; check "state file has the new sha" "$(grep -c "^BACKEND_SHA=$NEW" "$APP/.deploy-state")" 1; check "previous sha remembered for rollback" "$(grep -c "^PREV_BACKEND_SHA=$PRE" "$APP/.deploy-state")" 1; check "says SUCCESS" "$(said 'SUCCESS')" 1

echo "14. up to date again -> no work"
check "exit code 0" "$(deploy --auto)" 0; check "no build" "$(calls_with 'compose build')" 0

echo "15. manual rollback restores the previous commit and images"
check "exit code 0" "$(deploy --rollback)" 0; check "backend back on the previous commit" "$(head_of student-quiz-backend)" "$PRE"; check "rollback image retagged" "$(calls_with 'tag quizora-backend:rollback quizora-backend:latest')" 1; check "confirmed" "$(said 'MANUAL ROLLBACK ok')" 1

echo "16. --skip-ci bypasses the gate and says so"
push_commit be "change-16"; check "exit code 0" "$(GATE_RC=2 deploy --skip-ci)" 0; check "logged that CI was skipped (only the backend changed)" "$(said 'CI gate skipped')" 1

echo "17. another deployment running -> exits without touching anything"
( exec 8> "$APP/.deploy.lock"; flock -n 8; push_commit be "change-17"; check "exit code 0 while locked" "$(deploy)" 0; check "no docker calls" "$(wc -l < "$CALLS" | tr -d ' ')" 0; check "says so" "$(said 'another deployment is running')" 1 )

echo "18. branch switch to a descendant branch works (as when production moves from a feature branch to main)"
git --git-dir="$ORIGIN/be.git" branch -q prod "$(origin_head be)"; sed -i 's/^BACKEND_BRANCH=.*/BACKEND_BRANCH=prod/' "$T/deploy.conf"
check "exit code 0" "$(deploy)" 0; check "backend now on branch prod" "$(git -C "$APP/student-quiz-backend" branch --show-current)" prod

echo; echo "passed: $pass  failed: $fail"; [ "$fail" -eq 0 ]
