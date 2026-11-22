# Quizora deployment tooling

Everything needed to run Quizora on one EC2 instance, deploy it safely, and keep AWS costs down. Nothing here contains a secret.

```
developer pushes  ->  GitHub Actions CI (tests, build, images, deploy-tooling checks)
                          |  (the commit gets a green or red check)
                          v
EC2 timer (every 5 min) -> quizora-deploy:  fetch -> preflight -> CI gate -> build -> migrate -> swap -> health check -> (auto-rollback)
```

| Path | What it is |
|---|---|
| `server/quizora-deploy.sh` | the deployment: runs on the server, deploys only commits whose CI passed, rolls back by itself |
| `server/ci_gate.py` | asks GitHub "did CI pass for this exact commit?" (fail-closed) |
| `server/quizora-origin-sync.sh` + `.service` | at boot, sets `FRONTEND_ORIGIN` to the instance's current public IP and recreates the backend (the IP changes on every stop/start) |
| `server/docker-compose.yml`, `server/proxy/nginx.conf` | the production compose file and reverse proxy (secrets come from `~/quizora/.env`, never from git) |
| `server/quizora-deploy.{service,timer}`, `server/deploy.conf.example`, `server/install.sh` | systemd units, settings and the installer (`sudo bash deploy/server/install.sh`) |
| `aws/auto-stop/` | Lambda + EventBridge that stops idle EC2/RDS (dry-run by default; tag a resource `KeepAliveUntil=<UTC time>` before an exam) |
| `server/test_*.{sh,py}`, `aws/auto-stop/test_auto_stop.py` | the tests CI runs on all of the above |

## Everyday use (on the server)
```bash
quizora-deploy --dry-run          # what would happen now (changes nothing)
quizora-deploy                    # deploy now (same checks as the timer)
quizora-deploy --rollback         # go back to the previous version
tail -f ~/quizora/deploy-history.log
```
Automatic deployment is controlled by `AUTO_DEPLOY=true|false` in `~/quizora/deploy.conf` (non-secret). Production branches are `BACKEND_BRANCH` / `FRONTEND_BRANCH` in the same file.

## Rules the deploy script enforces
* never deploys a commit whose GitHub checks are red, missing, still running, or unknown;
* never rolls out on top of an unhealthy application (for example a stopped database) or over local edits on the server;
* runs the database migration with the new image **before** touching the running containers;
* rolls back code and images automatically if the new version does not become healthy.
**Migrations are forward-only**: a rollback restores the previous code, not the database. Write migrations the previous version can still live with, or snapshot RDS first.
