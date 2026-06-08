import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import ical from 'ical-generator';
import { DateTime } from 'luxon';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR      = path.join(__dirname, 'dist', 'data');
const COMBINED      = path.join(DATA_DIR, 'combined.json');
const COMBINED_CSV  = path.join(DATA_DIR, 'combined.csv');
const CANCELLED     = path.join(DATA_DIR, 'cancelled-today.json');
const CANCELLED_CSV = path.join(DATA_DIR, 'cancelled-today.csv');
const ICS_FILE      = path.join(__dirname, 'dist', 'pshs-athletics.ics');

const HOME_VENUE = 'Poland Seminary High School';
const ICAL_URL   =
  'https://api.eventlink.com/?m=Calendar&a=ICalFeedAthleticsByOrganizationID' +
  '&id=66ee88b6-0df2-42d7-b892-5a267a72ce9f' +
  '&token=76f8c41e-9ca2-4f93-abf8-d1a55411ba8d' +
  '&extra=false';

// Maps "Sport (Gender Level)" from iCal SUMMARY → { slug, title }
// Only Varsity (V) entries are listed; everything else is silently dropped.
const SPORT_MAP = {
  'Football (Boys V)':       { slug: 'football',        title: 'Football' },
  'Basketball (Boys V)':     { slug: 'boys-basketball',  title: 'Boys Basketball' },
  'Basketball (Girls V)':    { slug: 'girls-basketball', title: 'Girls Basketball' },
  'Golf (Boys V)':           { slug: 'boys-golf',        title: 'Boys Golf' },
  'Golf (Girls V)':          { slug: 'girls-golf',       title: 'Girls Golf' },
  'Soccer (Boys V)':         { slug: 'boys-soccer',      title: 'Boys Soccer' },
  'Soccer (Girls V)':        { slug: 'girls-soccer',     title: 'Girls Soccer' },
  'Tennis (Boys V)':         { slug: 'boys-tennis',      title: 'Boys Tennis' },
  'Tennis (Girls V)':        { slug: 'girls-tennis',     title: 'Girls Tennis' },
  'Volleyball (Girls V)':    { slug: 'volleyball',       title: 'Volleyball' },
  'Cross Country (Coed V)':  { slug: 'cross-country',    title: 'Cross Country' },
  'Wrestling (Boys V)':      { slug: 'boys-wrestling',   title: 'Boys Wrestling' },
  'Wrestling (Girls V)':     { slug: 'girls-wrestling',  title: 'Girls Wrestling' },
  'Swimming (Coed V)':       { slug: 'swim-dive',        title: 'Swim & Dive' },
  'Swim & Dive (Coed V)':    { slug: 'swim-dive',        title: 'Swim & Dive' },
  'Baseball (Boys V)':       { slug: 'baseball',         title: 'Baseball' },
  'Softball (Girls V)':      { slug: 'softball',         title: 'Softball' },
  'Lacrosse (Boys V)':       { slug: 'boys-lacrosse',    title: 'Boys Lacrosse' },
  'Lacrosse (Girls V)':      { slug: 'girls-lacrosse',   title: 'Girls Lacrosse' },
  'Track & Field (Coed V)':  { slug: 'track-field',      title: 'Track & Field' },
  'Cheerleading (Girls V)':  { slug: 'cheerleading',     title: 'Cheerleading' },
};

// Titles that are banquets, meetings, photos, clinics, etc. — not athletic events.
// Uses word boundaries so "Campbell" is not caught by "camp".
const NON_EVENT_RE = /\b(banquet|meeting|pictures?|clinic|dinner|tryouts?|practice|scrimmage|camp|zombie|kindness)\b/i;

function pad(n) {
  return String(n).padStart(2, '0');
}

// Normalize an opponent title for lookup:
// strips trailing "(disambiguation)" and common suffix variants.
function normalizeTitle(title) {
  const noDisambig = title.replace(/\s*\([^)]+\)\s*$/, '').trim();
  return noDisambig
    .replace(/\s+Sr\.?\s+High\s+School$/i, ' High School')
    .replace(/\s+Jr\.?\s*\/?\s*Sr\.?\s+High\s+School$/i, ' High School')
    .replace(/\s+H\.S\.$|(?<!\w)HS$/i, ' High School')
    .replace(/\./g, '')
    .trim();
}

// Resolve an opponent title to a { name, mascot } entry from opponents.json.
// Returns the raw title as name if no match is found, and logs a warning.
function resolveOpponent(title, opponents) {
  const attempts = [title, normalizeTitle(title)];
  for (const attempt of attempts) {
    if (opponents[attempt]) return { ...opponents[attempt], matched: true };
  }
  console.warn(`  [unmatched] ${JSON.stringify(title)}`);
  return { name: title, mascot: null, matched: false };
}

// Convert 24-hour "HH:MM" → 12-hour "hh:mm AM/PM", or "TBA" if null.
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

const CSV_COLUMNS = [
  'eventDate', 'cleanDate', 'sport', 'sportSlug', 'eventTime',
  'homeOrAway', 'vsOrAt', 'opponent', 'opponentMascot', 'opponentComplete',
  'location', 'isCancelled', 'isTimeTBD', 'postSlug', 'posterFile', 'eventId',
];

function csvCell(val) {
  const s = val == null ? '' : String(val);
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(events, filePath) {
  const header = CSV_COLUMNS.join(',');
  const rows   = events.map(e => CSV_COLUMNS.map(col => csvCell(e[col])).join(','));
  fs.writeFileSync(filePath, [header, ...rows].join('\n'));
}

function writeIcal(events) {
  const cal = ical({ name: 'PSHS Athletics' });

  for (const e of events) {
    if (e.isCancelled || !e.eventDate) continue;

    const allDay = e.isTimeTBD || !e._time24;
    const start  = allDay
      ? DateTime.fromISO(e.eventDate, { zone: 'America/New_York' })
      : DateTime.fromISO(`${e.eventDate}T${e._time24}:00`, { zone: 'America/New_York' });

    if (!start.isValid) continue;

    cal.createEvent({
      start:    start.toJSDate(),
      ...(allDay ? {} : { end: start.plus({ hours: 2 }).toJSDate() }),
      allDay,
      summary:  `${e.sport}: ${e.vsOrAt} ${e.opponentComplete}`,
      location: e.location || undefined,
    });
  }

  fs.writeFileSync(ICS_FILE, cal.toString());
}

// --- iCal parsing ---

// iCal folds long lines by inserting CRLF + a leading space/tab.
function unfoldIcal(text) {
  return text.replace(/\r?\n[ \t]/g, '');
}

// Parse all VEVENT blocks from the raw iCal text.
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

    // DTSTART may carry a TZID param, a VALUE=DATE param, or no param.
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
      dtstart,
    });
  }

  return events;
}

// Convert one VEVENT → our normalized shape, or null if it should be dropped.
function parseEvent(vevent, opponents) {
  const rawSummary = vevent.summary || '';
  const isCancelled = rawSummary.startsWith('CANCELED - ');
  // 'CANCELED - '.length === 11
  const summary = isCancelled ? rawSummary.slice(11) : rawSummary;

  // Match sport key — format is "Sport (Gender V)" in iCal SUMMARY (same as JSON API)
  let sport    = null;
  let sportKey = null;
  for (const [key, val] of Object.entries(SPORT_MAP)) {
    if (summary.startsWith(key + ' ') || summary === key) {
      sport    = val;
      sportKey = key;
      break;
    }
  }
  if (!sport) return null;
  if (NON_EVENT_RE.test(summary)) return null;

  // Home: LOCATION is the school itself; Away: LOCATION is the opponent's venue.
  const isHome = vevent.location === HOME_VENUE;

  // Prefer the structured "Opponent(s):" field in DESCRIPTION; fall back to
  // the tail of SUMMARY (covers tournaments/invitationals with no named opponent).
  const desc       = vevent.description || '';
  const oppFromDesc = desc.match(/\\nOpponent\(s\):\s*([^\\]+)/);
  const opponentTitle = oppFromDesc
    ? oppFromDesc[1].trim()
    : summary.slice(sportKey.length).replace(/^\s*[@\-]\s*/, '').trim();
  if (!opponentTitle) return null;

  // Parse date/time from DTSTART
  const ds = vevent.dtstart;
  if (!ds) return null;

  let eventDate, time24, isTimeTBD;
  if (ds.type === 'date') {
    const v  = ds.value.replace(/\D/g, '');               // "20270206"
    eventDate = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    time24    = null;
    isTimeTBD = true;
  } else {
    const v   = ds.value;                                  // "20260204T170000"
    eventDate = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    const t   = v.includes('T') ? v.split('T')[1] : null;
    time24    = t ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : null;
    isTimeTBD = !time24;
  }

  const cleanDate = `${eventDate.slice(5, 7)}/${eventDate.slice(8, 10)}`;
  const baseSlug  = `${eventDate}_${sport.slug}`;

  const { name: opponent, mascot } = resolveOpponent(opponentTitle, opponents);
  const opponentMascot   = mascot || null;
  const opponentComplete = opponentMascot ? `${opponent} ${opponentMascot}` : opponent;

  return {
    eventId:          vevent.uid,
    eventDate,
    sport:            sport.title,
    sportSlug:        sport.slug,
    eventTime:        formatTime12h(time24),
    homeOrAway:       isHome ? 'Home' : 'Away',
    vsOrAt:           isHome ? 'vs' : '@',
    opponent,
    opponentMascot,
    opponentComplete,
    cleanDate,
    posterFile:       `${baseSlug}.jpg`,
    postSlug:         baseSlug,
    title:            opponentTitle,
    location:         vevent.location || null,
    isCancelled,
    isTimeTBD,
    _time24:          time24,
  };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const opponents = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'opponents.json'), 'utf-8')
  );

  console.log(`Fetching iCal feed…`);
  const res = await fetch(ICAL_URL, {
    headers: { 'User-Agent': 'pshs-schedule-proxy/3.0' },
  });
  if (!res.ok) throw new Error(`EventLink iCal ${res.status} ${res.statusText}`);

  const icalText = await res.text();
  console.log(`Received ${icalText.length} bytes`);

  const vevents = parseVevents(icalText);
  console.log(`Parsed ${vevents.length} VEVENTs`);

  const events = vevents.map(v => parseEvent(v, opponents)).filter(Boolean);
  console.log(`Kept ${events.length} varsity events after filtering`);

  // Per-sport files — also applies doubleheader suffixes to postSlug / posterFile
  const bySport = {};
  for (const e of events) {
    (bySport[e.sportSlug] ??= []).push(e);
  }
  for (const [slug, list] of Object.entries(bySport)) {
    const sorted = sortByDateTime(list);

    // Number any same-day games: second game becomes slug-1, third becomes slug-2, etc.
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

    fs.writeFileSync(
      path.join(DATA_DIR, `${slug}.json`),
      JSON.stringify(sorted, null, 2)
    );
    writeCsv(sorted, path.join(DATA_DIR, `${slug}.csv`));
    console.log(`  ${slug}.json / .csv → ${sorted.length}`);
  }

  // combined — active games only, sorted
  const combined = sortByDateTime(events.filter(e => !e.isCancelled));
  fs.writeFileSync(COMBINED, JSON.stringify(combined, null, 2));
  writeCsv(combined, COMBINED_CSV);
  console.log(`combined.json / .csv → ${combined.length}`);

  // cancelled-today
  const today = new Date().toISOString().split('T')[0];
  const cancelledToday = events.filter(e => e.isCancelled && e.eventDate === today);
  fs.writeFileSync(CANCELLED, JSON.stringify(cancelledToday, null, 2));
  writeCsv(cancelledToday, CANCELLED_CSV);
  console.log(`cancelled-today.json / .csv → ${cancelledToday.length}`);

  // iCal
  writeIcal(combined);
  console.log('pshs-athletics.ics written');
  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
