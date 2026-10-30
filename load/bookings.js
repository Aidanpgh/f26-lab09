// Claim: a room slot is booked at most once.
//
// Asks for the same room and the same slot twice, once on each copy, each
// request sent straight to that copy (not through the proxy) with a token that
// copy minted. Through the proxy, half the requests would be refused for the
// token alone (see tokens.js), so a refusal would hide whether the slot check
// works. Then it counts how many of the two asks came back confirmed.
//
//   docker compose run --rm --no-deps k6 run /load/bookings.js \
//     -e A_URL=http://lab09-api-1:8080 -e A_TOKEN=<api-1's u-1 token> \
//     -e B_URL=http://lab09-api-2:8080 -e B_TOKEN=<api-2's u-2 token>
//
// Control (one copy, two people): point B at the same copy as A, with that
// copy's u-2 token. The second ask should land on the waitlist (202).
//
// Thresholds:
//   slot_confirmed  count<=1   the claim itself: at most one confirmation per slot
//   ask_answered    rate==1    each ask was authenticated and judged (201, 202, or 409),
//                              so a bad token or a malformed slot cannot pass quietly
//
// The slot is picked at random, 2 to 12 days out (a study room books at most
// 14 days ahead, RoomKind.STUDY_ROOM), and every booking made is
// cancelled at the end, so the script can be rerun on the same stack.
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const ROOM = __ENV.ROOM || 'r-1';
const MINUTES = 60;
const asks = [
  { name: 'A', url: __ENV.A_URL, token: __ENV.A_TOKEN },
  { name: 'B', url: __ENV.B_URL, token: __ENV.B_TOKEN },
];

const slotConfirmed = new Counter('slot_confirmed');
const askAnswered = new Rate('ask_answered');

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    slot_confirmed: ['count<=1'],
    ask_answered: ['rate==1'],
  },
};

/** A whole hour between 08:00 and 20:00 UTC, 2 to 12 days from now. */
function randomSlotStart() {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 2 + Math.floor(Math.random() * 11));
  day.setUTCHours(8 + Math.floor(Math.random() * 12), 0, 0, 0);
  return day.toISOString().replace('.000Z', 'Z');
}

export default function () {
  for (const ask of asks) {
    if (!ask.url || !ask.token) {
      throw new Error('Pass -e A_URL, A_TOKEN, B_URL, B_TOKEN');
    }
  }
  const start = randomSlotStart();
  console.log(`room ${ROOM}, slot ${start} for ${MINUTES} minutes`);

  const made = [];
  for (const ask of asks) {
    const res = http.post(
      `${ask.url}/bookings`,
      { roomId: ROOM, start, minutes: String(MINUTES) },
      { headers: { Authorization: `Bearer ${ask.token}` } },
    );
    const confirmed = res.status === 201;
    slotConfirmed.add(confirmed ? 1 : 0);
    askAnswered.add([201, 202, 409].includes(res.status));
    check(res, { 'ask was judged, not refused for credentials or input': (r) => [201, 202, 409].includes(r.status) });

    const body = res.json() || {};
    console.log(`ask ${ask.name} -> ${ask.url}: ${res.status} ${body.outcome || body.error || ''}`);
    if (confirmed) {
      made.push({ ask, id: body.booking.id });
    } else if (res.status === 202) {
      made.push({ ask, waitlistId: body.waitlistEntry.id });
    }
  }

  // Clean up so the next run starts from the same place. Newest first: leaving
  // the waitlist before the booking is cancelled, so nothing gets promoted.
  for (const m of made.reverse()) {
    const path = m.id ? `/bookings/${m.id}` : `/waitlist/${m.waitlistId}`;
    http.del(`${m.ask.url}${path}`, null, { headers: { Authorization: `Bearer ${m.ask.token}` } });
  }
}
