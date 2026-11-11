import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    students: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 30 },
        { duration: "3m", target: 90 },
        { duration: "5m", target: 90 },
        { duration: "2m", target: 180 },
        { duration: "2m", target: 0 }
      ],
      gracefulRampDown: "30s"
    }
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"]
  }
};

const base = __ENV.BASE_URL || "http://localhost:4000/api/v1";
export default function () {
  const health = http.get(`${base}/health`);
  check(health, { "health returns 200": (r) => r.status === 200 });
  sleep(1);
}
// This is a smoke/load-test scaffold, not a full authenticated quiz journey.
// Add synthetic credentials, login, quiz IDs, answer saves and submissions before
// using it to claim examination workload acceptance.
