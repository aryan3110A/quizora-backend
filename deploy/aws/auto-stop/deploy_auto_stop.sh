#!/bin/bash
# Deploys (or updates) the Quizora auto-stop Lambda and its two EventBridge rules.      Idempotent: safe to run again.
# Creates:  1 Lambda function, 1 CloudWatch log group (7-day retention), 2 EventBridge rules, 2 invoke permissions.  Nothing else.
# Needs: Docker (runs the official AWS CLI image) and AWS credentials in the environment:
#        AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN   (Learner Lab "AWS Details"; never put them in this file)
# The function is created with DRY_RUN=true. To go live later:  see docs/AWS_AUTO_STOP.md ("Switching to live mode").
set -euo pipefail

REGION="us-east-1"
FN="quizora-auto-stop"
INSTANCE_ID="i-0a715bf24dd07d8a0"
DB_ID="quizora-postgres"
IDLE_RULE="quizora-auto-stop-idle-check"      # EventBridge: every 15 minutes
NIGHTLY_RULE="quizora-auto-stop-nightly"      # EventBridge: once a day, 20:30 UTC = 02:00 IST
NIGHTLY_CRON="cron(30 20 * * ? *)"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK_DIR:-$HERE/.build}"              # scratch folder for the zip (git-ignored)
mkdir -p "$WORK"
WORK_WIN="$(cd "$WORK" && { pwd -W 2>/dev/null || pwd; })"

aws() { MSYS_NO_PATHCONV=1 docker run --rm -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN -e AWS_DEFAULT_REGION="$REGION" -e AWS_PAGER= -v "$WORK_WIN:/work" amazon/aws-cli "$@"; }

ACCOUNT="$(aws sts get-caller-identity --query Account --output text | tr -d '\r')"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/LabRole"      # the only role a Learner Lab allows; it trusts lambda.amazonaws.com and events.amazonaws.com
FN_ARN="arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FN}"
echo "account $ACCOUNT, region $REGION, role LabRole"

echo "== packaging (only lambda_function.py goes into the zip, not the tests)"
python - "$HERE/lambda_function.py" "$WORK/auto_stop.zip" << 'PY'
import sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(src, "lambda_function.py")
print("zip written:", dst)
PY

echo "== log group with 7-day retention (otherwise logs are kept, and billed, forever)"
aws logs create-log-group --log-group-name "/aws/lambda/${FN}" --tags Project=quizora 2>&1 | grep -v ResourceAlreadyExistsException || true
aws logs put-retention-policy --log-group-name "/aws/lambda/${FN}" --retention-in-days 7

ENV_VARS="Variables={INSTANCE_ID=${INSTANCE_ID},DB_ID=${DB_ID},DRY_RUN=true,IDLE_MINUTES=60,NET_OUT_THRESHOLD_BYTES=30000,RDS_STOP_DELAY_MINUTES=30}"
if aws lambda get-function --function-name "$FN" > /dev/null 2>&1; then
  echo "== function exists: updating code (configuration, including DRY_RUN, is NOT touched)"
  aws lambda update-function-code --function-name "$FN" --zip-file fileb:///work/auto_stop.zip --query '{State:State,LastUpdate:LastUpdateStatus}' --output json
else
  echo "== creating function (DRY_RUN=true)"
  aws lambda create-function --function-name "$FN" --runtime python3.13 --handler lambda_function.handler --role "$ROLE_ARN" \
    --zip-file fileb:///work/auto_stop.zip --timeout 60 --memory-size 256 --environment "$ENV_VARS" \
    --description "Stops the Quizora EC2 and RDS when idle (EventBridge-triggered). DRY_RUN until switched." \
    --tags Project=quizora --query '{Name:FunctionName,Runtime:Runtime,State:State,Timeout:Timeout,Memory:MemorySize}' --output json
fi
aws lambda wait function-updated-v2 --function-name "$FN"

echo "== EventBridge rules"
aws events put-rule --name "$IDLE_RULE" --schedule-expression "rate(15 minutes)" --state ENABLED \
  --description "Quizora: every 15 min check whether the stack is idle" --tags Key=Project,Value=quizora --query RuleArn --output text
aws events put-rule --name "$NIGHTLY_RULE" --schedule-expression "$NIGHTLY_CRON" --state ENABLED \
  --description "Quizora: nightly hard cap on uptime (02:00 IST)" --tags Key=Project,Value=quizora --query RuleArn --output text

aws events put-targets --rule "$IDLE_RULE" --targets "[{\"Id\":\"auto-stop\",\"Arn\":\"${FN_ARN}\",\"Input\":\"{\\\"trigger\\\":\\\"idle-check\\\"}\"}]" --query FailedEntryCount --output text
aws events put-targets --rule "$NIGHTLY_RULE" --targets "[{\"Id\":\"auto-stop\",\"Arn\":\"${FN_ARN}\",\"Input\":\"{\\\"trigger\\\":\\\"nightly\\\"}\"}]" --query FailedEntryCount --output text

echo "== allow EventBridge to invoke the function (only these two rules)"
for pair in "events-idle-check:${IDLE_RULE}" "events-nightly:${NIGHTLY_RULE}"; do
  sid="${pair%%:*}"; rule="${pair#*:}"
  aws lambda add-permission --function-name "$FN" --statement-id "$sid" --action lambda:InvokeFunction --principal events.amazonaws.com \
    --source-arn "arn:aws:events:${REGION}:${ACCOUNT}:rule/${rule}" --query Statement --output text 2>&1 | grep -v ResourceConflictException | cut -c1-120 || true
done
echo "done."
