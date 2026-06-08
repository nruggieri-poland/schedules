import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import ical from 'ical-generator';
import { DateTime } from 'luxon';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'dist', 'data');
const ICS_DIR  = path.join(__dirname, 'dist');

const HOME_VENUE = 'Poland Seminary High School';
const ICAL_URL   =
  'https://api.eventlink.com/?m=Calendar&a=iCalFeedSubscriptions' +
  '&token=76f8c41e-9ca2-4f93-abf8-d1a55411ba8d' +
  '&id=66ee88b6-0df2-42d7-b892-5a267a72ce9f';

// Keyed on "Sport (Gender)" — level code is parsed separately.
const SPORT_BASE_MAP = {
  'Baseball (Boys)':       { slug: 'baseball',        title: 'Baseball' },
  'Basketball (Boys)':     { slug: 'boys-basketball',  title: 'Boys Basketball' },
  'Basketball (Girls)':    { slug: 'girls-basketball', title: 'Girls Basketball' },
  'Cheerleading (Girls)':  { slug: 'cheerleading',     title: 'Cheerleading' },
  'Cross Country (Coed)':  { slug: 'cross-country',    title: 'Cross Country' },
  'Football (Boys)':       { slug: 'football',         title: 'Football' },
  'Golf (Boys)':           { slug: 'boys-golf',        title: 'Boys Golf' },
  'Golf (Girls)':          { slug: 'girls-golf',       title: 'Girls Golf' },
  'Lacrosse (Boys)':       { slug: 'boys-lacrosse',    title: 'Boys Lacrosse' },
  'Lacrosse (Girls)':      { slug: 'girls-lacrosse',   title: 'Girls Lacrosse' },
  'Soccer (Boys)':         { slug: 'boys-soccer',      title: 'Boys Soccer' },
  'Soccer (Girls)':        { slug: 'girls-soccer',     title: 'Girls Soccer' },
  'Softball (Girls)':      { slug: 'softball',         title: 'Softball' },
  'Swimming (Coed)':       { slug: 'swim-dive',        title: 'Swim & Dive' },
  'Swim & Dive (Coed)':    { slug: 'swim-dive',        title: 'Swim & Dive' },
  'Tennis (Boys)':         { slug: 'boys-tennis',      title: 'Boys Tennis' },
  'Tennis (Girls)':        { slug: 'girls-tennis',     title: 'Girls Tennis' },
  'Track & Field (Coed)':  { slug: 'track-field',      title: 'Track & Field' },
  'Volleyball (Girls)':    { slug: 'volleyball',       title: 'Volleyball' },
  'Wrestling (Boys)':      { slug: 'boys-wrestling',   title: 'Boys Wrestling' },
  'Wrestling (Girls)':     { slug: 'girls-wrestling',  title: 'Girls Wrestling' },
};

// Level codes as they appear in iCal SUMMARY parentheses.
const LEVEL_MAP = {
  'V':  { slug: 'varsity',  label: 'Varsity',       group: 'varsity' },
  'JV': { slug: 'jv',       label: 'JV',            group: 'jv-freshman' },
  'F':  { slug: 'freshman', label: 'Freshman',      group: 'jv-freshman' },
  '8':  { slug: '8th',      label: '8th Grade',     group: 'junior-high' },
  '7':  { slug: '7th',      label: '7th Grade',     group: 'junior-high' },
  'MS': { slug: 'ms',       label: 'Middle School', group: 'junior-high' },
};

// The four iCal files to produce. levels: null = all events.
const ICAL_GROUPS = [
  {
    name:   'PSHS Athletics',
    file:   'pshs-all.ics',
    levels: null,
  },
  {
    name:   'PSHS Athletics – Varsity',
    file:   'pshs-athletics.ics',
    levels: ['varsity'],
  },
  {
    name:   'PSHS Athletics – JV & Freshman',
    file:   'pshs-jv-freshman.ics',
    levels: ['jv', 'freshman'],
  },
  {
    name:   'PSHS Athletics – Junior High',
    file:   'pshs-junior-high.ics',
    levels: ['7th', '8th', 'ms'],
  },
];

function pad(n) {
  return String(n).padStart(2, '0');
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

function resolveOpponent(title, opponents) {
  const attempts = [title, normalizeTitle(title)];
  for (const attempt of attempts) {
    if (opponents[attempt]) return { ...opponents[attempt], matched: true };
  }
  console.warn(`  [unmatched] ${JSON.stringify(title)}`);
  return { name: title, mascot: null, matched: false };
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

// --- CSV ---

const CSV_COLUMNS = [
  'eventDate', 'cleanDate', 'sport', 'sportSlug', 'levelSlug', 'levelLabel',
  'eventTime', 'homeOrAway', 'vsOrAt', 'opponent', 'opponentMascot', 'opponentComplete',
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

// --- iCal output ---

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
      start:    start.toJSDate(),
      ...(allDay ? {} : { end: start.plus({ hours: 2 }).toJSDate() }),
      allDay,
      summary:  `${e.levelLabel !== 'Varsity' ? `[${e.levelLabel}] ` : ''}${e.sport}: ${e.vsOrAt} ${e.opponentComplete}`,
      location: e.location || undefined,
    });
  }

  fs.writeFileSync(filePath, cal.toString());
}

// --- iCal parsing ---

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
      dtstart,
    });
  }

  return events;
}

// Parse "Sport Name (Gender LevelCode)" from the beginning of a SUMMARY string.
// Returns { sport, level } or null if unrecognized.
function parseSportAndLevel(summary) {
  const m = summary.match(/^(.+?)\s+\((\w+)\s+(\w+)\)/);
  if (!m) return null;
  const sport = SPORT_BASE_MAP[`${m[1].trim()} (${m[2].trim()})`];
  const level = LEVEL_MAP[m[3].trim()];
  if (!sport || !level) return null;
  return { sport, level };
}

function parseEvent(vevent, opponents) {
  const rawSummary  = vevent.summary || '';
  const isCancelled = rawSummary.startsWith('CANCELED - ');
  // 'CANCELED - '.length === 11
  const summary = isCancelled ? rawSummary.slice(11) : rawSummary;

  const parsed = parseSportAndLevel(summary);
  if (!parsed) return null;
  const { sport, level } = parsed;

  const isHome = vevent.location === HOME_VENUE;

  // Prefer structured "Opponent(s):" in DESCRIPTION; fall back to the SUMMARY tail
  // for tournaments / invitationals that have no named opponent.
  const desc        = vevent.description || '';
  const oppFromDesc = desc.match(/\\nOpponent\(s\):\s*([^\\]+)/);
  const opponentTitle = oppFromDesc
    ? oppFromDesc[1].trim()
    : summary.slice(summary.indexOf(')') + 1).replace(/^\s*[@\-]\s*/, '').trim();
  if (!opponentTitle) return null;

  const ds = vevent.dtstart;
  if (!ds) return null;

  let eventDate, time24, isTimeTBD;
  if (ds.type === 'date') {
    const v   = ds.value.replace(/\D/g, '');
    eventDate = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    time24    = null;
    isTimeTBD = true;
  } else {
    const v   = ds.value;
    eventDate = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    const t   = v.includes('T') ? v.split('T')[1] : null;
    time24    = t ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : null;
    isTimeTBD = !time24;
  }

  const cleanDate = `${eventDate.slice(5, 7)}/${eventDate.slice(8, 10)}`;

  // Varsity keeps the existing slug shape; other levels include the level to avoid collisions.
  const baseSlug = level.slug === 'varsity'
    ? `${eventDate}_${sport.slug}`
    : `${eventDate}_${level.slug}_${sport.slug}`;

  const { name: opponent, mascot } = resolveOpponent(opponentTitle, opponents);
  const opponentMascot   = mascot || null;
  const opponentComplete = opponentMascot ? `${opponent} ${opponentMascot}` : opponent;

  return {
    eventId:          vevent.uid,
    eventDate,
    sport:            sport.title,
    sportSlug:        sport.slug,
    levelSlug:        level.slug,
    levelLabel:       level.label,
    levelGroup:       level.group,
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
  console.log(`Kept ${events.length} events after filtering\n`);

  const today = new Date().toISOString().split('T')[0];

  // Group by level → by sport
  const byLevel = {};
  for (const e of events) {
    (byLevel[e.levelSlug] ??= {})[e.sportSlug] ??= [];
    byLevel[e.levelSlug][e.sportSlug].push(e);
  }

  for (const [levelSlug, bySport] of Object.entries(byLevel)) {
    const dir = levelSlug === 'varsity' ? DATA_DIR : path.join(DATA_DIR, levelSlug);
    fs.mkdirSync(dir, { recursive: true });

    const allForLevel = [];

    for (const [slug, list] of Object.entries(bySport)) {
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

      fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(sorted, null, 2));
      writeCsv(sorted, path.join(dir, `${slug}.csv`));
      allForLevel.push(...sorted);
      console.log(`  [${levelSlug}] ${slug} → ${sorted.length}`);
    }

    const { combined, upcoming } = writeDataFiles(dir, allForLevel, today);
    console.log(`  [${levelSlug}] combined=${combined} upcoming=${upcoming}\n`);
  }

  // iCal files
  for (const group of ICAL_GROUPS) {
    const filtered = events.filter(
      e => !e.isCancelled && (group.levels === null || group.levels.includes(e.levelSlug))
    );
    writeIcal(filtered, path.join(ICS_DIR, group.file), group.name);
    console.log(`${group.file} → ${filtered.length} events`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
