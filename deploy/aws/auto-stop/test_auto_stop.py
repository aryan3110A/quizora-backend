"""Unit tests for the auto-stop Lambda. No AWS access needed:  python -I -m unittest -v test_auto_stop"""
import unittest
from datetime import datetime, timedelta, timezone

import lambda_function as lf

NOW = datetime(2026, 11, 22, 20, 0, 0, tzinfo=timezone.utc)
ID = "i-0a715bf24dd07d8a0"
DB = "quizora-postgres"


def cfg(**kw):
    base = dict(instance_id=ID, db_id=DB, dry_run=False)
    base.update(kw)
    return lf.Config(**base)


def inst(state="running", up_min=180, tags=None, reason=""):
    return {"state": state, "launch_time": NOW - timedelta(minutes=up_min), "tags": tags or {}, "reason": reason}


def pts(n=12, out=500.0, inn=500.0, cpu=2.0, newest_ago=2):
    return [{"time": NOW - timedelta(minutes=newest_ago + 5 * i), "out": out, "in": inn, "cpu": cpu} for i in range(n)]


class Ec2IdleDecision(unittest.TestCase):
    def test_idle_hour_stops(self):
        d = lf.decide_ec2_idle(cfg(), NOW, inst(), pts())
        self.assertEqual(d.action, "stop")
        self.assertIn("idle for 60 min", d.reason)

    def test_a_single_busy_window_keeps_it_up(self):
        p = pts()
        p[5]["out"] = 60_000.0  # one student with the dashboard open
        d = lf.decide_ec2_idle(cfg(), NOW, inst(), p)
        self.assertEqual(d.action, "keep")
        self.assertIn("NetworkOut", d.reason)

    def test_scanner_noise_below_threshold_is_still_idle(self):
        p = pts()
        p[3]["out"] = 27_000.0  # largest bot burst seen on the real server
        self.assertEqual(lf.decide_ec2_idle(cfg(), NOW, inst(), p).action, "stop")

    def test_cpu_spike_keeps_it_up(self):
        p = pts()
        p[0]["cpu"] = 55.0
        self.assertEqual(lf.decide_ec2_idle(cfg(), NOW, inst(), p).action, "keep")

    def test_big_inbound_transfer_means_a_deployment_is_running(self):
        p = pts()
        p[7]["in"] = 23_790_221.0  # the docker pull seen at 15:44
        d = lf.decide_ec2_idle(cfg(), NOW, inst(), p)
        self.assertEqual(d.action, "keep")
        self.assertIn("NetworkIn", d.reason)

    def test_recently_started_instance_gets_a_full_window(self):
        d = lf.decide_ec2_idle(cfg(), NOW, inst(up_min=30), pts())
        self.assertEqual(d.action, "keep")
        self.assertIn("started 30 min ago", d.reason)

    def test_too_few_datapoints_is_not_evidence(self):
        d = lf.decide_ec2_idle(cfg(), NOW, inst(), pts(n=5))
        self.assertEqual(d.action, "keep")
        self.assertIn("not enough evidence", d.reason)

    def test_no_metrics_at_all_keeps_it_up(self):
        self.assertEqual(lf.decide_ec2_idle(cfg(), NOW, inst(), []).action, "keep")

    def test_stale_metrics_keep_it_up(self):
        d = lf.decide_ec2_idle(cfg(), NOW, inst(), pts(newest_ago=40))
        self.assertEqual(d.action, "keep")

    def test_points_older_than_the_window_do_not_count(self):
        old = [{"time": NOW - timedelta(minutes=200 + 5 * i), "out": 0.0, "in": 0.0, "cpu": 1.0} for i in range(12)]
        self.assertEqual(lf.decide_ec2_idle(cfg(), NOW, inst(), old).action, "keep")

    def test_not_running_is_left_alone(self):
        for state in ("stopped", "stopping", "pending", "terminated"):
            self.assertEqual(lf.decide_ec2_idle(cfg(), NOW, inst(state=state), pts()).action, "keep", state)

    def test_missing_individual_metric_values_are_ignored_not_fatal(self):
        p = pts()
        p[2]["cpu"] = None
        self.assertEqual(lf.decide_ec2_idle(cfg(), NOW, inst(), p).action, "stop")


class KeepAliveTags(unittest.TestCase):
    def test_autostop_disabled(self):
        self.assertEqual(lf.decide_ec2_idle(cfg(), NOW, inst(tags={"AutoStop": "disabled"}), pts()).action, "keep")
        self.assertEqual(lf.decide_ec2_idle(cfg(), NOW, inst(tags={"AutoStop": "DISABLED"}), pts()).action, "keep")

    def test_keepalive_in_the_future_protects(self):
        tomorrow = (NOW + timedelta(hours=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
        d = lf.decide_ec2_idle(cfg(), NOW, inst(tags={"KeepAliveUntil": tomorrow}), pts())
        self.assertEqual(d.action, "keep")
        self.assertIn("KeepAliveUntil", d.reason)

    def test_keepalive_in_the_past_expires(self):
        past = (NOW - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.assertEqual(lf.decide_ec2_idle(cfg(), NOW, inst(tags={"KeepAliveUntil": past}), pts()).action, "stop")

    def test_unreadable_keepalive_value_fails_safe(self):
        d = lf.decide_ec2_idle(cfg(), NOW, inst(tags={"KeepAliveUntil": "tomorrow evening"}), pts())
        self.assertEqual(d.action, "keep")
        self.assertIn("unreadable", d.reason)

    def test_date_without_timezone_is_treated_as_utc(self):
        future = (NOW + timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S")
        self.assertEqual(lf.decide_ec2_idle(cfg(), NOW, inst(tags={"KeepAliveUntil": future}), pts()).action, "keep")


class Ec2Nightly(unittest.TestCase):
    def test_nightly_stops_regardless_of_traffic(self):
        self.assertEqual(lf.decide_ec2_nightly(cfg(), NOW, inst()).action, "stop")

    def test_nightly_respects_keepalive(self):
        self.assertEqual(lf.decide_ec2_nightly(cfg(), NOW, inst(tags={"AutoStop": "disabled"})).action, "keep")

    def test_nightly_does_not_cut_off_a_server_started_minutes_ago(self):
        self.assertEqual(lf.decide_ec2_nightly(cfg(), NOW, inst(up_min=10)).action, "keep")


class RdsDecision(unittest.TestCase):
    def rds(self, status="available", tags=None):
        return {"status": status, "tags": tags or {}}

    def d(self, ec2_state, ec2_off_min=None, rds_started_min=None, nightly=False, **kw):
        stopped_at = NOW - timedelta(minutes=ec2_off_min) if ec2_off_min is not None else None
        started_at = NOW - timedelta(minutes=rds_started_min) if rds_started_min is not None else None
        return lf.decide_rds(cfg(), NOW, kw.get("rds", self.rds()), ec2_state, stopped_at, started_at, nightly)

    def test_never_stops_the_database_under_a_running_application(self):
        for state in ("running", "pending"):
            self.assertEqual(self.d(state).action, "keep", state)

    def test_waits_until_ec2_has_been_off_long_enough(self):
        self.assertEqual(self.d("stopped", ec2_off_min=10).action, "keep")
        self.assertEqual(self.d("stopped", ec2_off_min=45).action, "stop")

    def test_ec2_still_stopping_means_wait(self):
        self.assertEqual(self.d("stopping").action, "keep")

    def test_unknown_stop_time_keeps_the_database(self):
        d = self.d("stopped", ec2_off_min=None)
        self.assertEqual(d.action, "keep")
        self.assertIn("cannot tell", d.reason)

    def test_freshly_started_database_is_left_alone_even_if_ec2_was_off_for_days(self):
        self.assertEqual(self.d("stopped", ec2_off_min=5000, rds_started_min=8).action, "keep")
        self.assertEqual(self.d("stopped", ec2_off_min=5000, rds_started_min=90).action, "stop")

    def test_aws_seven_day_auto_restart_is_undone(self):
        # DB auto-restarted by AWS 40 minutes ago, EC2 off for 4 days -> stop it again
        self.assertEqual(self.d("stopped", ec2_off_min=5760, rds_started_min=40).action, "stop")

    def test_only_available_databases_are_stopped(self):
        for status in ("starting", "stopped", "stopping", "backing-up", "modifying"):
            self.assertEqual(self.d("stopped", ec2_off_min=999, rds=self.rds(status)).action, "keep", status)

    def test_rds_tags_protect_it(self):
        self.assertEqual(self.d("stopped", ec2_off_min=999, rds=self.rds(tags={"AutoStop": "disabled"})).action, "keep")

    def test_nightly_stops_the_database_when_ec2_is_going_down(self):
        self.assertEqual(self.d("stopping", nightly=True).action, "stop")

    def test_nightly_keeps_the_database_if_ec2_stays_up(self):
        self.assertEqual(self.d("running", nightly=True).action, "keep")


class ParseStopTime(unittest.TestCase):
    def test_parses_aws_reason(self):
        self.assertEqual(lf.parse_stop_time("User initiated (2026-11-22 16:30:00 GMT)"), datetime(2026, 11, 22, 16, 30, tzinfo=timezone.utc))

    def test_unknown_reasons_give_none(self):
        self.assertIsNone(lf.parse_stop_time("Client.UserInitiatedShutdown: User initiated shutdown"))
        self.assertIsNone(lf.parse_stop_time(""))


class Config(unittest.TestCase):
    base = {"INSTANCE_ID": ID, "DB_ID": DB}

    def test_dry_run_is_the_default_and_only_exactly_false_turns_it_off(self):
        self.assertTrue(lf.load_config(self.base).dry_run)
        for v in ("true", "TRUE", "", "no", "0", "off", "False-ish"):
            self.assertTrue(lf.load_config({**self.base, "DRY_RUN": v}).dry_run, v)
        self.assertFalse(lf.load_config({**self.base, "DRY_RUN": "false"}).dry_run)
        self.assertFalse(lf.load_config({**self.base, "DRY_RUN": " False "}).dry_run)

    def test_defaults_and_bad_numbers(self):
        c = lf.load_config({**self.base, "IDLE_MINUTES": "banana", "NET_OUT_THRESHOLD_BYTES": "45000"})
        self.assertEqual(c.idle_minutes, 60)
        self.assertEqual(c.net_out_threshold, 45000)

    def test_ids_are_required(self):
        with self.assertRaises(KeyError):
            lf.load_config({"DB_ID": DB})


# ---------------------------------------------------------------------------------------------------------------------
# handler with fake AWS clients
# ---------------------------------------------------------------------------------------------------------------------
class FakeEC2:
    def __init__(self, state="running", up_min=180, tags=None, reason="", fail_stop=False):
        self.state, self.up_min, self.tags, self.reason, self.fail_stop = state, up_min, tags or [], reason, fail_stop
        self.stop_calls = []

    def describe_instances(self, InstanceIds):
        assert InstanceIds == [ID]
        return {"Reservations": [{"Instances": [{"State": {"Name": self.state}, "LaunchTime": NOW - timedelta(minutes=self.up_min),
                                                 "Tags": self.tags, "StateTransitionReason": self.reason}]}]}

    def stop_instances(self, InstanceIds):
        self.stop_calls.append(InstanceIds)
        if self.fail_stop:
            raise RuntimeError("IncorrectInstanceState")
        return {}


class FakeRDS:
    def __init__(self, status="available", tags=None, started_min=None):
        self.status, self.tags, self.started_min = status, tags or [], started_min
        self.stop_calls = []

    def describe_db_instances(self, DBInstanceIdentifier):
        assert DBInstanceIdentifier == DB
        return {"DBInstances": [{"DBInstanceStatus": self.status, "DBInstanceArn": "arn:aws:rds:us-east-1:1:db:quizora-postgres"}]}

    def list_tags_for_resource(self, ResourceName):
        return {"TagList": self.tags}

    def describe_events(self, **kw):
        assert kw["SourceIdentifier"] == DB
        if self.started_min is None:
            return {"Events": []}
        return {"Events": [{"Date": NOW - timedelta(minutes=self.started_min), "Message": "DB instance started"}]}

    def stop_db_instance(self, DBInstanceIdentifier):
        self.stop_calls.append(DBInstanceIdentifier)
        return {}


class FakeCW:
    def __init__(self, out=500.0, inn=500.0, cpu=2.0, n=12, raises=False):
        self.out, self.inn, self.cpu, self.n, self.raises = out, inn, cpu, n, raises

    def get_metric_statistics(self, Namespace, MetricName, Dimensions, StartTime, EndTime, Period, Statistics):
        assert Dimensions == [{"Name": "InstanceId", "Value": ID}]  # only ever reads OUR instance
        if self.raises:
            raise RuntimeError("AccessDenied")
        value = {"NetworkOut": self.out, "NetworkIn": self.inn, "CPUUtilization": self.cpu}[MetricName]
        stat = Statistics[0]
        return {"Datapoints": [{"Timestamp": NOW - timedelta(minutes=2 + 5 * i), stat: value} for i in range(self.n)]}


class HandlerTests(unittest.TestCase):
    def run_handler(self, event=None, ec2=None, rds=None, cw=None, **cfg_kw):
        ec2, rds, cw = ec2 or FakeEC2(), rds or FakeRDS(), cw or FakeCW()
        out = lf.handler(event, None, ec2=ec2, rds=rds, cw=cw, cfg=cfg(**cfg_kw), now=NOW)
        return out, ec2, rds

    def test_dry_run_never_stops_anything(self):
        out, ec2, rds = self.run_handler(dry_run=True)
        self.assertEqual(out["mode"], "dry-run")
        self.assertEqual(ec2.stop_calls, [])
        self.assertEqual(rds.stop_calls, [])
        self.assertEqual(out["actions"][0]["result"], "DRY RUN: would stop")

    def test_live_idle_stops_only_ec2_first_and_leaves_the_database_for_later(self):
        out, ec2, rds = self.run_handler()
        self.assertEqual(ec2.stop_calls, [[ID]])
        self.assertEqual(rds.stop_calls, [])  # EC2 was running at the start of this run

    def test_an_event_can_force_dry_run_but_never_force_live(self):
        out, ec2, _ = self.run_handler(event={"dry_run": True})
        self.assertEqual(out["mode"], "dry-run")
        self.assertEqual(ec2.stop_calls, [])
        out, ec2, _ = self.run_handler(event={"dry_run": False}, dry_run=True)
        self.assertEqual(out["mode"], "dry-run")
        self.assertEqual(ec2.stop_calls, [])

    def test_busy_server_is_left_alone(self):
        out, ec2, rds = self.run_handler(cw=FakeCW(out=80_000.0))
        self.assertEqual(ec2.stop_calls, [])
        self.assertEqual(rds.stop_calls, [])

    def test_metric_api_failure_keeps_everything_running(self):
        out, ec2, rds = self.run_handler(cw=FakeCW(raises=True))
        self.assertEqual(ec2.stop_calls, [])

    def test_database_is_stopped_once_ec2_has_been_off_long_enough(self):
        ec2 = FakeEC2(state="stopped", reason="User initiated (2026-11-22 19:00:00 GMT)")  # off for 60 min
        out, ec2, rds = self.run_handler(ec2=ec2)
        self.assertEqual(rds.stop_calls, [DB])
        self.assertEqual(ec2.stop_calls, [])

    def test_database_is_kept_while_ec2_was_stopped_recently(self):
        ec2 = FakeEC2(state="stopped", reason="User initiated (2026-11-22 19:50:00 GMT)")  # off for 10 min
        out, _, rds = self.run_handler(ec2=ec2)
        self.assertEqual(rds.stop_calls, [])

    def test_seven_day_auto_restart_case(self):
        ec2 = FakeEC2(state="stopped", reason="User initiated (2026-11-18 10:00:00 GMT)")
        rds = FakeRDS(started_min=45)
        _, _, rds = self.run_handler(ec2=ec2, rds=rds)
        self.assertEqual(rds.stop_calls, [DB])

    def test_unknown_stop_time_falls_back_to_the_last_metric(self):
        ec2 = FakeEC2(state="stopped", reason="Client.UserInitiatedShutdown: User initiated shutdown")
        # FakeCW reports the newest point 2 minutes ago -> EC2 "off for 2 min" -> keep
        _, _, rds = self.run_handler(ec2=ec2)
        self.assertEqual(rds.stop_calls, [])

    def test_nightly_stops_both_unless_protected(self):
        out, ec2, rds = self.run_handler(event={"trigger": "nightly"}, cw=FakeCW(out=900_000.0))  # busy traffic is ignored by the cap
        self.assertEqual(ec2.stop_calls, [[ID]])
        self.assertEqual(rds.stop_calls, [DB])
        self.assertEqual(out["trigger"], "nightly")

    def test_nightly_with_protected_ec2_leaves_the_database_up_too(self):
        ec2 = FakeEC2(tags=[{"Key": "KeepAliveUntil", "Value": "2026-11-23T10:00:00Z"}])
        _, ec2, rds = self.run_handler(event={"trigger": "nightly"}, ec2=ec2)
        self.assertEqual(ec2.stop_calls, [])
        self.assertEqual(rds.stop_calls, [])

    def test_unknown_trigger_text_is_treated_as_the_gentle_idle_check(self):
        out, ec2, _ = self.run_handler(event={"trigger": "please-stop-everything-now"}, cw=FakeCW(out=80_000.0))
        self.assertEqual(out["trigger"], "idle-check")
        self.assertEqual(ec2.stop_calls, [])

    def test_a_failing_stop_call_is_reported_not_raised(self):
        out, ec2, _ = self.run_handler(ec2=FakeEC2(fail_stop=True))
        self.assertIn("stop failed", out["actions"][0]["result"])

    def test_unknown_instance_does_nothing_and_does_not_crash(self):
        class Missing(FakeEC2):
            def describe_instances(self, InstanceIds):
                raise RuntimeError("InvalidInstanceID.NotFound")

        out, _, rds = self.run_handler(ec2=Missing())
        self.assertIn("error", out)
        self.assertEqual(rds.stop_calls, [])


if __name__ == "__main__":
    unittest.main()
