#!/bin/bash
# quizora-origin-sync: keep the backend's FRONTEND_ORIGIN equal to THIS instance's current public IPv4 address.
#
# WHY. The backend rejects state-changing requests (save answer, submit, create/publish quiz ...) when the browser's Origin header does not
# equal FRONTEND_ORIGIN (a CSRF protection that we deliberately keep strict). This instance has no Elastic IP, so its public address changes on
# every stop/start, and a hard-coded FRONTEND_ORIGIN then makes every such request fail with 403 BAD_ORIGIN.
#
# HOW. At boot (after Docker is up) this script reads the current public IPv4 from the EC2 metadata service (IMDSv2), rewrites FRONTEND_ORIGIN in
# the .env file if it differs, then RECREATES the containers that read it. Two Docker facts make "just edit .env" insufficient:
#   * env_file values are baked in when a container is CREATED, so the backend and worker must be recreated, not merely restarted;
#   * nginx resolves the `backend` name only when it starts, so it is restarted after the backend gets a new container.
#
# SAFE BY DESIGN: it only ever rewrites an origin that is an IPv4 address (or missing). If you later use a DNS name (a domain or an Elastic IP with
# a name), the value is a hostname and this script leaves it alone. The scheme (http/https) already in .env is preserved. It never prints the .env.
set -u

ENV_FILE="${QUIZORA_ENV_FILE:-/home/ubuntu/quizora/.env}"
APP_DIR="${QUIZORA_DIR:-$(dirname "$ENV_FILE")}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
log() { echo "$*"; command -v logger > /dev/null 2>&1 && logger -t quizora-origin-sync -- "$*"; }

[ -f "$ENV_FILE" ] || { log "env file $ENV_FILE not found; nothing to do"; exit 0; }

# --- current public IPv4 from the instance metadata service (IMDSv2) -------------------------------------------------------------------
IP=""
for _ in 1 2 3 4 5 6; do
  TOKEN="$(curl -sS -m 3 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2> /dev/null)"
  [ -n "$TOKEN" ] && IP="$(curl -sS -m 3 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 2> /dev/null)"
  [[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && break
  IP=""
  sleep "${QUIZORA_RETRY_SLEEP:-5}"
done
[ -n "$IP" ] || { log "no public IPv4 from the metadata service; FRONTEND_ORIGIN left unchanged"; exit 0; }

current="$(grep -E '^FRONTEND_ORIGIN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
scheme="$(echo "$current" | sed -nE 's#^(https?)://.*#\1#p')"
scheme="${scheme:-http}"
host="$(echo "$current" | sed -E 's#^https?://##; s#[/:].*$##')"

# only manage IP-based origins (never overwrite a DNS name someone configured on purpose)
if [ -n "$current" ] && ! [[ "$host" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  log "FRONTEND_ORIGIN uses a DNS name ($host); not managed by this script"
  exit 0
fi

want="$scheme://$IP"
if [ "$current" = "$want" ]; then
  log "FRONTEND_ORIGIN already $want; nothing to change"
  exit 0
fi

# --- atomic rewrite that preserves owner and permissions (the file contains secrets) -------------------------------------------------
tmp="$(mktemp "${ENV_FILE}.XXXXXX")" || exit 1
chmod --reference="$ENV_FILE" "$tmp"
chown --reference="$ENV_FILE" "$tmp"
if grep -q '^FRONTEND_ORIGIN=' "$ENV_FILE"; then
  sed -E "s#^FRONTEND_ORIGIN=.*#FRONTEND_ORIGIN=${want}#" "$ENV_FILE" > "$tmp"
else
  { cat "$ENV_FILE"; echo "FRONTEND_ORIGIN=${want}"; } > "$tmp"
fi
mv "$tmp" "$ENV_FILE"
log "FRONTEND_ORIGIN: ${current:-<unset>} -> ${want}"

# --- recreate what reads it ---------------------------------------------------------------------------------------------------------
if [ "$APPLY" -eq 1 ]; then
  cd "$APP_DIR" || exit 1
  RUN="sudo -u ubuntu"
  [ "$(id -un)" = "ubuntu" ] && RUN=""
  # --no-deps: do NOT touch the one-shot `migrate` service. A changed .env makes Compose think it changed too, which would re-run the database
  # migration (and fail whenever the database is stopped).
  # No `--wait`: the worker has its healthcheck disabled on purpose and Compose rejects --wait for such a service; we poll the backend instead.
  if $RUN docker compose up -d --no-deps --force-recreate backend worker < /dev/null; then
    healthy=""
    for _ in $(seq 1 45); do
      cid="$($RUN docker compose ps -q backend < /dev/null)"
      state="$([ -n "$cid" ] && $RUN docker inspect -f '{{.State.Health.Status}}' "$cid" 2> /dev/null)"
      [ "$state" = "healthy" ] && { healthy=yes; break; }
      sleep "${QUIZORA_RETRY_SLEEP:-2}"
    done
    $RUN docker compose restart nginx < /dev/null
    if [ -n "$healthy" ]; then
      log "backend and worker recreated (backend healthy), nginx restarted"
    else
      log "WARNING: backend not healthy after recreate; nginx restarted anyway. Check 'docker compose logs backend'"
      exit 1
    fi
  else
    log "WARNING: recreating backend/worker failed; check 'docker compose ps' and 'docker compose logs backend'"
    exit 1
  fi
fi
exit 0
