#!/bin/bash
# Tests install.sh in a throw-away Ubuntu container with a FAKE app directory and a stub systemctl (nothing real is touched).
#   docker run --rm -v "<repo>/deploy:/mnt:ro" ubuntu:24.04 bash /mnt/server/test_install.sh
set -u
export DEBIAN_FRONTEND=noninteractive
if ! command -v git > /dev/null || ! command -v sudo > /dev/null; then
  apt-get update -qq > /dev/null && apt-get install -y -qq git sudo > /dev/null
fi
id ubuntu > /dev/null 2>&1 || useradd -m ubuntu
cp -r /mnt /tmp/d
APP=/tmp/app; mkdir -p "$APP/student-quiz-backend" "$APP/student-quiz-frontend"; chown -R ubuntu:ubuntu "$APP"
for r in student-quiz-backend student-quiz-frontend; do
  sudo -u ubuntu bash -c "cd $APP/$r && git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init"
done
sudo -u ubuntu git -C "$APP/student-quiz-backend" checkout -q -b ci/aws-deploy      # a branch name with a slash
printf '#!/bin/sh\necho "[fake systemctl] $*" >> /tmp/systemctl.log\n' > /usr/local/bin/systemctl; chmod +x /usr/local/bin/systemctl
printf 'old compose\n' > "$APP/docker-compose.yml"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok   $1"; else fail=$((fail+1)); echo "  FAIL $1: expected [$3] got [$2]"; fi; }
QUIZORA_DIR="$APP" bash /tmp/d/server/install.sh > /tmp/install.out 2>&1; check "installer exit code" "$?" 0
check "deploy.conf backend branch keeps the slash" "$(grep ^BACKEND_BRANCH= "$APP/deploy.conf")" "BACKEND_BRANCH=ci/aws-deploy"
check "deploy.conf frontend branch" "$(grep ^FRONTEND_BRANCH= "$APP/deploy.conf" | sed 's/master/main/')" "FRONTEND_BRANCH=$(sudo -u ubuntu git -C "$APP/student-quiz-frontend" branch --show-current | sed 's/master/main/')"
check "auto deploy is OFF by default" "$(grep ^AUTO_DEPLOY= "$APP/deploy.conf")" "AUTO_DEPLOY=false"
check "CI gate required by default" "$(grep ^REQUIRE_CI= "$APP/deploy.conf")" "REQUIRE_CI=true"
check "deploy script installed and executable" "$([ -x /usr/local/bin/quizora-deploy ] && echo yes)" yes
check "gate script installed" "$([ -f /usr/local/lib/quizora/ci_gate.py ] && echo yes)" yes
backups() { find "$APP" -maxdepth 1 -name 'docker-compose.yml.bak.*' | wc -l | tr -d ' '; }
check "old compose backed up" "$(backups)" 1
check "new compose in place" "$(grep -c 'quizora-backend:latest' "$APP/docker-compose.yml" | tr -d ' ')" 2
check "nginx config in place" "$([ -f "$APP/proxy/nginx.conf" ] && echo yes)" yes
check "timer enabled+started" "$(grep -c 'enable --now quizora-deploy.timer' /tmp/systemctl.log)" 1
check "origin-sync enabled" "$(grep -c 'enable quizora-origin-sync.service' /tmp/systemctl.log)" 1
echo "-- second run: must not overwrite the user's deploy.conf, and must not back up an identical compose again"
sed -i 's/^AUTO_DEPLOY=false/AUTO_DEPLOY=true/' "$APP/deploy.conf"
QUIZORA_DIR="$APP" bash /tmp/d/server/install.sh > /tmp/install2.out 2>&1; check "second run exit code" "$?" 0
check "user's AUTO_DEPLOY=true survived" "$(grep ^AUTO_DEPLOY= "$APP/deploy.conf")" "AUTO_DEPLOY=true"
check "no extra backup of identical compose" "$(backups)" 1
echo; echo "passed: $pass  failed: $fail"; [ "$fail" -eq 0 ]
