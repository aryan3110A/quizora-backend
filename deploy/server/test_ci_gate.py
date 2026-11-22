"""Offline tests for ci_gate.py:  python3 -m unittest -v test_ci_gate"""
import io
import json
import unittest
import urllib.error

import ci_gate as g


def run(name, status="completed", conclusion="success"):
    return {"name": name, "status": status, "conclusion": conclusion if status == "completed" else None}


class Evaluate(unittest.TestCase):
    def test_all_green_passes(self):
        self.assertEqual(g.evaluate({"check_runs": [run("check"), run("docker")]})[0], 0)

    def test_skipped_and_neutral_are_fine(self):
        self.assertEqual(g.evaluate({"check_runs": [run("a"), run("b", conclusion="skipped"), run("c", conclusion="neutral")]})[0], 0)

    def test_a_failure_blocks(self):
        code, msg = g.evaluate({"check_runs": [run("check"), run("docker", conclusion="failure")]})
        self.assertEqual(code, 2)
        self.assertIn("docker=failure", msg)

    def test_cancelled_timed_out_and_action_required_block(self):
        for conclusion in ("cancelled", "timed_out", "action_required", "startup_failure", "stale"):
            self.assertEqual(g.evaluate({"check_runs": [run("x", conclusion=conclusion)]})[0], 2, conclusion)

    def test_a_failure_wins_over_still_running_jobs(self):
        self.assertEqual(g.evaluate({"check_runs": [run("a", conclusion="failure"), run("b", status="in_progress")]})[0], 2)

    def test_running_or_queued_means_wait(self):
        for status in ("in_progress", "queued", "waiting", "pending"):
            self.assertEqual(g.evaluate({"check_runs": [run("a"), run("b", status=status)]})[0], 3, status)

    def test_no_runs_means_wait_not_deploy(self):
        self.assertEqual(g.evaluate({"check_runs": []})[0], 3)
        self.assertEqual(g.evaluate({})[0], 3)

    def test_unknown_conclusion_is_not_treated_as_success(self):
        self.assertEqual(g.evaluate({"check_runs": [run("a", conclusion="something_new")]})[0], 2)
        self.assertEqual(g.evaluate({"check_runs": [{"name": "a", "status": "completed", "conclusion": None}]})[0], 2)


class Main(unittest.TestCase):
    SHA = "a" * 40

    def opener(self, payload):
        def _open(request, timeout=None):
            self.last_url = request.full_url
            return io.StringIO(json.dumps(payload))
        return _open

    def test_exit_codes_end_to_end(self):
        self.assertEqual(g.main(["ci_gate.py", "o", "r", self.SHA], self.opener({"check_runs": [run("a")]})), 0)
        self.assertEqual(g.main(["ci_gate.py", "o", "r", self.SHA], self.opener({"check_runs": [run("a", conclusion="failure")]})), 2)
        self.assertEqual(g.main(["ci_gate.py", "o", "r", self.SHA], self.opener({"check_runs": []})), 3)

    def test_it_asks_about_the_exact_commit(self):
        g.main(["ci_gate.py", "aryan3110A", "quizora-backend", self.SHA], self.opener({"check_runs": [run("a")]}))
        self.assertIn(f"/repos/aryan3110A/quizora-backend/commits/{self.SHA}/check-runs", self.last_url)

    def test_github_errors_fail_closed(self):
        def rate_limited(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 403, "rate limit", {}, None)

        def offline(request, timeout=None):
            raise urllib.error.URLError("no network")

        def garbage(request, timeout=None):
            return io.StringIO("<html>not json</html>")

        for opener in (rate_limited, offline, garbage):
            self.assertEqual(g.main(["ci_gate.py", "o", "r", self.SHA], opener), 4)

    def test_rejects_malformed_input_without_touching_the_network(self):
        def must_not_be_called(request, timeout=None):
            raise AssertionError("network was used")

        for argv in (["ci_gate.py"], ["ci_gate.py", "o", "r"], ["ci_gate.py", "o", "r", "../../etc/passwd"], ["ci_gate.py", "o", "r", "abc"],
                     ["ci_gate.py", "o", "r", "a" * 40 + "?x=1"], ["ci_gate.py", "", "r", self.SHA]):
            self.assertEqual(g.main(argv, must_not_be_called), 4, argv)


if __name__ == "__main__":
    unittest.main()
