#!/usr/bin/env python3
"""
ci_gate: "did GitHub Actions pass for this exact commit?"  (Python standard library only; runs on the server before every deployment)

usage:  ci_gate.py OWNER REPO COMMIT_SHA        (optional env GITHUB_TOKEN raises the API rate limit; public repositories need none)

exit code   meaning
   0        every check run on the commit finished and succeeded (skipped/neutral count as fine)  -> deploy may proceed
   2        at least one check run failed / was cancelled                                         -> do NOT deploy
   3        no check runs yet, or some are still running                                          -> not ready, try again later
   4        GitHub could not be asked (network, rate limit, HTTP error)                           -> do NOT deploy (fail closed)

Fail-closed on purpose: whenever the answer is unknown the deployment does not happen.
"""
import json
import os
import sys
import urllib.error
import urllib.request

OK_CONCLUSIONS = {"success", "skipped", "neutral"}


def evaluate(payload):
    """payload = decoded JSON of GET /repos/{o}/{r}/commits/{sha}/check-runs -> (exit_code, message)."""
    runs = payload.get("check_runs") or []
    if not runs:
        return 3, "no CI check runs found for this commit yet"
    pending = [r.get("name", "?") for r in runs if r.get("status") != "completed"]
    failed = [f'{r.get("name", "?")}={r.get("conclusion")}' for r in runs
              if r.get("status") == "completed" and r.get("conclusion") not in OK_CONCLUSIONS]
    if failed:  # a failure wins even while other jobs are still running
        return 2, "CI failed: " + ", ".join(failed)
    if pending:
        return 3, "CI still running: " + ", ".join(pending)
    return 0, f"CI passed ({len(runs)} check run{'s' if len(runs) != 1 else ''})"


def fetch(owner, repo, sha, opener=urllib.request.urlopen):
    url = f"https://api.github.com/repos/{owner}/{repo}/commits/{sha}/check-runs?per_page=100"
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "quizora-deploy-gate", "X-GitHub-Api-Version": "2022-11-28"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with opener(urllib.request.Request(url, headers=headers), timeout=20) as response:
        return json.load(response)


def main(argv, opener=urllib.request.urlopen):
    if len(argv) != 4 or not all(argv[1:]):
        print("usage: ci_gate.py OWNER REPO COMMIT_SHA", file=sys.stderr)
        return 4
    owner, repo, sha = argv[1:]
    if not (sha.isalnum() and 7 <= len(sha) <= 64):  # never put an unchecked string in a URL
        print("refusing: that does not look like a commit SHA", file=sys.stderr)
        return 4
    try:
        code, message = evaluate(fetch(owner, repo, sha, opener))
    except urllib.error.HTTPError as exc:
        code, message = 4, f"GitHub answered HTTP {exc.code} ({'rate limited?' if exc.code in (403, 429) else 'error'})"
    except Exception as exc:  # DNS, timeout, bad JSON ...
        code, message = 4, f"cannot ask GitHub: {type(exc).__name__}"
    print(f"{owner}/{repo}@{sha[:7]}: {message}")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
