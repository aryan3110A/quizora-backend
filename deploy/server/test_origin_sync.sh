#!/bin/bash
# Tests quizora-origin-sync.sh without AWS: a fake `curl` plays the EC2 metadata service. Run: bash test_origin_sync.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
cat > "$T/bin/curl" << 'FAKE'
#!/bin/bash
# fake IMDSv2: token request, then the public-ipv4 lookup (FAKE_IP empty => metadata unavailable)
args="$*"
if [[ "$args" == *"api/token"* ]]; then [ -n "${FAKE_IP:-}" ] && echo "tok" && exit 0; exit 7; fi
if [[ "$args" == *"public-ipv4"* ]]; then [ -n "${FAKE_IP:-}" ] && echo "$FAKE_IP" && exit 0; exit 7; fi
exit 7
FAKE
chmod +x "$T/bin/curl"
printf '#!/bin/sh\nexit 0\n' > "$T/bin/logger"; chmod +x "$T/bin/logger"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok   $1"; else fail=$((fail+1)); echo "  FAIL $1: expected [$3] got [$2]"; fi; }
run() { PATH="$T/bin:$PATH" QUIZORA_ENV_FILE="$T/env" QUIZORA_RETRY_SLEEP=0 FAKE_IP="$1" bash "$HERE/quizora-origin-sync.sh" > "$T/out.txt" 2>&1; echo $?; }
val() { grep -E '^FRONTEND_ORIGIN=' "$T/env" | head -1 | cut -d= -f2-; }
fresh() { printf 'NODE_ENV=production\nFRONTEND_ORIGIN=%s\nDATABASE_URL=postgresql://u:p%%40ss@h/db\nSESSION_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nTRUST_PROXY_HOPS=1\n' "$1" > "$T/env"; chmod 600 "$T/env"; }

echo "1. stale IP is replaced with the current one"
fresh "http://3.87.12.201"; check "exit code" "$(run 54.165.73.119)" 0; check "origin updated" "$(val)" "http://54.165.73.119"
echo "2. every other line (secrets) is untouched, and the file stays mode 600"
check "line count" "$(wc -l < "$T/env" | tr -d ' ')" 5; check "database url intact" "$(grep ^DATABASE_URL= "$T/env")" "DATABASE_URL=postgresql://u:p%40ss@h/db"; check "secret intact" "$(grep -c ^SESSION_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$T/env")" 1; check "mode" "$(stat -c %a "$T/env")" 600
echo "3. already correct -> unchanged, reports so"
fresh "http://54.165.73.119"; run 54.165.73.119 > /dev/null; check "origin" "$(val)" "http://54.165.73.119"; check "message" "$(grep -c 'nothing to change' "$T/out.txt")" 1
echo "4. https scheme is preserved"
fresh "https://3.87.12.201"; run 10.1.2.3 > /dev/null; check "origin" "$(val)" "https://10.1.2.3"
echo "5. a DNS name is never overwritten"
fresh "https://quizora.example.edu"; run 54.165.73.119 > /dev/null; check "origin" "$(val)" "https://quizora.example.edu"
echo "6. missing key is added"
printf 'NODE_ENV=production\n' > "$T/env"; chmod 600 "$T/env"; run 54.165.73.119 > /dev/null; check "origin" "$(val)" "http://54.165.73.119"
echo "7. no metadata service -> file unchanged, exit 0, no crash"
fresh "http://3.87.12.201"; check "exit code" "$(run "")" 0; check "origin unchanged" "$(val)" "http://3.87.12.201"
echo "8. garbage from the metadata service is not written"
fresh "http://3.87.12.201"; run 'not-an-ip; rm -rf /' > /dev/null; check "origin unchanged" "$(val)" "http://3.87.12.201"
echo "9. missing env file -> clean exit"
rm -f "$T/env"; check "exit code" "$(run 1.2.3.4)" 0
echo "10. the .env contents never appear in the output"
fresh "http://3.87.12.201"; run 54.165.73.119 > /dev/null; check "secret in output" "$(grep -c 'aaaaaaaa\|p%40ss' "$T/out.txt")" 0
echo; echo "passed: $pass  failed: $fail"; [ "$fail" -eq 0 ]
