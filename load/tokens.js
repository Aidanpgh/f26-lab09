// Claim: a token works on any request, whichever copy answers it.
//
// Sends one copy's member token through the proxy REQUESTS times, on an
// endpoint that needs nothing but a valid token (GET /bookings), and records
// whether each response accepted it and which copy (X-Upstream) answered.
//
//   docker compose run --rm --no-deps k6 run /load/tokens.js -e TOKEN=<a u-1 token from `docker compose logs api`>
//
// Thresholds:
//   token_accepted  rate==1    the claim itself: every response is a 200
//   upstreams_seen  value>=2   the run is only evidence if both copies answered
import http from 'k6/http';
import { check } from 'k6';
import { Gauge, Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://proxy';
const TOKEN = __ENV.TOKEN;
const REQUESTS = parseInt(__ENV.REQUESTS || '40', 10);

const tokenAccepted = new Rate('token_accepted');
const upstreamsSeen = new Gauge('upstreams_seen');

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    token_accepted: ['rate==1'],
    upstreams_seen: ['value>=2'],
  },
};

export default function () {
  if (!TOKEN) {
    throw new Error('Pass -e TOKEN=<a token printed by one copy>');
  }
  const byUpstream = {};
  for (let i = 0; i < REQUESTS; i++) {
    const res = http.get(`${BASE}/bookings`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const upstream = res.headers['X-Upstream'] || 'none';
    const accepted = res.status === 200;
    tokenAccepted.add(accepted, { upstream });
    check(res, { 'token accepted (200)': (r) => r.status === 200 });

    const tally = byUpstream[upstream] || (byUpstream[upstream] = { 200: 0, other: 0 });
    tally[accepted ? 200 : 'other'] += 1;
  }
  upstreamsSeen.add(Object.keys(byUpstream).filter((u) => u !== 'none').length);
  for (const [upstream, tally] of Object.entries(byUpstream)) {
    console.log(`X-Upstream ${upstream}: ${tally[200]} accepted, ${tally.other} refused`);
  }
}
