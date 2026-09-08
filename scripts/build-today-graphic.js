/**
 * build-today-graphic.js
 *
 * Renders a square (2160x2160, exported from a 1080 layout) social-ready
 * graphic summarizing every schedule change made TODAY — postponements,
 * cancellations, time moves, location moves, and same-day adds/drops.
 *
 * Change detection already happens in fetch.js (see diffEvents/writeChangelog),
 * which runs every ~10 min and overwrites dist/meta/changes.json with only the
 * latest run's diff. Because a single day sees many runs, this script keeps a
 * same-day accumulator (dist/meta/today-changes.json) so a change caught at
 * 9am is still on the graphic at 3pm even though changes.json has since moved
 * on to unrelated diffs. Each item is also enriched from dist/meta/diff-snapshot.json
 * (the full current event list fetch.js just wrote) so cards can show the
 * authoritative current time/location/home-away even for change types
 * (postponed, cancelled, etc.) whose slim changes.json record doesn't carry them.
 *
 * Usage: node scripts/build-today-graphic.js
 * Run this right after fetch.js in the pipeline. No-ops (and removes any
 * stale graphic) when there are no changes affecting today's events.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DateTime } from 'luxon';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const META_DIR         = path.join(ROOT, 'dist', 'meta');
const CHANGES_PATH     = path.join(META_DIR, 'changes.json');
const SNAPSHOT_PATH    = path.join(META_DIR, 'diff-snapshot.json');
const TODAY_PATH       = path.join(META_DIR, 'today-changes.json');
const OUTPUT_PATH      = path.join(ROOT, 'dist', 'today-changes.png');

const FONTS_DIR = path.join(ROOT, 'assets', 'fonts');
const LOGO_PATH = path.join(ROOT, 'assets', 'images', 'poland-bulldogs-logo.png');

const NAVY       = '#00328f';
const NAVY_DARK  = '#001f57';
const NAVY_MID   = '#284a9e'; // accent line between navy tones — keeps header/footer off pure-flat
const INK        = '#111827';
const GREY       = '#5b6472';
const GREY_LIGHT = '#8792a3';
const HAIRLINE   = '#e3e7ef';
const TINT       = '#c9d6f5';

const MAX_CARDS = 6;

// ── Accumulate today's changes ──────────────────────────────────────────────

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return fallback; }
}

// One human-readable summary + status tag per changed event.
function classify(entry, kind, today) {
  const base = {
    eventId: entry.eventId,
    sport: entry.sport,
    levelLabel: entry.levelLabel,
    vsOrAt: entry.vsOrAt,
    opponentComplete: entry.opponentComplete,
  };

  if (kind === 'removed') {
    return { ...base, status: 'removed', detail: `${entry.vsOrAt} ${entry.opponentComplete}` };
  }
  if (kind === 'added') {
    return { ...base, status: 'added', detail: `${entry.vsOrAt} ${entry.opponentComplete}` };
  }

  // kind === 'changed' — only relevant if it still concerns today's game.
  if (entry.eventDate !== today) return null;

  const fields = entry.fields || [];
  if (fields.includes('isCancelled')) {
    return entry.isCancelled
      ? { ...base, status: 'cancelled', detail: `${entry.vsOrAt} ${entry.opponentComplete}` }
      : { ...base, status: 'restored', detail: `Game is back on — ${entry.vsOrAt} ${entry.opponentComplete}` };
  }
  if (fields.includes('isPostponed')) {
    return entry.isPostponed
      ? { ...base, status: 'postponed', detail: `${entry.vsOrAt} ${entry.opponentComplete}` }
      : { ...base, status: 'restored', detail: `${entry.vsOrAt} ${entry.opponentComplete}` };
  }
  if (fields.includes('eventTime')) {
    return {
      ...base, status: 'time-changed', detail: `${entry.vsOrAt} ${entry.opponentComplete}`,
      timeBefore: entry.before?.eventTime, timeAfter: entry.after?.eventTime,
    };
  }
  if (fields.includes('location')) {
    return {
      ...base, status: 'location-changed', detail: `${entry.vsOrAt} ${entry.opponentComplete}`,
      locationBefore: entry.before?.location, locationAfter: entry.after?.location,
    };
  }
  return null;
}

// Fields pulled from the full current snapshot to fill in whatever the slim
// changes.json record didn't carry (e.g. a postponed-flag change doesn't
// include eventTime, but the card still needs it front and center).
const SNAPSHOT_FIELDS = ['eventTime', 'isTimeTBD', 'homeOrAway', 'vsOrAt', 'opponentComplete', 'location', 'sport', 'levelLabel'];

function enrichFromSnapshot(items, today) {
  const snapshot = loadJson(SNAPSHOT_PATH, []);
  const byId = Object.fromEntries(snapshot.map(e => [e.eventId, e]));

  return items.map(item => {
    const current = byId[item.eventId];
    if (!current || current.eventDate !== today) return item;
    const fill = Object.fromEntries(SNAPSHOT_FIELDS.map(f => [f, current[f]]));
    return { ...fill, ...item };
  });
}

function updateTodayAccumulator(today) {
  const diff = loadJson(CHANGES_PATH, { added: [], removed: [], changed: [] });

  let accumulator = loadJson(TODAY_PATH, null);
  if (!accumulator || accumulator.date !== today) accumulator = { date: today, items: {} };

  const candidates = [
    ...diff.added.filter(e => e.eventDate === today).map(e => classify(e, 'added', today)),
    ...diff.removed.filter(e => e.eventDate === today).map(e => classify(e, 'removed', today)),
    ...diff.changed.map(e => classify(e, 'changed', today)),
  ].filter(Boolean);

  for (const item of candidates) {
    // Later runs win for status/detail, but keep remembering the same eventId
    // across the day so a game that moves twice still shows one card. If an
    // earlier run already captured the original pre-change time, keep that
    // as timeBefore so a game moved twice still shows its true original slot.
    const prior = accumulator.items[item.eventId];
    const merged = { ...prior, ...item };
    if (prior?.timeBefore && item.timeBefore) merged.timeBefore = prior.timeBefore;
    accumulator.items[item.eventId] = merged;
  }

  fs.writeFileSync(TODAY_PATH, JSON.stringify(accumulator, null, 2));
  return enrichFromSnapshot(Object.values(accumulator.items), today);
}

// ── Rendering ────────────────────────────────────────────────────────────────

const STATUS_STYLE = {
  cancelled:          { bg: '#fbe9e8', fg: '#a4241d', label: 'CANCELED' },
  postponed:          { bg: '#fdf1de', fg: '#9c5a09', label: 'POSTPONED' },
  'time-changed':     { bg: '#e6ecfa', fg: NAVY,      label: 'TIME CHANGED' },
  'location-changed': { bg: '#e6ecfa', fg: NAVY,      label: 'LOCATION CHANGED' },
  added:              { bg: '#e5f4ea', fg: '#1c7a41', label: 'NEW' },
  removed:            { bg: '#eceef1', fg: '#4b5361', label: 'REMOVED' },
  restored:           { bg: '#e5f4ea', fg: '#1c7a41', label: 'RESTORED' },
};

function h(type, props = {}, ...children) {
  const flat = children.flat().filter(c => c !== null && c !== undefined && c !== false);
  return { type, props: { ...props, children: flat.length ? flat : props.children } };
}

// Splits "6:00 PM" into ["6:00", "PM"] so the meridiem can be set smaller —
// how real scoreboard/schedule type treats clock times.
function splitTime(time) {
  const m = /^(\d{1,2}:\d{2})\s*(AM|PM)$/i.exec((time || '').trim());
  return m ? [m[1], m[2].toUpperCase()] : [time, ''];
}

function timeBlock(time, { size = 44, color = INK, meridiemColor } = {}) {
  const [clock, meridiem] = splitTime(time);
  return h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '6px' } },
    h('div', { style: { fontSize: `${size}px`, fontWeight: 800, color, letterSpacing: '-0.5px', display: 'flex' } }, clock || '—'),
    meridiem ? h('div', {
      style: { fontSize: `${Math.round(size * 0.4)}px`, fontWeight: 700, color: meridiemColor || color, display: 'flex' },
    }, meridiem) : null,
  );
}

function homeAwayTag(homeOrAway) {
  const isHome = homeOrAway === 'Home';
  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minWidth: '96px', padding: '9px 16px', borderRadius: '9px',
      backgroundColor: isHome ? '#dde7fa' : '#eef0f3',
      color: isHome ? NAVY : GREY,
      fontSize: '17px', fontWeight: 700, letterSpacing: '0.5px',
    },
  }, isHome ? 'HOME' : 'AWAY');
}

function statusChip(status) {
  const style = STATUS_STYLE[status] || STATUS_STYLE['time-changed'];
  return h('div', {
    style: {
      display: 'flex', backgroundColor: style.bg, color: style.fg,
      borderRadius: '9px', padding: '9px 18px', fontSize: '16px',
      fontWeight: 700, letterSpacing: '0.5px',
    },
  }, style.label);
}

// The "what changed" line, tailored per status — this is the drier,
// schedule-table register the rest of the card borrows from. Time changes
// already get their own before/after treatment in the time column, so this
// line just stays the plain opponent line for them (no need to repeat it).
function detailLine(item, size) {
  const style = { fontSize: `${size}px`, fontWeight: 500, color: GREY, display: 'flex' };
  if (item.status === 'location-changed' && item.locationAfter) {
    return h('div', { style }, `Now at ${item.locationAfter}`);
  }
  return h('div', { style }, `${item.vsOrAt} ${item.opponentComplete}`);
}

// Sizing tiers keyed by how many cards need to fit in the fixed body height —
// keeps 5-6 changes from overflowing into the footer while letting 1-3
// changes breathe with larger type.
const CARD_TIERS = [
  { max: 3, sportSize: 30, detailSize: 22, timeSize: 50, padding: '30px 34px', gap: 22 },
  { max: 4, sportSize: 26, detailSize: 20, timeSize: 42, padding: '22px 32px', gap: 16 },
  { max: 6, sportSize: 22, detailSize: 18, timeSize: 33, padding: '15px 28px', gap: 9 },
];

function buildTree({ items, dateLabel, updatedLabel, logoDataUri }) {
  const shown = items.slice(0, MAX_CARDS);
  const overflow = items.length - shown.length;
  const tier = CARD_TIERS.find(t => shown.length <= t.max) || CARD_TIERS[CARD_TIERS.length - 1];

  const { sportSize, detailSize, timeSize, gap: cardGap } = tier;
  const cardPadding = tier.padding;

  const decorCircle = (extra) => h('div', {
    style: {
      position: 'absolute', width: '520px', height: '520px', borderRadius: '999px',
      backgroundColor: 'rgba(255,255,255,0.06)', display: 'flex', ...extra,
    },
  });

  return h('div', {
    style: {
      width: '1080px', height: '1080px', display: 'flex', flexDirection: 'column',
      backgroundColor: '#ffffff', fontFamily: 'Public Sans',
    },
  },
    // Header
    h('div', { style: { display: 'flex', flexDirection: 'column' } },
      h('div', {
        style: {
          position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center',
          gap: '38px', padding: '58px 64px 50px', backgroundImage: `linear-gradient(135deg, ${NAVY} 0%, ${NAVY_DARK} 100%)`,
        },
      },
        decorCircle({ top: '-260px', right: '-140px' }),
        decorCircle({ bottom: '-320px', left: '-180px', width: '420px', height: '420px', backgroundColor: 'rgba(255,255,255,0.045)' }),
        h('div', {
          style: {
            width: '168px', height: '168px', borderRadius: '999px', backgroundColor: '#ffffff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            boxShadow: '0 14px 30px rgba(0,15,50,0.45)',
          },
        },
          h('img', { src: logoDataUri, width: 122, height: 122 }),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
          h('div', {
            style: {
              fontSize: '19px', fontWeight: 700, color: TINT, letterSpacing: '3px',
              textTransform: 'uppercase', display: 'flex',
            },
          }, 'Poland Bulldogs Athletics'),
          h('div', {
            style: {
              fontSize: '60px', fontWeight: 900, color: '#ffffff', lineHeight: 1.02,
              letterSpacing: '-1.5px', display: 'flex',
            },
          }, "Today's Schedule Changes"),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px' } },
            h('div', { style: { width: '34px', height: '4px', borderRadius: '2px', backgroundColor: NAVY_MID, display: 'flex' } }),
            h('div', { style: { fontSize: '23px', fontWeight: 600, color: TINT, display: 'flex' } }, dateLabel),
          ),
        ),
      ),
      h('div', { style: { display: 'flex', height: '6px', backgroundColor: NAVY_MID } }),
    ),
    // Body
    h('div', {
      style: {
        flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center',
        gap: `${cardGap}px`, padding: '36px 60px', backgroundColor: '#ffffff',
      },
    },
      ...shown.map(item => h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '26px',
          backgroundColor: '#ffffff', border: `1.5px solid ${HAIRLINE}`,
          borderRadius: '16px', padding: cardPadding,
        },
      },
        homeAwayTag(item.homeOrAway),
        h('div', { style: { width: '1.5px', alignSelf: 'stretch', backgroundColor: HAIRLINE, display: 'flex' } }),
        h('div', { style: { display: 'flex', width: '182px', flexShrink: 0 } },
          item.status === 'time-changed'
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                timeBlock(item.timeBefore, { size: Math.round(timeSize * 0.5), color: GREY_LIGHT }),
                timeBlock(item.timeAfter, { size: timeSize, color: NAVY }),
              )
            : timeBlock(item.isTimeTBD ? 'TBD' : item.eventTime, { size: timeSize, color: INK }),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 } },
          h('div', { style: { fontSize: `${sportSize}px`, fontWeight: 700, color: INK, display: 'flex' } },
            `${item.sport} — ${item.levelLabel}`),
          detailLine(item, detailSize),
        ),
        statusChip(item.status),
      )),
      overflow > 0 ? h('div', {
        style: { fontSize: '19px', fontWeight: 600, color: GREY_LIGHT, display: 'flex', paddingTop: '2px' },
      }, `+${overflow} more update${overflow === 1 ? '' : 's'} — full schedule online`) : null,
    ),
    // Footer
    h('div', { style: { display: 'flex', flexDirection: 'column' } },
      h('div', { style: { display: 'flex', height: '6px', backgroundColor: NAVY_MID } }),
      h('div', {
        style: {
          position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', padding: '0 64px', height: '104px',
          backgroundImage: `linear-gradient(135deg, ${NAVY_DARK} 0%, ${NAVY} 100%)`,
        },
      },
        decorCircle({ top: '-380px', right: '120px', width: '460px', height: '460px' }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '16px' } },
          h('img', { src: logoDataUri, width: 40, height: 40 }),
          h('div', {
            style: { fontSize: '23px', fontWeight: 700, color: '#ffffff', letterSpacing: '0.5px', display: 'flex' },
          }, 'polandathletics.com'),
        ),
        h('div', {
          style: { fontSize: '18px', fontWeight: 600, color: TINT, letterSpacing: '0.3px', display: 'flex' },
        }, updatedLabel),
      ),
    ),
  );
}

async function render(items, now) {
  const fonts = [
    { name: 'Public Sans', weight: 400, style: 'normal', data: fs.readFileSync(path.join(FONTS_DIR, 'PublicSans-Regular.ttf')) },
    { name: 'Public Sans', weight: 500, style: 'normal', data: fs.readFileSync(path.join(FONTS_DIR, 'PublicSans-Medium.ttf')) },
    { name: 'Public Sans', weight: 600, style: 'normal', data: fs.readFileSync(path.join(FONTS_DIR, 'PublicSans-SemiBold.ttf')) },
    { name: 'Public Sans', weight: 700, style: 'normal', data: fs.readFileSync(path.join(FONTS_DIR, 'PublicSans-Bold.ttf')) },
    { name: 'Public Sans', weight: 800, style: 'normal', data: fs.readFileSync(path.join(FONTS_DIR, 'PublicSans-ExtraBold.ttf')) },
    { name: 'Public Sans', weight: 900, style: 'normal', data: fs.readFileSync(path.join(FONTS_DIR, 'PublicSans-Black.ttf')) },
  ];

  const logoDataUri = `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString('base64')}`;

  const dateLabel = now.toFormat('cccc, LLLL d');
  const updatedLabel = `Updated ${now.toFormat('h:mm a ZZZZ')}`;

  const tree = buildTree({ items, dateLabel, updatedLabel, logoDataUri });

  const svg = await satori(tree, { width: 1080, height: 1080, fonts });

  // Rasterize at 2x for crisper text on high-density feeds/screens.
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 2160 } });
  return resvg.render().asPng();
}

async function main() {
  const now = DateTime.now().setZone('America/New_York');
  const today = now.toISODate();

  const items = updateTodayAccumulator(today);

  if (items.length === 0) {
    if (fs.existsSync(OUTPUT_PATH)) fs.unlinkSync(OUTPUT_PATH);
    console.log('No changes affecting today — no graphic generated.\n');
    return;
  }

  const png = await render(items, now);
  fs.writeFileSync(OUTPUT_PATH, png);
  console.log(`Wrote ${OUTPUT_PATH} (${items.length} change${items.length === 1 ? '' : 's'} today).\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
