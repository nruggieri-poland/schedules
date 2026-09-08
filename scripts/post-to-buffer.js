/**
 * post-to-buffer.js
 *
 * Posts today's schedule-change graphic (built by build-today-graphic.js) to
 * Buffer as an Instagram Story, a Facebook Story, and an X/Twitter post.
 *
 * Posting cadence (see shouldPostNow below):
 *   - First distinct change of the day → post right away.
 *   - A later, genuinely different change → post again, but only once at
 *     least QUIET_WINDOW_MINUTES has passed since the last post (this also
 *     absorbs a change that gets detected/reported across two back-to-back
 *     ~10-min runs before settling, so that doesn't read as two incidents).
 *   - At most MAX_POSTS_PER_DAY posts total, however many distinct changes
 *     occur — once the cap is hit, no more posts until the date rolls over.
 *   - No change since the last post (same signature) → never reposts.
 *
 * Requires these secrets/env vars (skips quietly, exit 0, if the token is
 * missing — so this is safe to leave unconfigured):
 *   BUFFER_ACCESS_TOKEN          — Settings → API on publish.buffer.com
 *   BUFFER_CHANNEL_ID_INSTAGRAM  — from `node scripts/list-buffer-channels.js`
 *   BUFFER_CHANNEL_ID_FACEBOOK   — ditto
 *   BUFFER_CHANNEL_ID_TWITTER    — ditto
 * Optional:
 *   MEDIA_BASE_URL — public base URL the dist/ tree is reachable at.
 *     Defaults to this repo's raw.githubusercontent.com main-branch URL,
 *     which needs no GitHub Pages setup (this repo's Pages isn't enabled) —
 *     raw.githubusercontent.com already serves any file in a public repo.
 *
 * Dedup + "which graphic did we post" both key off the same content
 * signature build-today-graphic.js uses to name dist/history/ files, so this
 * script never has to guess a filename — see lib/change-signature.js.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DateTime } from 'luxon';
import { computeSignature } from './lib/change-signature.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const META_DIR    = path.join(ROOT, 'dist', 'meta');
const TODAY_PATH  = path.join(META_DIR, 'today-changes.json');
const STATE_PATH  = path.join(META_DIR, 'buffer-post-state.json');

const MEDIA_BASE_URL = process.env.MEDIA_BASE_URL
  || 'https://raw.githubusercontent.com/nruggieri-poland/schedules/main/dist';

const BUFFER_API   = 'https://api.buffer.com/graphql';
const BUFFER_TOKEN = process.env.BUFFER_ACCESS_TOKEN;
const CHANNEL_INSTAGRAM = process.env.BUFFER_CHANNEL_ID_INSTAGRAM;
const CHANNEL_FACEBOOK  = process.env.BUFFER_CHANNEL_ID_FACEBOOK;
const CHANNEL_TWITTER   = process.env.BUFFER_CHANNEL_ID_TWITTER;

const SITE_URL = 'polandathletics.com';
const TWITTER_LIMIT = 280;

const MAX_POSTS_PER_DAY   = 2;
const QUIET_WINDOW_MINUTES = 60;

// ── Caption ──────────────────────────────────────────────────────────────────

function statusText(item) {
  switch (item.status) {
    case 'cancelled':          return 'canceled';
    case 'postponed':          return 'postponed';
    case 'time-changed':       return `now ${item.timeAfter || 'TBD'}`;
    case 'location-changed':   return `now at ${item.locationAfter || 'a new location'}`;
    case 'added':              return "added to today's schedule";
    case 'removed':            return 'removed from the schedule';
    case 'restored':           return 'back on';
    default:                   return item.status;
  }
}

// Builds one caption shared by all three posts, sized to X's tighter limit
// (Instagram/Facebook have plenty of headroom, so the same text works there).
// Searches from "all lines fit" down to "none fit" so the overflow note is
// never silently dropped just because it was the thing that didn't fit.
function buildCaption(items, dateLabel) {
  const header = `Schedule updates today (${dateLabel}) — Poland Bulldogs Athletics:`;
  const footer = `Full schedule: ${SITE_URL}`;
  const lines = items.map(i => `• ${i.sport} (${i.levelLabel}): ${statusText(i)}`);

  for (let n = lines.length; n >= 0; n--) {
    const remaining = lines.length - n;
    if (n === 0) {
      // Nothing fits alongside the header — collapse to a single summary line.
      return remaining > 0
        ? `${remaining} schedule update${remaining === 1 ? '' : 's'} today for Poland Bulldogs Athletics. ${footer}`
        : footer;
    }
    const overflowNote = remaining > 0 ? [`+${remaining} more update${remaining === 1 ? '' : 's'}`] : [];
    const candidate = [header, ...lines.slice(0, n), ...overflowNote, footer].join('\n');
    if (candidate.length <= TWITTER_LIMIT) return candidate;
  }
  return footer;
}

// ── Buffer API ───────────────────────────────────────────────────────────────

async function waitForUrl(url, { attempts = 6, delayMs = 5000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) return true;
    } catch { /* network hiccup — retry */ }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

async function createPost({ channelId, text, imageUrl, metadata }) {
  const query = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id } }
        ... on MutationError { message }
      }
    }
  `;
  const variables = {
    input: {
      text,
      channelId,
      schedulingType: 'automatic',
      mode: 'shareNow',
      needsApproval: false,
      assets: imageUrl ? [{ image: { url: imageUrl } }] : [],
      ...(metadata ? { metadata } : {}),
    },
  };

  let res;
  try {
    res = await fetch(BUFFER_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${BUFFER_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    return { ok: false, error: `network error: ${err.message}` };
  }

  const json = await res.json().catch(() => null);
  const result = json?.data?.createPost;
  if (result?.post?.id) return { ok: true, id: result.post.id };
  const message = result?.message || json?.errors?.[0]?.message || `HTTP ${res.status}`;
  return { ok: false, error: message };
}

// ── Posting-cadence decision ─────────────────────────────────────────────────

// state is null, or from a prior day, or today's { date, signature, postCount,
// lastPostedAt }. Returns { post: boolean, reason: string } — reason is always
// logged so a skipped run says exactly why.
function shouldPostNow(state, today, signature, now) {
  const todayState = state?.date === today ? state : null;

  if (!todayState) {
    return { post: true, reason: 'first change detected today' };
  }
  if (todayState.signature === signature) {
    return { post: false, reason: 'no change since the last post today' };
  }
  if (todayState.postCount >= MAX_POSTS_PER_DAY) {
    return { post: false, reason: `already posted ${todayState.postCount}x today (max ${MAX_POSTS_PER_DAY}) — further changes won't trigger another post until tomorrow` };
  }

  const lastPostedAt = DateTime.fromISO(todayState.lastPostedAt);
  const minutesSinceLastPost = now.diff(lastPostedAt, 'minutes').minutes;
  if (minutesSinceLastPost < QUIET_WINDOW_MINUTES) {
    const wait = Math.ceil(QUIET_WINDOW_MINUTES - minutesSinceLastPost);
    return { post: false, reason: `new change detected, but waiting for the ${QUIET_WINDOW_MINUTES}-min quiet window since the last post (~${wait} min left) — will post covering everything accumulated by then` };
  }

  return { post: true, reason: `new change after the quiet window (post ${todayState.postCount + 1} of ${MAX_POSTS_PER_DAY} today)` };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!BUFFER_TOKEN) {
    console.log('BUFFER_ACCESS_TOKEN not set — skipping Buffer posting.\n');
    return;
  }

  const now = DateTime.now().setZone('America/New_York');
  const today = now.toISODate();

  const accumulator = fs.existsSync(TODAY_PATH) ? JSON.parse(fs.readFileSync(TODAY_PATH, 'utf-8')) : null;
  const items = accumulator?.date === today ? Object.values(accumulator.items) : [];

  if (items.length === 0) {
    console.log('No changes affecting today — nothing to post.\n');
    return;
  }

  const signature = computeSignature(items);
  const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) : null;

  const decision = shouldPostNow(state, today, signature, now);
  console.log(`Posting decision: ${decision.post ? 'POST' : 'skip'} — ${decision.reason}\n`);
  if (!decision.post) return;

  const squareUrl = `${MEDIA_BASE_URL}/history/${today}_${signature}_square.png`;
  const storyUrl  = `${MEDIA_BASE_URL}/history/${today}_${signature}_story.png`;

  const [squareReady, storyReady] = await Promise.all([waitForUrl(squareUrl), waitForUrl(storyUrl)]);
  if (!squareReady || !storyReady) {
    console.error(`Graphic not reachable yet at ${squareReady ? storyUrl : squareUrl} — skipping this run; the next pipeline run will retry since the signature hasn't been recorded as posted.\n`);
    return;
  }

  const text = buildCaption(items, now.toFormat('cccc, LLLL d'));
  const results = {};

  if (CHANNEL_INSTAGRAM) {
    results.instagram = await createPost({
      channelId: CHANNEL_INSTAGRAM, text, imageUrl: storyUrl,
      metadata: { instagram: { type: 'story', shouldShareToFeed: false } },
    });
  } else {
    console.log('BUFFER_CHANNEL_ID_INSTAGRAM not set — skipping Instagram.');
  }

  if (CHANNEL_FACEBOOK) {
    results.facebook = await createPost({
      channelId: CHANNEL_FACEBOOK, text, imageUrl: storyUrl,
      metadata: { facebook: { type: 'story' } },
    });
  } else {
    console.log('BUFFER_CHANNEL_ID_FACEBOOK not set — skipping Facebook.');
  }

  if (CHANNEL_TWITTER) {
    results.twitter = await createPost({ channelId: CHANNEL_TWITTER, text, imageUrl: squareUrl });
  } else {
    console.log('BUFFER_CHANNEL_ID_TWITTER not set — skipping Twitter/X.');
  }

  for (const [platform, result] of Object.entries(results)) {
    console.log(result.ok ? `${platform}: posted (post id ${result.id})` : `${platform}: FAILED — ${result.error}`);
  }

  // Record this signature/count as posted even if some channels failed — a
  // transient per-channel failure shouldn't cause an infinite repost loop of
  // the same alert; check the run log if a channel shows FAILED above.
  const priorCount = state?.date === today ? state.postCount : 0;
  const postedAt = now.toISO();
  const history = state?.date === today ? state.history || [] : [];
  history.push({ signature, postedAt, results });

  fs.writeFileSync(STATE_PATH, JSON.stringify({
    date: today,
    signature,
    postCount: priorCount + 1,
    lastPostedAt: postedAt,
    history,
  }, null, 2));
}

main().catch(err => { console.error(err); });
