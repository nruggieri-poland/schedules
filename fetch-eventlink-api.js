import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';
import {
  parseEvent, writeLevel, writeIcal, writeChangelog, logDiff,
  validateOpponents, diffEvents, sortByDateTime, buildTeamSlugIndex,
  parseTeamsCsv, applyHomeVenueOverrides, TEAMS_DIR, ROLLUPS_DIR, META_DIR,
  ICS_DIR, ICS_GROUPS_DIR, DIFF_SNAPSHOT_PATH, ICAL_GROUPS, MIN_KEPT_RATIO,
  MIN_VEVENTS_FOR_RATIO_CHECK,
} from './fetch.js';

// This is a mirror of fetch.js that sources events from EventLink's JSON
// widget API (GetByCalendarIDsWithToken) instead of the iCal export feed.
// It reuses fetch.js's parseEvent()/writeLevel()/diff/changelog pipeline
// UNCHANGED — the only thing this file does differently is turn each API
// record into the same {uid, summary, description, location, status, dtstart}
// shape parseVevents() produces from iCal text, so parseEvent() can't tell
// the difference. That's what keeps dist/ output byte-for-byte the same
// shape regardless of which source produced it.
//
// Meant to run BEFORE fetch.js in the workflow (`node fetch-eventlink-api.js
// || node fetch.js`) — any failure here (missing env, bad response, the same
// kept-ratio sanity guard fetch.js uses) throws and lets fetch.js's proven
// iCal path run instead. fetch.js itself is untouched by this file.

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Comma-separated list of EventLink calendar IDs (one per team) + the org
// token, both pulled from the widget's own network request — see the repo
// notes for how these were captured. Never hardcode them here: this repo is
// public, so anything hardcoded is exposed in git history forever.
const API_TOKEN       = process.env.EVENTLINK_API_TOKEN;
const API_CALENDAR_IDS = process.env.EVENTLINK_CALENDAR_IDS; // comma-separated
const FETCH_TIMEOUT_MS = 30_000;

function buildApiUrl() {
  const ids = API_CALENDAR_IDS.split(',').map(s => s.trim()).filter(Boolean);
  const params = new URLSearchParams();
  params.set('a', 'GetByCalendarIDsWithToken');
  params.set('m', 'Event');
  params.set('token', API_TOKEN);
  params.set('tz', 'America/New_York');
  // Generous window (±1 year from today) so every current/upcoming season is
  // covered regardless of when in the school year this runs — cheap: a
  // 2-year pull came back in ~2MB/well under a second in testing.
  const now = DateTime.now().setZone('America/New_York');
  params.set('start', now.minus({ years: 1 }).toISODate());
  params.set('end', now.plus({ years: 1 }).toISODate());
  const base = `https://api.eventlink.com/?${params.toString()}`;
  return base + ids.map(id => `&ids=${encodeURIComponent(id)}`).join('');
}

async function fetchApiRecords() {
  if (!API_TOKEN) throw new Error('EVENTLINK_API_TOKEN environment variable is not set.');
  if (!API_CALENDAR_IDS) throw new Error('EVENTLINK_CALENDAR_IDS environment variable is not set.');

  console.log('Fetching EventLink API…');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(buildApiUrl(), {
      headers: {
        'User-Agent': 'pshs-schedule-proxy/3.0',
        'accept': 'application/json, text/plain, */*',
        'origin': 'https://widget.eventlink.com',
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`EventLink API ${res.status} ${res.statusText}`);
    const json = await res.json();
    if (json.Error) throw new Error(`EventLink API returned an error: ${json.Error}`);
    if (!Array.isArray(json.Data)) throw new Error('EventLink API response missing Data array.');
    console.log(`Received ${json.Data.length} records`);
    return json.Data;
  } finally {
    clearTimeout(timeout);
  }
}

// iCal escapes literal commas inside a TEXT value as "\," (see fetch.js's
// splitOpponentNames) — the API's plain Title field doesn't, so re-escape
// here to keep that downstream splitter working unmodified for multi-team
// meets (e.g. "Niles McKinley High School, Girard Sr High School").
function escapeCommas(title) {
  return title.replace(/,\s*/g, '\\,');
}

// The real opponent name (record.Title) and the Scrimmage/Practice/Game
// classification are independent facts in the actual data — checked a full
// year of scrimmages and 16/17 kept a real opponent name (e.g. "Streetsboro
// High School") alongside EventType:"Scrimmage"; only one had no named
// opponent at all. So the opponent text is passed through untouched here;
// eventType is overridden separately after parseEvent() runs (see main()),
// straight from the API's own clean EventType field rather than by smuggling
// a "Scrimmage"/"Practice" marker into the text classifyEventType() scans —
// doing that would corrupt the opponent name for every classified event.
function buildOpponentText(record) {
  return escapeCommas(record.Title || '');
}

// Converts an EventLink API DTSTART-equivalent into the same
// { type: 'date' | 'datetime', value } shape parseVevents() builds from raw
// iCal text, so parseEvent()'s existing DTSTART-branch logic (which already
// handles TBD/all-day vs timed, and UTC vs floating-local) runs unmodified.
function buildDtstart(record) {
  if (record.IsAllDay) {
    const d = DateTime.fromISO(record.StartDateTime, { setZone: true });
    return { type: 'date', value: d.toFormat('yyyyLLdd') };
  }
  // StartDateTime arrives as "2026-08-07T10:00:00-04" (explicit offset, the
  // true intended local time) — convert to UTC and hand parseEvent() the
  // same compact "...Z" form it already knows how to convert back to Eastern.
  const d = DateTime.fromISO(record.StartDateTime, { setZone: true }).toUTC();
  if (!d.isValid) return null;
  return { type: 'datetime', value: d.toFormat("yyyyLLdd'T'HHmmss'Z'") };
}

// Adapts one EventLink API record into the vevent shape parseEvent() expects.
// description is intentionally left null — the API's Title already carries
// the full (comma-joined) opponent text parseEvent()'s SUMMARY-tail fallback
// path needs, so there's no reason to also route through its DESCRIPTION
// "Opponent(s):" path (and doing so would double-escape the comma list).
function adaptRecordToVevent(record) {
  const dtstart = buildDtstart(record);
  if (!dtstart) return null;
  return {
    uid:         record.ID,
    summary:     `${record.Team?.Title ?? ''} ${buildOpponentText(record)}`,
    description: null,
    location:    record.Location || null,
    status:      record.CancelDateTime ? 'CANCELLED' : null,
    dtstart,
  };
}

async function main() {
  for (const dir of [TEAMS_DIR, ROLLUPS_DIR, META_DIR, ICS_DIR, ICS_GROUPS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const prevEvents = fs.existsSync(DIFF_SNAPSHOT_PATH)
    ? JSON.parse(fs.readFileSync(DIFF_SNAPSHOT_PATH, 'utf-8'))
    : [];

  const opponents = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'opponents.json'), 'utf-8')
  );
  validateOpponents(opponents);

  const juniorHighOpponents = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'junior-high-opponents.json'), 'utf-8')
  );
  validateOpponents(juniorHighOpponents);

  const teamRows = parseTeamsCsv(
    fs.readFileSync(path.join(__dirname, 'pshs-athletics-teams.csv'), 'utf-8')
  );
  if (teamRows.length === 0) throw new Error('pshs-athletics-teams.csv is empty');
  const teamIndex = buildTeamSlugIndex(teamRows);

  const records = await fetchApiRecords();

  if (records.length === 0) {
    throw new Error('EventLink API returned zero records — aborting before overwriting existing data.');
  }

  const seenUids = new Set();
  const vevents  = [];
  const apiEventTypeByUid = new Map();
  for (const record of records) {
    const v = adaptRecordToVevent(record);
    if (!v) { console.warn(`  [unparseable StartDateTime] ${record.Title} (id=${record.ID})`); continue; }
    if (!v.uid) {
      const sig = `${v.summary}|${v.dtstart?.value ?? ''}|${v.location ?? ''}`;
      v.uid     = 'pshs-syn-' + createHash('sha1').update(sig).digest('hex').slice(0, 16);
    }
    if (seenUids.has(v.uid)) { console.warn(`  [duplicate UID] ${v.uid}`); continue; }
    seenUids.add(v.uid);
    apiEventTypeByUid.set(v.uid, record.EventType);
    vevents.push(v);
  }

  const events = vevents
    .map(v => parseEvent(v, opponents, juniorHighOpponents, teamIndex))
    .filter(Boolean)
    .map(applyHomeVenueOverrides);

  // Override eventType straight from the API's own clean field rather than
  // trusting classifyEventType()'s regex-on-opponent-text guess — see
  // buildOpponentText()'s comment for why the opponent text can't carry this
  // marker itself. Recompute conferenceGame too: it's derived from eventType
  // === 'Game' inside parseEvent, so downgrading Game → Scrimmage/Practice
  // here has to zero it out the same way parseEvent would have.
  for (const e of events) {
    const apiType = apiEventTypeByUid.get(e.eventId);
    if (apiType === 'Scrimmage' || apiType === 'Practice') {
      e.eventType = apiType;
      e.conferenceGame = false;
    }
  }
  console.log(`Kept ${events.length} events after filtering\n`);

  const keptRatio = events.length / vevents.length;
  if (vevents.length > MIN_VEVENTS_FOR_RATIO_CHECK && keptRatio < MIN_KEPT_RATIO) {
    throw new Error(
      `Only kept ${events.length}/${vevents.length} events (${Math.round(keptRatio * 100)}%) — ` +
      `likely an EventLink API format change, aborting before overwriting existing data.`
    );
  }

  const today = new Date().toISOString().split('T')[0];

  const byLevel = {};
  for (const e of events) {
    (byLevel[e.levelSlug] ??= {})[e.sportSlug] ??= [];
    byLevel[e.levelSlug][e.sportSlug].push(e);
  }

  const allIndexEntries = [];
  for (const [levelSlug, bySport] of Object.entries(byLevel)) {
    allIndexEntries.push(...writeLevel(levelSlug, bySport, today));
  }

  allIndexEntries.sort((a, b) => {
    const order = ['varsity', 'jv-freshman', 'junior-high'];
    return (order.indexOf(a.levelGroup) - order.indexOf(b.levelGroup))
      || a.sport.localeCompare(b.sport)
      || a.level.localeCompare(b.level);
  });
  fs.writeFileSync(path.join(META_DIR, 'index.json'), JSON.stringify(allIndexEntries, null, 2));
  console.log(`index.json → ${allIndexEntries.length} entries`);

  const allEvents = sortByDateTime(events);
  const diff = diffEvents(prevEvents, allEvents);
  console.log('--- Change detection ---');
  logDiff(diff);
  fs.writeFileSync(DIFF_SNAPSHOT_PATH, JSON.stringify(allEvents, null, 2));

  if (diff.added.length || diff.removed.length || diff.changed.length) {
    writeChangelog(diff);
  } else {
    console.log('No changes — leaving changes.json/changelog.json untouched.\n');
  }

  for (const group of ICAL_GROUPS) {
    const filtered = events.filter(
      e => !e.isCancelled && (group.levels === null || group.levels.includes(e.levelSlug))
    );
    writeIcal(filtered, path.join(ICS_GROUPS_DIR, group.file), group.name);
    console.log(`groups/${group.file} → ${filtered.length} events`);
  }

  const eventsByTeamSlug = {};
  for (const e of events) {
    const slug = e.teamSlug ?? `${e.levelSlug}-${e.sportSlug}`;
    (eventsByTeamSlug[slug] ??= []).push(e);
  }
  for (const [slug, list] of Object.entries(eventsByTeamSlug)) {
    const { sport, levelLabel } = list[0];
    writeIcal(list, path.join(ICS_DIR, `${slug}.ics`), `PSHS Athletics – ${sport} (${levelLabel})`);
  }
  console.log(`${Object.keys(eventsByTeamSlug).length} per-team .ics files written`);

  fs.writeFileSync(path.join(META_DIR, 'status.json'), JSON.stringify({
    fetchedAt:  new Date().toISOString(),
    source:     'eventlink-api',
    records:    records.length,
    kept:       events.length,
    hasChanges: diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0,
  }, null, 2));

  console.log('\nDone (source: EventLink API).');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
