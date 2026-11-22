#!/bin/bash
# Installs / updates the Quizora server tooling on the EC2 instance. Run as root from the folder that contains this file:
#     sudo bash deploy/server/install.sh
# Safe to run repeatedly. It never touches .env, never restarts containers and never runs a deployment.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${QUIZORA_DIR:-/home/ubuntu/quizora}"

install -d -m 755 /usr/local/lib/quizora
install -m 755 "$DIR/quizora-deploy.sh" /usr/local/bin/quizora-deploy
install -m 755 "$DIR/quizora-origin-sync.sh" /usr/local/bin/quizora-origin-sync
install -m 644 "$DIR/ci_gate.py" /usr/local/lib/quizora/ci_gate.py
for unit in quizora-origin-sync.service quizora-deploy.service quizora-deploy.timer; do
  install -m 644 "$DIR/$unit" "/etc/systemd/system/$unit"
done

# compose file + nginx config: keep a timestamped backup of whatever is there if it differs
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
place() { # <source> <destination>
  if [ -f "$2" ] && ! cmp -s "$1" "$2"; then cp -p "$2" "$2.bak.$stamp"; echo "backed up $2 -> $2.bak.$stamp"; fi
  install -D -m 644 -o ubuntu -g ubuntu "$1" "$2"
}
place "$DIR/docker-compose.yml" "$APP_DIR/docker-compose.yml"
place "$DIR/proxy/nginx.conf" "$APP_DIR/proxy/nginx.conf"

# deploy.conf: create once; never overwrite your choices
if [ ! -f "$APP_DIR/deploy.conf" ]; then
  backend_branch="$(sudo -u ubuntu git -C "$APP_DIR/student-quiz-backend" branch --show-current 2> /dev/null || echo main)"
  frontend_branch="$(sudo -u ubuntu git -C "$APP_DIR/student-quiz-frontend" branch --show-current 2> /dev/null || echo main)"
  # awk, not sed: branch names contain "/" (for example ci/aws-deploy), which would break an s/// expression
  awk -v b="${backend_branch:-main}" -v f="${frontend_branch:-main}" '/^BACKEND_BRANCH=/ {print "BACKEND_BRANCH=" b; next} /^FRONTEND_BRANCH=/ {print "FRONTEND_BRANCH=" f; next} {print}' "$DIR/deploy.conf.example" > "$APP_DIR/deploy.conf"
  chown ubuntu:ubuntu "$APP_DIR/deploy.conf"; chmod 644 "$APP_DIR/deploy.conf"
  echo "created $APP_DIR/deploy.conf (branches: backend=$backend_branch frontend=$frontend_branch, AUTO_DEPLOY=false)"
fi

systemctl daemon-reload
systemctl enable quizora-origin-sync.service > /dev/null 2>&1
systemctl enable --now quizora-deploy.timer > /dev/null 2>&1
echo "installed. origin-sync enabled at boot; deploy timer active (acts only when AUTO_DEPLOY=true in $APP_DIR/deploy.conf)."
echo "next: 'cd $APP_DIR && docker compose up -d' applies a changed compose file; 'quizora-deploy --dry-run' shows what a deployment would do."
