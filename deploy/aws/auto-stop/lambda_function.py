"""
Quizora auto-stop  (AWS Lambda, Python 3.13, no third-party packages: boto3 is built into the Lambda runtime)

PURPOSE  Save AWS credits by stopping the EC2 instance and the RDS database when nobody is using Quizora.

TRIGGERS (Amazon EventBridge rules, see docs/AWS_AUTO_STOP.md)
  idle-check  every 15 minutes   -> stops the EC2 after 60 idle minutes; stops RDS once EC2 has been off for 30 minutes
  nightly     once a day         -> hard cap: stops EC2 + RDS whatever the traffic (a bot can never keep the stack up for days)
  A third guarantee comes for free: if AWS auto-restarts a stopped RDS after its 7-day limit, the next idle-check stops it again.

SAFETY RULES (every one of them errs towards NOT stopping)
  * DRY_RUN is ON unless the environment variable is exactly "false". In dry-run the function only logs what it WOULD do.
  * An incoming event can only make the function SAFER (dry_run=true). It can never switch live stopping on.
  * It can only ever touch INSTANCE_ID and DB_ID from its own configuration.
  * Missing, stale or too few metrics  -> keep running.   Unreadable tag value -> keep running.
  * Tag AutoStop=disabled, or tag KeepAliveUntil=<future ISO time> on the resource -> never stopped (use it before an exam).
  * A freshly started instance gets a full idle window before it can be stopped; a freshly started database is left alone too.
  * RDS is only stopped when EC2 is not running, so the application never loses its database underneath it.
"""
from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

logger = logging.getLogger()
logger.setLevel(logging.INFO)


# ----------------------------------------------------------------------------------------------------------------------
# configuration
# ----------------------------------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Config:
    instance_id: str
    db_id: str
    dry_run: bool = True
    idle_minutes: int = 60
    min_datapoints: int = 10              # of the ~12 five-minute points in an hour; fewer = "not enough evidence"
    net_out_threshold: float = 30_000     # bytes per 5 min. Idle baseline measured on this server: < 10 KB, scanner bursts up to ~27 KB
    net_in_threshold: float = 1_000_000   # bytes per 5 min. Big inbound = deployment / docker pull in progress
    cpu_threshold: float = 10.0           # percent. Idle baseline measured: ~2 %
    rds_stop_delay_minutes: int = 30      # how long EC2 must have been off (and RDS up) before RDS is stopped
    nightly_min_uptime_minutes: int = 30  # the nightly cap does not cut off someone who just started the server
    max_metric_age_minutes: int = 15      # newest datapoint must be at least this fresh


def _number(env: dict, name: str, default: float) -> float:
    raw = env.get(name)
    if raw in (None, ""):
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def load_config(env: Optional[dict] = None) -> Config:
    env = dict(os.environ if env is None else env)
    return Config(
        instance_id=env["INSTANCE_ID"],
        db_id=env["DB_ID"],
        dry_run=str(env.get("DRY_RUN", "true")).strip().lower() != "false",  # anything but "false" = dry-run
        idle_minutes=int(_number(env, "IDLE_MINUTES", 60)),
        min_datapoints=int(_number(env, "MIN_DATAPOINTS", 10)),
        net_out_threshold=_number(env, "NET_OUT_THRESHOLD_BYTES", 30_000),
        net_in_threshold=_number(env, "NET_IN_THRESHOLD_BYTES", 1_000_000),
        cpu_threshold=_number(env, "CPU_THRESHOLD_PERCENT", 10.0),
        rds_stop_delay_minutes=int(_number(env, "RDS_STOP_DELAY_MINUTES", 30)),
        nightly_min_uptime_minutes=int(_number(env, "NIGHTLY_MIN_UPTIME_MINUTES", 30)),
        max_metric_age_minutes=int(_number(env, "MAX_METRIC_AGE_MINUTES", 15)),
    )


@dataclass(frozen=True)
class Decision:
    resource: str   # "ec2" | "rds"
    action: str     # "stop" | "keep"
    reason: str


# ----------------------------------------------------------------------------------------------------------------------
# pure decision logic (no AWS calls: fully unit-tested)
# ----------------------------------------------------------------------------------------------------------------------
def tags_to_dict(tags: Optional[list]) -> dict:
    return {t["Key"]: t["Value"] for t in (tags or [])}


def parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def keepalive_reason(tags: dict, now: datetime) -> Optional[str]:
    if str(tags.get("AutoStop", "")).strip().lower() == "disabled":
        return "tag AutoStop=disabled"
    until = tags.get("KeepAliveUntil")
    if until:
        try:
            if parse_time(until) > now:
                return f"tag KeepAliveUntil={until} is in the future"
        except ValueError:
            return f"tag KeepAliveUntil={until!r} is unreadable (kept running to be safe)"
    return None


def decide_ec2_idle(cfg: Config, now: datetime, instance: dict, datapoints: list) -> Decision:
    """datapoints: [{"time": datetime, "out": float|None, "in": float|None, "cpu": float|None}, ...] (5-minute points)."""
    state = instance["state"]
    if state != "running":
        return Decision("ec2", "keep", f"instance is {state}")
    reason = keepalive_reason(instance["tags"], now)
    if reason:
        return Decision("ec2", "keep", reason)
    uptime = now - instance["launch_time"]
    if uptime < timedelta(minutes=cfg.idle_minutes):
        return Decision("ec2", "keep", f"started {int(uptime.total_seconds() // 60)} min ago; needs a full {cfg.idle_minutes}-minute idle window")

    window_start = now - timedelta(minutes=cfg.idle_minutes + 5)
    window = sorted((d for d in datapoints if d["time"] >= window_start), key=lambda d: d["time"])
    if len(window) < cfg.min_datapoints:
        return Decision("ec2", "keep", f"only {len(window)} metric datapoints (need {cfg.min_datapoints}): not enough evidence of idleness")
    newest_age = now - window[-1]["time"]
    if newest_age > timedelta(minutes=cfg.max_metric_age_minutes):
        return Decision("ec2", "keep", f"newest metric is {int(newest_age.total_seconds() // 60)} min old: metrics look stale")

    for point in window:
        stamp = point["time"].strftime("%H:%M")
        if point.get("out") is not None and point["out"] >= cfg.net_out_threshold:
            return Decision("ec2", "keep", f"activity at {stamp} UTC: NetworkOut {int(point['out'])} B >= {int(cfg.net_out_threshold)} B per 5 min")
        if point.get("in") is not None and point["in"] >= cfg.net_in_threshold:
            return Decision("ec2", "keep", f"activity at {stamp} UTC: NetworkIn {int(point['in'])} B >= {int(cfg.net_in_threshold)} B per 5 min")
        if point.get("cpu") is not None and point["cpu"] >= cfg.cpu_threshold:
            return Decision("ec2", "keep", f"activity at {stamp} UTC: CPU {point['cpu']:.1f}% >= {cfg.cpu_threshold}%")

    def peak(key: str) -> float:
        return max((p[key] for p in window if p.get(key) is not None), default=0.0)

    return Decision(
        "ec2", "stop",
        f"idle for {cfg.idle_minutes} min ({len(window)} datapoints; peak NetworkOut {int(peak('out'))} B, NetworkIn {int(peak('in'))} B, CPU {peak('cpu'):.1f}%)",
    )


def decide_ec2_nightly(cfg: Config, now: datetime, instance: dict) -> Decision:
    state = instance["state"]
    if state != "running":
        return Decision("ec2", "keep", f"instance is {state}")
    reason = keepalive_reason(instance["tags"], now)
    if reason:
        return Decision("ec2", "keep", reason)
    uptime = now - instance["launch_time"]
    if uptime < timedelta(minutes=cfg.nightly_min_uptime_minutes):
        return Decision("ec2", "keep", f"started only {int(uptime.total_seconds() // 60)} min ago; nightly cap waits")
    return Decision("ec2", "stop", "scheduled nightly cap (hard limit on daily uptime)")


def decide_rds(cfg: Config, now: datetime, rds: dict, ec2_state_after: str, ec2_stopped_at: Optional[datetime],
               rds_started_at: Optional[datetime], nightly: bool) -> Decision:
    """ec2_state_after = the EC2 state AFTER this run's own EC2 decision ("stopping" if this run stops it)."""
    status = rds["status"]
    if status != "available":
        return Decision("rds", "keep", f"database is {status}")
    reason = keepalive_reason(rds["tags"], now)
    if reason:
        return Decision("rds", "keep", reason)
    if ec2_state_after in ("running", "pending"):
        return Decision("rds", "keep", "EC2 is running: the application needs its database")
    if rds_started_at is not None:
        since_start = now - rds_started_at
        if since_start < timedelta(minutes=cfg.rds_stop_delay_minutes):
            return Decision("rds", "keep", f"database started {int(since_start.total_seconds() // 60)} min ago; leaving it a {cfg.rds_stop_delay_minutes}-minute grace period")
    if nightly:
        return Decision("rds", "stop", "scheduled nightly cap and EC2 is not running")
    if ec2_state_after in ("stopping", "shutting-down"):
        return Decision("rds", "keep", "EC2 is still stopping; will re-check on the next run")
    if ec2_stopped_at is None:
        return Decision("rds", "keep", "cannot tell how long EC2 has been off; keeping the database (safe default)")
    off_for = now - ec2_stopped_at
    if off_for < timedelta(minutes=cfg.rds_stop_delay_minutes):
        return Decision("rds", "keep", f"EC2 has been off {int(off_for.total_seconds() // 60)} min; waiting {cfg.rds_stop_delay_minutes} min before stopping the database")
    return Decision("rds", "stop", f"EC2 has been off for {int(off_for.total_seconds() // 60)} min and the database is still running")


_TRANSITION_RE = re.compile(r"\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) GMT\)")


def parse_stop_time(reason: str) -> Optional[datetime]:
    """EC2 StateTransitionReason looks like 'User initiated (2026-11-22 16:30:00 GMT)'."""
    match = _TRANSITION_RE.search(reason or "")
    if not match:
        return None
    return datetime.fromisoformat(f"{match.group(1)}T{match.group(2)}+00:00")


# ----------------------------------------------------------------------------------------------------------------------
# AWS access (thin; clients can be injected for tests)
# ----------------------------------------------------------------------------------------------------------------------
def _metric_points(cw: Any, instance_id: str, start: datetime, end: datetime) -> list:
    series: dict = {}
    for key, metric, stat in (("out", "NetworkOut", "Sum"), ("in", "NetworkIn", "Sum"), ("cpu", "CPUUtilization", "Average")):
        response = cw.get_metric_statistics(
            Namespace="AWS/EC2", MetricName=metric, Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
            StartTime=start, EndTime=end, Period=300, Statistics=[stat],
        )
        for point in response.get("Datapoints", []):
            series.setdefault(point["Timestamp"], {"time": point["Timestamp"], "out": None, "in": None, "cpu": None})[key] = float(point[stat])
    return list(series.values())


def _clients(region: Optional[str] = None) -> tuple:
    import boto3  # imported lazily so the pure logic can be tested without boto3

    return boto3.client("ec2", region_name=region), boto3.client("rds", region_name=region), boto3.client("cloudwatch", region_name=region)


def handler(event: Optional[dict], context: Any = None, *, ec2: Any = None, rds: Any = None, cw: Any = None,
            cfg: Optional[Config] = None, now: Optional[datetime] = None) -> dict:
    event = event or {}
    cfg = cfg or load_config()
    now = now or datetime.now(timezone.utc)
    if ec2 is None or rds is None or cw is None:
        ec2, rds, cw = _clients()

    nightly = event.get("trigger") == "nightly"           # anything else is treated as the (gentler) idle check
    dry_run = cfg.dry_run or event.get("dry_run") is True  # an event can only make things safer
    summary: dict = {"trigger": "nightly" if nightly else "idle-check", "mode": "dry-run" if dry_run else "live", "time": now.isoformat(), "decisions": [], "actions": []}

    # ---- EC2 -------------------------------------------------------------------------------------------------------
    try:
        reservations = ec2.describe_instances(InstanceIds=[cfg.instance_id])["Reservations"]
        raw = reservations[0]["Instances"][0]
    except Exception as exc:  # unknown instance, throttling, permissions ...
        logger.error("cannot read EC2 instance: %s", exc)
        summary["error"] = f"cannot read EC2 instance: {exc}"
        return summary
    instance = {"state": raw["State"]["Name"], "launch_time": raw["LaunchTime"], "tags": tags_to_dict(raw.get("Tags")),
                "reason": raw.get("StateTransitionReason", "")}

    if nightly:
        ec2_decision = decide_ec2_nightly(cfg, now, instance)
    elif instance["state"] == "running":
        try:
            points = _metric_points(cw, cfg.instance_id, now - timedelta(minutes=cfg.idle_minutes + 15), now)
        except Exception as exc:
            logger.error("cannot read metrics: %s", exc)
            points = []  # no evidence -> decide_ec2_idle keeps the instance running
        ec2_decision = decide_ec2_idle(cfg, now, instance, points)
    else:
        ec2_decision = Decision("ec2", "keep", f"instance is {instance['state']}")
    summary["decisions"].append(ec2_decision.__dict__)

    # ---- RDS -------------------------------------------------------------------------------------------------------
    rds_decision: Optional[Decision] = None
    try:
        db = rds.describe_db_instances(DBInstanceIdentifier=cfg.db_id)["DBInstances"][0]
        rds_info = {"status": db["DBInstanceStatus"], "tags": {}}
        ec2_after = "stopping" if ec2_decision.action == "stop" else instance["state"]
        ec2_stopped_at = None
        rds_started_at = None
        if rds_info["status"] == "available":
            rds_info["tags"] = tags_to_dict(rds.list_tags_for_resource(ResourceName=db["DBInstanceArn"]).get("TagList"))
            events = rds.describe_events(SourceIdentifier=cfg.db_id, SourceType="db-instance", Duration=1440).get("Events", [])
            started = [e["Date"] for e in events if "started" in e.get("Message", "").lower()]
            rds_started_at = max(started) if started else None
            if instance["state"] == "stopped":
                ec2_stopped_at = parse_stop_time(instance["reason"])
                if ec2_stopped_at is None:  # fall back to the last time the instance reported any metric
                    last = _metric_points(cw, cfg.instance_id, now - timedelta(hours=24), now)
                    ec2_stopped_at = max((p["time"] for p in last), default=None)
        rds_decision = decide_rds(cfg, now, rds_info, ec2_after, ec2_stopped_at, rds_started_at, nightly)
    except Exception as exc:
        logger.error("cannot read RDS instance: %s", exc)
        summary["error"] = f"cannot read RDS instance: {exc}"
    if rds_decision:
        summary["decisions"].append(rds_decision.__dict__)

    # ---- act -------------------------------------------------------------------------------------------------------
    if ec2_decision.action == "stop":
        summary["actions"].append(_act(dry_run, "ec2", lambda: ec2.stop_instances(InstanceIds=[cfg.instance_id]), cfg.instance_id))
    if rds_decision and rds_decision.action == "stop":
        summary["actions"].append(_act(dry_run, "rds", lambda: rds.stop_db_instance(DBInstanceIdentifier=cfg.db_id), cfg.db_id))

    logger.info(json.dumps(summary, default=str))
    return summary


def _act(dry_run: bool, resource: str, call: Any, identifier: str) -> dict:
    if dry_run:
        return {"resource": resource, "id": identifier, "result": "DRY RUN: would stop"}
    try:
        call()
        return {"resource": resource, "id": identifier, "result": "stop requested"}
    except Exception as exc:  # e.g. already stopping: log, never crash the schedule
        logger.error("stop %s failed: %s", resource, exc)
        return {"resource": resource, "id": identifier, "result": f"stop failed: {exc}"}
