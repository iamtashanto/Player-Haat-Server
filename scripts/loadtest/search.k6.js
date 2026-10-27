// k6 load test for GET /players (search), with a realistic side-order of feed and inbox reads.
//
//   BASE_URL=http://localhost:4020/api/v1 k6 run scripts/loadtest/search.k6.js
//   (env: PEAK_VUS=100, HOLD=30s) — needs the bench database (see seed-bulk.ts) and the server run with
//   rate limiting off (NODE_ENV=test or RATE_LIMIT_ENABLED=false), or the per-user budgets will answer 429.
import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:4020/api/v1";
const PEAK = Number(__ENV.PEAK_VUS || 100);
const HOLD = __ENV.HOLD || "30s";
const meta = JSON.parse(open("./.bench-meta.json"));
const pageTwo = new Counter("search_page2_requests");
const searchDuration = new Trend("search_duration", true);

export const options = {
  scenarios: {
    mixed: {
      executor: "ramping-vus",
      stages: [
        { duration: "10s", target: Math.round(PEAK / 2) },
        { duration: HOLD, target: Math.round(PEAK / 2) },
        { duration: "10s", target: PEAK },
        { duration: HOLD, target: PEAK },
        { duration: "5s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    search_duration: ["p(95)<250", "p(99)<600"],
    checks: ["rate>0.99"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function setup() {
  const tokens = [];
  for (let i = 1; i <= 20; i++) {
    const res = http.post(`${BASE}/auth/login`, JSON.stringify({ email: `loadtest${i}@bench.test`, password: "LoadTest123" }), { headers: { "Content-Type": "application/json" } });
    if (res.status !== 200) throw new Error(`login ${i} failed: ${res.status} ${res.body}`);
    tokens.push(res.json("data.tokens.accessToken"));
  }
  return { tokens };
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const F = meta.footballId;
const shapes = [
  [30, () => ({ upazilaId: pick(meta.hotUpazilas), sportId: F, position: "GK", khepAvailable: true })], // "a keeper near me, for pay"
  [20, () => ({ districtId: pick(meta.hotDistricts), sort: "active" })],
  [15, () => ({ sportId: F, position: "ST" })], // national, by rating
  [15, () => ({ upazilaId: pick(meta.hotUpazilas), sportId: F, rateMin: 300, rateMax: 500, availabilityDay: "fri" })],
  [10, () => ({ districtId: pick(meta.hotDistricts), minRating: 4 })],
  [10, () => ({})], // national, no filters
];
function chooseShape() {
  let r = Math.random() * 100;
  for (const [w, make] of shapes) { if ((r -= w) < 0) return make(); }
  return {};
}
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

export default function (data) {
  const headers = { Authorization: `Bearer ${data.tokens[(__VU - 1) % data.tokens.length]}` };
  const roll = Math.random();

  if (roll < 0.85) {
    const query = chooseShape();
    const res = http.get(`${BASE}/players?${qs({ limit: 20, ...query })}`, { headers, tags: { endpoint: "search" } });
    searchDuration.add(res.timings.duration);
    check(res, { "search 200": (r) => r.status === 200 });
    // a third of searchers scroll to page two
    const next = res.status === 200 ? res.json("meta.nextCursor") : null;
    if (next && Math.random() < 0.33) {
      const r2 = http.get(`${BASE}/players?${qs({ limit: 20, ...query, cursor: next })}`, { headers, tags: { endpoint: "search" } });
      searchDuration.add(r2.timings.duration);
      pageTwo.add(1);
      check(r2, { "page 2 200": (r) => r.status === 200 });
    }
  } else if (roll < 0.95) {
    const res = http.get(`${BASE}/requests?${qs({ sportId: F, upazilaId: pick(meta.hotUpazilas), limit: 20 })}`, { headers, tags: { endpoint: "feed" } });
    check(res, { "feed 200": (r) => r.status === 200 });
  } else {
    const res = http.get(`${BASE}/notifications?limit=20`, { headers, tags: { endpoint: "inbox" } });
    check(res, { "inbox 200": (r) => r.status === 200 });
  }
}

export function handleSummary(d) {
  const pick = (m, keys) => Object.fromEntries(keys.map((k) => [k, d.metrics[m]?.values?.[k]]));
  const out = {
    peakVus: PEAK,
    requests: d.metrics.http_reqs.values.count,
    rps: d.metrics.http_reqs.values.rate,
    failedRate: d.metrics.http_req_failed.values.rate,
    searchMs: pick("search_duration", ["avg", "med", "p(90)", "p(95)", "p(99)", "max"]),
    allMs: pick("http_req_duration", ["avg", "med", "p(90)", "p(95)", "p(99)", "max"]),
    checksPassRate: d.metrics.checks.values.rate,
  };
  return { "scripts/loadtest/results.json": JSON.stringify(out, null, 2), stdout: JSON.stringify(out, null, 2) + "\n" };
}
