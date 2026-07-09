import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ical from 'ical-generator';
import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Paths & runtime constants ─────────────────────────────────────────────────

// dist/ layout — kept deliberately separated so "give me one team's schedule"
// and "give me an aggregate view" are never mixed in the same directory:
//   teams/    one JSON + one CSV per team (the canonical, site-consumed files)
//   rollups/  per-level conglomerate views (combined/upcoming/cancelled-today)
//   ics/      one .ics per team, plus ics/groups/ for the broader multi-team calendars
//   meta/     pipeline bookkeeping (index, status, diff/changelog) — not schedule data
const DIST_DIR       = path.join(__dirname, 'dist');
const TEAMS_DIR      = path.join(DIST_DIR, 'teams');
const ROLLUPS_DIR    = path.join(DIST_DIR, 'rollups');
const META_DIR       = path.join(DIST_DIR, 'meta');
const ICS_DIR        = path.join(DIST_DIR, 'ics');
const ICS_GROUPS_DIR = path.join(ICS_DIR, 'groups');
const HOME_VENUE     = 'Poland Seminary High School';

// Several sports aren't actually played at the school building EventLink
// stamps as the home-event LOCATION (used above for home/away detection).
// Each rule below only overrides that generic placeholder for home events —
// away locations, and any home event where EventLink already noted something
// more specific, are left alone (see applyHomeVenueOverrides).
const GOLF_SPORT_SLUGS = new Set(['boys-golf', 'girls-golf']);
const JR_HIGH_COURT_SPORT_SLUGS = new Set(['boys-basketball', 'girls-basketball', 'volleyball']);
const HOME_VENUE_OVERRIDES = [
  { venue: 'Knoll Run Golf Course', matches: e => GOLF_SPORT_SLUGS.has(e.sportSlug) },
  { venue: 'Poland Middle School',  matches: e => e.levelGroup === 'junior-high' && JR_HIGH_COURT_SPORT_SLUGS.has(e.sportSlug) },
  { venue: 'Poland Township Park', matches: e => e.sportSlug === 'cross-country' },
];

// Feed URL (contains an access token) lives in CI secrets / a local .env file,
// never in source — this repo is public, so anything hardcoded here is exposed
// in git history forever.
const ICAL_URL = process.env.EVENTLINK_ICAL_URL;

const DIFF_SNAPSHOT_PATH     = path.join(META_DIR, 'diff-snapshot.json');
const CHANGELOG_PATH         = path.join(META_DIR, 'changelog.json');
const CHANGELOG_MAX_ENTRIES  = 200;
const FETCH_TIMEOUT_MS       = 30_000;

// Below this fraction of VEVENTs surviving parseEvent (when the feed has a
// meaningful number of events), assume a feed/format regression rather than a
// real schedule and abort before overwriting existing data.
const MIN_KEPT_RATIO             = 0.5;
const MIN_VEVENTS_FOR_RATIO_CHECK = 50;

// ── Sport & level lookup tables ───────────────────────────────────────────────

// Keyed on "Sport (Gender)" — level code is parsed separately.
// season: which of Poland's three OHSAA sport seasons (Fall/Winter/Spring).
const SPORT_BASE_MAP = {
  'Baseball (Boys)':       { slug: 'baseball',        title: 'Baseball',         season: 'Spring' },
  'Basketball (Boys)':     { slug: 'boys-basketball',  title: 'Boys Basketball',  season: 'Winter' },
  'Basketball (Girls)':    { slug: 'girls-basketball', title: 'Girls Basketball', season: 'Winter' },
  'Cheerleading (Girls)':  { slug: 'cheerleading',     title: 'Cheerleading',     season: 'Fall'   },
  'Cross Country (Coed)':  { slug: 'cross-country',    title: 'Cross Country',    season: 'Fall'   },
  'Football (Boys)':       { slug: 'football',         title: 'Football',         season: 'Fall'   },
  'Golf (Boys)':           { slug: 'boys-golf',        title: 'Boys Golf',        season: 'Fall'   },
  'Golf (Girls)':          { slug: 'girls-golf',       title: 'Girls Golf',       season: 'Fall'   },
  'Lacrosse (Boys)':       { slug: 'boys-lacrosse',    title: 'Boys Lacrosse',    season: 'Spring' },
  'Lacrosse (Girls)':      { slug: 'girls-lacrosse',   title: 'Girls Lacrosse',   season: 'Spring' },
  'Soccer (Boys)':         { slug: 'boys-soccer',      title: 'Boys Soccer',      season: 'Fall'   },
  'Soccer (Girls)':        { slug: 'girls-soccer',     title: 'Girls Soccer',     season: 'Fall'   },
  'Softball (Girls)':      { slug: 'softball',         title: 'Softball',         season: 'Spring' },
  'Swimming (Coed)':       { slug: 'swim-dive',        title: 'Swim & Dive',      season: 'Winter' },
  'Swim & Dive (Coed)':    { slug: 'swim-dive',        title: 'Swim & Dive',      season: 'Winter' },
  'Tennis (Boys)':         { slug: 'boys-tennis',      title: 'Boys Tennis',      season: 'Spring' },
  'Tennis (Girls)':        { slug: 'girls-tennis',     title: 'Girls Tennis',     season: 'Fall'   },
  'Track & Field (Coed)':  { slug: 'track-field',      title: 'Track & Field',    season: 'Spring' },
  'Volleyball (Girls)':    { slug: 'volleyball',       title: 'Volleyball',       season: 'Fall'   },
  'Wrestling (Boys)':      { slug: 'boys-wrestling',   title: 'Boys Wrestling',   season: 'Winter' },
  'Wrestling (Girls)':     { slug: 'girls-wrestling',  title: 'Girls Wrestling',  season: 'Winter' },
};

// Level codes as they appear in iCal SUMMARY parentheses.
const LEVEL_MAP = {
  'V':  { slug: 'varsity',  label: 'Varsity',       group: 'varsity'     },
  'JV': { slug: 'jv',       label: 'JV',            group: 'jv-freshman' },
  'F':  { slug: 'freshman', label: 'Freshman',      group: 'jv-freshman' },
  '8':  { slug: '8th',      label: '8th Grade',     group: 'junior-high' },
  '7':  { slug: '7th',      label: '7th Grade',     group: 'junior-high' },
  'MS': { slug: 'ms',       label: 'Middle School', group: 'junior-high' },
};

// The four iCal files to produce. levels: null = all events.
const ICAL_GROUPS = [
  { name: 'PSHS Athletics',                  file: 'pshs-all.ics',         levels: null },
  { name: 'PSHS Athletics – Varsity',        file: 'pshs-athletics.ics',   levels: ['varsity'] },
  { name: 'PSHS Athletics – JV & Freshman',  file: 'pshs-jv-freshman.ics', levels: ['jv', 'freshman'] },
  { name: 'PSHS Athletics – Junior High',    file: 'pshs-junior-high.ics', levels: ['7th', '8th', 'ms'] },
];

// ── Team registry (pshs-athletics-teams.csv) ─────────────────────────────────

// fetch.js's sport.title / levelLabel values that don't match the CSV's
// "Sport" / "Levels" columns verbatim.
const CSV_SPORT_ALIASES = { 'Swim & Dive': 'Swimming & Diving' };
const CSV_LEVEL_ALIASES = { 'JV': 'Junior Varsity', 'Middle School': 'Junior High' };

function parseTeamsCsv(text) {
  const lines  = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    return Object.fromEntries(header.map((h, i) => [h, (cols[i] ?? '').trim()]));
  });
}

function buildTeamSlugIndex(rows) {
  const index = new Map();
  for (const row of rows) index.set(`${row.Sport}|${row.Levels}`, row.Slug);
  return index;
}

const warnedUnmatchedTeams = new Set();

// Resolves the canonical team-page slug (e.g. "football-varsity") for a parsed
// event's sport/level. 7th/8th grade sports that don't split by grade fall back
// to the CSV's combined "Junior High" row. Returns null (warning once per
// distinct combo) when the team isn't in the registry — likely naming drift
// between EventLink and pshs-athletics-teams.csv that needs reconciling by hand.
function resolveTeamSlug(teamIndex, sportTitle, levelLabel) {
  const csvSport = CSV_SPORT_ALIASES[sportTitle] ?? sportTitle;
  const csvLevel = CSV_LEVEL_ALIASES[levelLabel] ?? levelLabel;

  let slug = teamIndex.get(`${csvSport}|${csvLevel}`);
  if (!slug && (levelLabel === '8th Grade' || levelLabel === '7th Grade')) {
    slug = teamIndex.get(`${csvSport}|Junior High`);
  }
  if (!slug) {
    const key = `${csvSport}|${csvLevel}`;
    if (!warnedUnmatchedTeams.has(key)) {
      warnedUnmatchedTeams.add(key);
      console.warn(`  [unmatched team] no entry in pshs-athletics-teams.csv for "${sportTitle}" / "${levelLabel}"`);
    }
  }
  return slug ?? null;
}

// ── Pure utility ──────────────────────────────────────────────────────────────

// School year runs 07/01–06/30. Season label: Fall = start year, Winter = both
// years, Spring = end year — e.g. school year 2026-2027 → Fall "2026",
// Winter "2026-2027", Spring "2027".
function computeSeason(eventDate, sportSeason) {
  const [year, month] = eventDate.split('-').map(Number);
  const schoolYearStart = month >= 7 ? year : year - 1;
  if (sportSeason === 'Fall')   return `${schoolYearStart}`;
  if (sportSeason === 'Winter') return `${schoolYearStart}-${schoolYearStart + 1}`;
  return `${schoolYearStart + 1}`; // Spring
}

function normalizeTitle(title) {
  const noDisambig = title.replace(/\s*\([^)]+\)\s*$/, '').trim();
  return noDisambig
    .replace(/\s+Sr\.?\s+High\s+School$/i, ' High School')
    .replace(/\s+Jr\.?\s*\/?\s*Sr\.?\s+High\s+School$/i, ' High School')
    .replace(/\s+H\.S\.$|(?<!\w)HS$/i, ' High School')
    .replace(/\./g, '')
    .trim();
}

function resolveOpponent(title, opponents, quiet = false) {
  for (const attempt of [title, normalizeTitle(title)]) {
    if (opponents[attempt]) return { conference: false, ...opponents[attempt], matched: true };
  }
  if (!quiet) console.warn(`  [unmatched] ${JSON.stringify(title)}`);
  return { name: title, mascot: null, matched: false, conference: false };
}

// Some sports (track & field, swim & dive, golf, wrestling) list every
// participating school in one string instead of a single opponent — iCal
// escapes the literal separator comma as "\,". Splits into individual names;
// a plain single-opponent title (no "\,") comes back as a one-element array,
// so this is a no-op for every normal dual-meet event.
function splitOpponentNames(title) {
  return title.split('\\,').map(s => s.trim()).filter(Boolean);
}

function validateOpponents(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('opponents.json must be a plain object');
  if (Object.keys(data).length === 0)
    throw new Error('opponents.json is empty');
  for (const [key, val] of Object.entries(data)) {
    if (!val || typeof val.name !== 'string')
      throw new Error(`opponents.json: entry "${key}" is missing a name string`);
  }
}

// Classify the non-opponent placeholder events (practices, scrimmages) that
// EventLink mixes into the same feed as real games.
function classifyEventType(opponentTitle) {
  if (/^practice\b/i.test(opponentTitle)) return 'Practice';
  if (/\bscrimmage\b/i.test(opponentTitle)) return 'Scrimmage';
  return 'Game';
}

function formatTime12h(time24) {
  if (!time24) return 'TBA';
  const [h, m] = time24.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 || 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
}

function sortByDateTime(events) {
  return [...events].sort(
    (a, b) =>
      a.eventDate.localeCompare(b.eventDate) ||
      (a._time24 ?? '99:99').localeCompare(b._time24 ?? '99:99')
  );
}

// ── CSV ───────────────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  'eventDate', 'cleanDate', 'season', 'seasonType', 'sport', 'sportSlug', 'gender',
  'levelSlug', 'levelLabel', 'teamSlug',
  'eventTime', 'homeOrAway', 'vsOrAt', 'opponent', 'opponentMascot', 'opponentComplete',
  'location', 'eventType', 'isCancelled', 'isPostponed', 'isTimeTBD', 'conferenceGame',
  'postSlug', 'posterFile', 'eventId',
];

// Neutralize leading =/+/-/@ so spreadsheet apps don't treat externally-sourced
// text (opponent names, etc.) as a formula when this CSV is opened in Excel/Sheets.
function csvCell(val) {
  let s = val == null ? '' : String(val);
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(events, filePath) {
  const header = CSV_COLUMNS.join(',');
  const rows   = events.map(e => CSV_COLUMNS.map(col => csvCell(e[col])).join(','));
  fs.writeFileSync(filePath, [header, ...rows].join('\n'));
}

// ── iCal output ───────────────────────────────────────────────────────────────

function writeIcal(events, filePath, calName) {
  const cal = ical({ name: calName });

  for (const e of events) {
    if (e.isCancelled || !e.eventDate) continue;

    const allDay = e.isTimeTBD || !e._time24;
    const start  = allDay
      ? DateTime.fromISO(e.eventDate, { zone: 'America/New_York' })
      : DateTime.fromISO(`${e.eventDate}T${e._time24}:00`, { zone: 'America/New_York' });

    if (!start.isValid) continue;

    cal.createEvent({
      id:    e.eventId,
      // Stamp off the event's own start time (not "now") so regenerating the
      // file from unchanged source data produces byte-identical output —
      // otherwise every VEVENT gets a fresh DTSTAMP on every run and the .ics
      // "changes" on every 15-minute fetch even when nothing did.
      stamp:  start.toJSDate(),
      start:  start.toJSDate(),
      ...(allDay ? {} : { end: start.plus({ hours: 2 }).toJSDate() }),
      allDay,
      summary: `${e.isPostponed ? '[POSTPONED] ' : ''}${e.levelLabel !== 'Varsity' ? `[${e.levelLabel}] ` : ''}${e.sport}: ${e.vsOrAt} ${e.opponentComplete}`,
      location: e.location || undefined,
    });
  }

  fs.writeFileSync(filePath, cal.toString());
}

// ── iCal parsing ──────────────────────────────────────────────────────────────

function unfoldIcal(text) {
  return text.replace(/\r?\n[ \t]/g, '');
}

function parseVevents(text) {
  const unfolded = unfoldIcal(text);
  const events   = [];
  const re       = /BEGIN:VEVENT\r?\n([\s\S]*?)\r?\nEND:VEVENT/g;
  let m;

  while ((m = re.exec(unfolded)) !== null) {
    const block = m[1];

    const field = (name) => {
      const fm = new RegExp(`(?:^|\\r?\\n)${name}(?:;[^:]*)?:([^\\r\\n]*)`, 'i').exec(block);
      return fm ? fm[1] : null;
    };

    let dtstart = null;
    const tzidM = /(?:^|\r?\n)DTSTART;TZID=([^:]+):([^\r\n]+)/i.exec(block);
    const dateM = /(?:^|\r?\n)DTSTART;VALUE=DATE:([^\r\n]+)/i.exec(block);
    const bareM = /(?:^|\r?\n)DTSTART:([^\r\n]+)/i.exec(block);
    if (tzidM)      dtstart = { type: 'datetime', value: tzidM[2] };
    else if (dateM) dtstart = { type: 'date',     value: dateM[1] };
    else if (bareM) dtstart = { type: 'datetime', value: bareM[1] };

    events.push({
      uid:         field('UID'),
      summary:     field('SUMMARY'),
      description: field('DESCRIPTION'),
      location:    field('LOCATION'),
      status:      field('STATUS'),   // e.g. CANCELLED, TENTATIVE, CONFIRMED
      dtstart,
    });
  }

  return events;
}

// Parse "Sport Name (Gender LevelCode)" from the beginning of a SUMMARY string.
// Returns { sport, level, gender } or null if unrecognized.
function parseSportAndLevel(summary) {
  const m = summary.match(/^(.+?)\s+\((\w+)\s+(\w+)\)/);
  if (!m) return null;
  const sportKey = `${m[1].trim()} (${m[2].trim()})`;
  const sport    = SPORT_BASE_MAP[sportKey];
  const level    = LEVEL_MAP[m[3].trim()];
  // The parens pattern matched but we don't recognize the sport/level — likely
  // EventLink renamed/added one (this has happened before: Swimming → Swim & Dive).
  if (!sport || !level) {
    console.warn(`  [unrecognized sport/level] sport=${JSON.stringify(sportKey)} level=${JSON.stringify(m[3])} in ${JSON.stringify(summary)}`);
    return null;
  }
  // "Coed" in the EventLink key normalizes to "Co-ed" to match the plugin's GENDERS list.
  const gender = m[2].trim() === 'Coed' ? 'Co-ed' : m[2].trim();
  return { sport, level, gender };
}

function parseEvent(vevent, opponents, juniorHighOpponents, teamIndex) {
  const rawSummary  = vevent.summary || '';
  // EventLink uses American spelling ("CANCELED") but has shipped British ("CANCELLED")
  // before. The iCal STATUS:CANCELLED field is a third path some calendar systems take.
  const isCancelled = rawSummary.startsWith('CANCELED - ')
                   || rawSummary.startsWith('CANCELLED - ')
                   || vevent.status === 'CANCELLED';
  const isPostponed = rawSummary.startsWith('POSTPONED - ');
  // Strip the prefix so the rest of the string parses as "Sport (Gender Level) @ Opponent".
  const summary = isCancelled
    ? rawSummary.replace(/^CANCELL?ED - /, '')
    : isPostponed
    ? rawSummary.slice(12)
    : rawSummary;

  const parsed = parseSportAndLevel(summary);
  if (!parsed) return null;
  const { sport, level, gender } = parsed;

  // Tolerate minor formatting drift (extra room/building suffix, whitespace)
  // around the venue name rather than requiring an exact string match.
  const isHome = !!vevent.location && vevent.location.includes(HOME_VENUE);

  // Prefer structured "Opponent(s):" in DESCRIPTION; fall back to the SUMMARY tail
  // for tournaments / invitationals that have no named opponent.
  const desc         = vevent.description || '';
  const oppFromDesc  = desc.match(/\\nOpponent\(s\):\s*([^\\]+)/);
  const opponentTitle = oppFromDesc
    ? oppFromDesc[1].trim()
    : summary.slice(summary.indexOf(')') + 1).replace(/^\s*[@\-]\s*/, '').trim();
  if (!opponentTitle) {
    console.warn(`  [no opponent text] ${JSON.stringify(summary)} (uid=${vevent.uid})`);
    return null;
  }

  const eventType = classifyEventType(opponentTitle);

  const ds = vevent.dtstart;
  if (!ds) {
    console.warn(`  [no DTSTART] ${JSON.stringify(opponentTitle)} (uid=${vevent.uid})`);
    return null;
  }

  let eventDate, time24, isTimeTBD;
  if (ds.type === 'date') {
    const v   = ds.value.replace(/\D/g, '');
    eventDate = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    time24    = null;
    isTimeTBD = true;
  } else {
    // DTSTART without TZID — could be floating local time or UTC (Z suffix).
    // Slice the compacted form into ISO so Luxon can parse it cleanly.
    const v = ds.value;
    const iso = v.includes('T')
      ? v.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/, '$1-$2-$3T$4:$5:$6$7')
      : null;

    let eventDt;
    if (iso && v.endsWith('Z')) {
      // UTC timestamp — convert to Eastern before extracting date+time so a game
      // at 20260904T000000Z ("midnight UTC" = "8 PM Eastern Sept 3") shows on Sept 3.
      eventDt = DateTime.fromISO(iso, { setZone: true }).setZone('America/New_York');
    } else if (iso) {
      // No timezone specified — treat as Eastern (EventLink is US-based).
      eventDt = DateTime.fromISO(iso, { zone: 'America/New_York' });
    } else {
      // DATE-only form without VALUE=DATE qualifier — rare but defensive.
      eventDt = DateTime.fromISO(v.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'), { zone: 'America/New_York' });
    }

    eventDate = eventDt.isValid ? eventDt.toISODate() : `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    time24    = (eventDt.isValid && v.includes('T'))
      ? `${String(eventDt.hour).padStart(2, '0')}:${String(eventDt.minute).padStart(2, '0')}`
      : null;
    isTimeTBD = !time24;
  }

  const cleanDate = `${eventDate.slice(5, 7)}/${eventDate.slice(8, 10)}`;
  const season    = computeSeason(eventDate, sport.season);

  // Varsity keeps the existing slug shape; other levels include the level to avoid collisions.
  const baseSlug = level.slug === 'varsity'
    ? `${eventDate}_${sport.slug}`
    : `${eventDate}_${level.slug}_${sport.slug}`;

  // Junior high opponent names (e.g. "LAKEVIEW MIDDLE SCHOOL") don't match the
  // HS opponents.json strings at all, so junior-high events look themselves up
  // in a separate, purpose-built registry instead.
  const opponentMap = level.group === 'junior-high' ? juniorHighOpponents : opponents;

  // Multi-team meets (see splitOpponentNames) resolve the first listed school
  // into the existing singular fields — unverified whether EventLink always
  // lists the host first, but even a wrong guess here is a real school name
  // instead of an unmatched, unsplit "\,"-joined string. The rest are exposed
  // separately for anything that wants the full participant list.
  const [primaryName, ...otherNames] = splitOpponentNames(opponentTitle);
  const { name: opponent, mascot, logo: opponentLogo, conference } = resolveOpponent(
    primaryName, opponentMap, eventType !== 'Game'
  );
  const opponentMascot   = mascot || null;
  const opponentComplete = opponentMascot ? `${opponent} ${opponentMascot}` : opponent;
  const otherOpponents = otherNames.map(name => {
    const r = resolveOpponent(name, opponentMap, eventType !== 'Game');
    return { name: r.name, mascot: r.mascot || null, conference: r.conference };
  });

  return {
    eventId:          vevent.uid,
    eventDate,
    season,
    seasonType:       sport.season,
    sport:            sport.title,
    sportSlug:        sport.slug,
    gender,
    levelSlug:        level.slug,
    levelLabel:       level.label,
    levelGroup:       level.group,
    teamSlug:         resolveTeamSlug(teamIndex, sport.title, level.label),
    eventTime:        formatTime12h(time24),
    homeOrAway:       isHome ? 'Home' : 'Away',
    vsOrAt:           isHome ? 'vs' : '@',
    opponent,
    opponentMascot,
    opponentComplete,
    opponentLogo:     opponentLogo || null,
    // Populated only for multi-team meets (track/swim/golf/wrestling); empty
    // for a normal single-opponent game. Not in the CSV output — arrays don't
    // fit a flat cell, and CSV consumers only ever needed the primary opponent.
    otherOpponents,
    cleanDate,
    posterFile:       `${baseSlug}.jpg`,
    postSlug:         baseSlug,
    title:            opponentTitle,
    location:         vevent.location || null,
    eventType,
    isCancelled,
    isPostponed,
    isTimeTBD,
    conferenceGame:   eventType === 'Game' && !!conference,
    _time24:          time24,
  };
}

// Swaps in the real venue for home events whose sport isn't actually played
// at HOME_VENUE (see HOME_VENUE_OVERRIDES). Applied as a post-processing step
// so it stays out of parseEvent's already-long body. Only touches the generic
// HOME_VENUE placeholder — if EventLink already noted a more specific location
// for a home event, that's kept as-is.
function applyHomeVenueOverrides(event) {
  if (event.homeOrAway !== 'Home' || (event.location && event.location !== HOME_VENUE)) return event;
  const rule = HOME_VENUE_OVERRIDES.find(r => r.matches(event));
  if (rule) event.location = rule.venue;
  return event;
}

// ── Diff & changelog ──────────────────────────────────────────────────────────

// Fields that matter for change detection — structural/scheduling data only.
const TRACKED_FIELDS = [
  'eventDate', 'eventTime', 'homeOrAway', 'opponent', 'location',
  'isCancelled', 'isPostponed', 'isTimeTBD', 'sport', 'levelSlug',
];

function diffEvents(prevEvents, nextEvents) {
  const prevById = Object.fromEntries(prevEvents.map(e => [e.eventId, e]));
  const nextById = Object.fromEntries(nextEvents.map(e => [e.eventId, e]));

  const added   = nextEvents.filter(e => !prevById[e.eventId]);
  const removed = prevEvents.filter(e => !nextById[e.eventId]);
  const changed = [];

  for (const next of nextEvents) {
    const prev = prevById[next.eventId];
    if (!prev) continue;
    const fields = TRACKED_FIELDS.filter(f => String(prev[f]) !== String(next[f]));
    if (fields.length) changed.push({ before: prev, after: next, fields });
  }

  return { added, removed, changed };
}

function logDiff({ added, removed, changed }) {
  const total = added.length + removed.length + changed.length;
  if (total === 0) { console.log('No event changes detected.\n'); return; }

  const label = e => `${e.eventDate} ${e.sport} (${e.levelLabel}) ${e.vsOrAt} ${e.opponentComplete}`;

  if (added.length) {
    console.log(`Added (${added.length}):`);
    for (const e of added) console.log(`  + ${label(e)}`);
  }
  if (removed.length) {
    console.log(`Removed (${removed.length}):`);
    for (const e of removed) console.log(`  - ${label(e)}`);
  }
  if (changed.length) {
    console.log(`Changed (${changed.length}):`);
    for (const { before, after, fields } of changed) {
      console.log(`  ~ ${label(after)}`);
      for (const f of fields) console.log(`      ${f}: ${JSON.stringify(before[f])} → ${JSON.stringify(after[f])}`);
    }
  }
  console.log();
}

// Slim representation stored in changes.json and changelog.json — just enough
// to understand what changed without duplicating the full event object.
function summariseEvent(e) {
  return {
    eventId:          e.eventId,
    eventDate:        e.eventDate,
    sport:            e.sport,
    levelLabel:       e.levelLabel,
    vsOrAt:           e.vsOrAt,
    opponentComplete: e.opponentComplete,
    isCancelled:      e.isCancelled,
    isPostponed:      e.isPostponed,
  };
}

function writeChangelog(diff) {
  const entry = {
    generatedAt: new Date().toISOString(),
    added:   diff.added.map(summariseEvent),
    removed: diff.removed.map(summariseEvent),
    changed: diff.changed.map(({ before, after, fields }) => ({
      ...summariseEvent(after),
      fields,
      before: Object.fromEntries(fields.map(f => [f, before[f]])),
      after:  Object.fromEntries(fields.map(f => [f, after[f]])),
    })),
  };

  fs.writeFileSync(path.join(META_DIR, 'changes.json'), JSON.stringify(entry, null, 2));

  const changelog = fs.existsSync(CHANGELOG_PATH)
    ? JSON.parse(fs.readFileSync(CHANGELOG_PATH, 'utf-8'))
    : [];
  changelog.push(entry);
  while (changelog.length > CHANGELOG_MAX_ENTRIES) changelog.shift();
  fs.writeFileSync(CHANGELOG_PATH, JSON.stringify(changelog, null, 2));
}

// ── File output ───────────────────────────────────────────────────────────────

// Write combined / upcoming / cancelled-today for a given directory + event list.
function writeDataFiles(dir, allEvents, today) {
  const combined       = sortByDateTime(allEvents.filter(e => !e.isCancelled));
  const upcoming       = combined.filter(e => e.eventDate >= today);
  const cancelledToday = allEvents.filter(e => e.isCancelled && e.eventDate === today);

  fs.writeFileSync(path.join(dir, 'combined.json'), JSON.stringify(combined, null, 2));
  writeCsv(combined, path.join(dir, 'combined.csv'));

  fs.writeFileSync(path.join(dir, 'upcoming.json'), JSON.stringify(upcoming, null, 2));
  writeCsv(upcoming, path.join(dir, 'upcoming.csv'));

  fs.writeFileSync(path.join(dir, 'cancelled-today.json'), JSON.stringify(cancelledToday, null, 2));
  writeCsv(cancelledToday, path.join(dir, 'cancelled-today.csv'));

  return { combined: combined.length, upcoming: upcoming.length };
}

// Write per-team files for one level, return index entries for that level.
function writeLevel(levelSlug, bySport, today) {
  // Rollups (combined/upcoming/cancelled-today) are conglomerate views and
  // stay grouped per level under rollups/ — kept out of teams/ entirely so
  // "every file in teams/ is exactly one team's schedule" always holds.
  const rollupDir = path.join(ROLLUPS_DIR, levelSlug);
  fs.mkdirSync(rollupDir, { recursive: true });

  const allForLevel  = [];
  const indexEntries = [];

  for (const [sportSlug, list] of Object.entries(bySport)) {
    const sorted = sortByDateTime(list);

    // Number same-day events: second becomes slug-1, third slug-2, etc.
    const slugSeen = {};
    for (const e of sorted) {
      const base  = e.postSlug;
      const count = slugSeen[base] ?? 0;
      if (count > 0) {
        e.postSlug   = `${base}-${count}`;
        e.posterFile = `${base}-${count}.jpg`;
      }
      slugSeen[base] = count + 1;
    }

    // Flat, per-team files (e.g. football-varsity.json) — teamSlug already
    // encodes the level, so no per-level subdirectory is needed here. Falls
    // back to a level-sport name if the team isn't in the registry, so data
    // still gets written (just not under its normal canonical name).
    const teamSlug = sorted[0].teamSlug ?? `${levelSlug}-${sportSlug}`;
    fs.writeFileSync(path.join(TEAMS_DIR, `${teamSlug}.json`), JSON.stringify(sorted, null, 2));
    writeCsv(sorted, path.join(TEAMS_DIR, `${teamSlug}.csv`));
    allForLevel.push(...sorted);
    console.log(`  [${levelSlug}] ${sportSlug} → ${sorted.length} (${teamSlug})`);

    const e         = sorted[0];
    const icalGroup = ICAL_GROUPS.find(g => g.levels?.includes(levelSlug));
    indexEntries.push({
      sport:         e.sport,
      sportSlug:     e.sportSlug,
      level:         e.levelLabel,
      levelSlug:     e.levelSlug,
      levelGroup:    e.levelGroup,
      gender:        e.gender,
      seasonType:    e.seasonType,
      teamSlug,
      dataFile:      `teams/${teamSlug}.json`,
      csvFile:       `teams/${teamSlug}.csv`,
      icalFile:      `ics/${teamSlug}.ics`,
      groupIcalFile: `ics/groups/${icalGroup?.file ?? 'pshs-all.ics'}`,
    });
  }

  const { combined, upcoming } = writeDataFiles(rollupDir, allForLevel, today);
  console.log(`  [${levelSlug}] combined=${combined} upcoming=${upcoming}\n`);

  return indexEntries;
}

// ── Network ───────────────────────────────────────────────────────────────────

async function fetchFeed() {
  console.log('Fetching iCal feed…');
  const controller = new AbortController();
  // Covers the whole request including body read — a stalled response body
  // after headers arrive would otherwise hang past this timeout uncaught.
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ICAL_URL, {
      headers: { 'User-Agent': 'pshs-schedule-proxy/3.0' },
      signal:  controller.signal,
    });
    if (!res.ok) throw new Error(`EventLink iCal ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`Received ${text.length} bytes`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  for (const dir of [TEAMS_DIR, ROLLUPS_DIR, META_DIR, ICS_DIR, ICS_GROUPS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const prevEvents = fs.existsSync(DIFF_SNAPSHOT_PATH)
    ? JSON.parse(fs.readFileSync(DIFF_SNAPSHOT_PATH, 'utf-8'))
    : [];

  if (!ICAL_URL) throw new Error('EVENTLINK_ICAL_URL environment variable is not set.');

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

  const icalText = await fetchFeed();

  const rawVevents = parseVevents(icalText);
  console.log(`Parsed ${rawVevents.length} VEVENTs`);

  // Guard against a degenerate feed response (outage, gateway error page,
  // revoked token) wiping out every committed schedule file with empty data.
  if (rawVevents.length === 0) {
    throw new Error('EventLink feed returned zero VEVENTs — aborting before overwriting existing data.');
  }

  // De-duplicate by UID (defensive — duplicate UIDs would silently corrupt
  // the added/removed diff, since they collide as the same map key).
  const seenUids = new Set();
  const vevents  = [];
  for (const v of rawVevents) {
    // EventLink occasionally emits events with no UID. Generate a stable synthetic one
    // from the event's content so these events get a consistent identity across runs
    // (required for upsert keying on the WordPress side). Two events with identical
    // summary + start + location would collapse to the same key — intentional, since
    // they'd be indistinguishable anyway.
    if (!v.uid) {
      const sig = `${v.summary ?? ''}|${v.dtstart?.value ?? ''}|${v.location ?? ''}`;
      v.uid     = 'pshs-syn-' + createHash('sha1').update(sig).digest('hex').slice(0, 16);
      console.warn(`  [synthetic UID] ${v.summary} → ${v.uid}`);
    }
    if (seenUids.has(v.uid)) { console.warn(`  [duplicate UID] ${v.uid}`); continue; }
    seenUids.add(v.uid);
    vevents.push(v);
  }

  const events = vevents
    .map(v => parseEvent(v, opponents, juniorHighOpponents, teamIndex))
    .filter(Boolean)
    .map(applyHomeVenueOverrides);
  console.log(`Kept ${events.length} events after filtering\n`);

  const keptRatio = events.length / vevents.length;
  if (vevents.length > MIN_VEVENTS_FOR_RATIO_CHECK && keptRatio < MIN_KEPT_RATIO) {
    throw new Error(
      `Only kept ${events.length}/${vevents.length} events (${Math.round(keptRatio * 100)}%) — ` +
      `likely an EventLink format change, aborting before overwriting existing data.`
    );
  }

  const today = new Date().toISOString().split('T')[0];

  const byLevel = {};
  for (const e of events) {
    (byLevel[e.levelSlug] ??= {})[e.sportSlug] ??= [];
    byLevel[e.levelSlug][e.sportSlug].push(e);
  }

  // Write per-sport files and collect index entries in one pass.
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

  // Diff against the previous full snapshot (all levels, cancelled events
  // included — so a cancellation surfaces as "Changed: isCancelled" rather
  // than "Removed", and JV/Freshman/Junior High aren't permanently "added").
  const allEvents = sortByDateTime(events);
  const diff = diffEvents(prevEvents, allEvents);
  console.log('--- Change detection ---');
  logDiff(diff);
  fs.writeFileSync(DIFF_SNAPSHOT_PATH, JSON.stringify(allEvents, null, 2));

  // Only touch changes.json/changelog.json when something actually changed —
  // otherwise every 15-minute fetch rewrites with a fresh timestamp even when
  // nothing did, forcing a no-op git commit + Pages deploy each time.
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

  // Per-team ICS files (e.g. football-varsity.ics) — one subscribable calendar
  // per team, alongside the broader level-group calendars above.
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
    vevents:    rawVevents.length,
    kept:       events.length,
    hasChanges: diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0,
  }, null, 2));

  console.log('\nDone.');
}

export {
  computeSeason, formatTime12h, parseSportAndLevel, diffEvents, summariseEvent,
  parseTeamsCsv, buildTeamSlugIndex, resolveTeamSlug,
  resolveOpponent, applyHomeVenueOverrides,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
