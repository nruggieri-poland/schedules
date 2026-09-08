import { createHash } from 'node:crypto';

// A stable fingerprint of "what today's changes actually say" — used both to
// name history files uniquely (so a freshly-posted graphic never collides
// with a stale CDN-cached URL) and to detect whether anything has actually
// changed since the last Buffer post (so an unchanged accumulator across
// repeated ~10-min pipeline runs doesn't repost the same alert).
export function computeSignature(items) {
  const normalized = items
    .map(i => ({
      id: i.eventId,
      status: i.status,
      timeAfter: i.timeAfter || null,
      locationAfter: i.locationAfter || null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha1').update(JSON.stringify(normalized)).digest('hex').slice(0, 10);
}
