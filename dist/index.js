import fs from 'fs';
import path from 'path';
import icalParse from 'node-ical';
import fetch from 'node-fetch';
import { DateTime } from 'luxon';
import ical from 'ical-generator';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'dist', 'data');
const CALENDAR_PATH = path.join(__dirname, 'dist', 'pshs-athletics.ics');
const TEAMS_PATH = path.join(__dirname, 'teams', 'teams.json');
const COMBINED_PATH = path.join(DATA_DIR, 'combined.json');
// Refactored version with your original fetch method logic

async function fetchICS() {
  const url = 'https://github.com/nruggieri-poland/athletics-ics-proxy/raw/refs/heads/master/schedule.ics';

  try {
    const res = await fetch(url);
    const text = await res.text();

    console.log("📄 Fetched ICS text:");
    console.log(text.slice(0, 1000)); // Log the first 1000 characters

    const data = icalParse.parseICS(text);
    const events = Object.values(data).filter(e => e.type === 'VEVENT');

    console.log(`🧾 Total events parsed: ${events.length}`);
    return events;
  } catch (err) {
    console.error("❌ Failed to fetch or parse ICS:", err);
    return [];
  }
}

function parseICSEvent(evt) {
  const sportMap = {
    "Soccer B": "Boys Soccer",
    "Soccer G": "Girls Soccer",
    "Tennis G": "Girls Tennis",
    "Cross Country C": "Cross Country",
    "Football B": "Football",
    "Golf B": "Boys Golf",
    "Golf G": "Girls Golf",
    "Volleyball G": "Volleyball",
    "Basketball B": "Boys Basketball",
    "Basketball G": "Girls Basketball",
    "Swim & Dive C": "Swim & Dive",
    "Wrestling B": "Boys Wrestling",
    "Wrestling G": "Girls Wrestling",
    "Baseball B": "Baseball",
    "Softball G": "Softball",
    "Lacrosse G": "Girls Lacrosse",
    "Lacrosse B": "Boys Lacrosse",
    "Track C": "Track & Field",
    "Tennis B": "Boys Tennis"
  };
  const rawSummary = evt.summary || '';
  // Detect a TBA/TBD tag anywhere (sometimes appears before PSHS name)
  const isTimeTBATag = /(^|\W)Time:\s*(TBA|TBD)\b/i.test(rawSummary);
  // Remove a leading "Time: TBA/TBD -" prefix if present so tokenization is stable
  let summary = rawSummary.replace(/^Time:\s*(TBA|TBD)\s*-\s*/i, '');
  const pshs = 'Poland Seminary High School ';
  const idx = summary.indexOf(pshs);
  if (idx === -1) return null;
  // Slice from the PSHS tag to avoid any stray prefixes before it
  summary = summary.slice(idx + pshs.length).trim();

  if (summary.toLowerCase().includes("scrimmage") || summary.toLowerCase().includes("practice")) return null;

  const parts = summary.split(" ");
  const hoaIndex = parts.findIndex(p => p === "Home" || p === "Away");
  if (hoaIndex === -1) return null;

  const homeOrAway = parts[hoaIndex];
  const sportCode = parts.slice(0, hoaIndex).join(" ");
  const opponentRaw = parts.slice(hoaIndex + 1).join(" ");

  const matchParen = opponentRaw.match(/\(([^)]+)\)/g);
  // Skip scrimmages entirely, even if duplicated
  if (matchParen && matchParen.some(p => /scrimmage/i.test(p))) return null;

  // Extract extra labels from parentheses, e.g., "(and Lakeview)", "(Kiely Cup)", etc.
  const parenBits = matchParen
    ? matchParen.map(s => s.replace(/[()]/g, '').trim()).filter(Boolean)
    : [];
  const extraTitle = parenBits.filter(t => !/scrimmage/i.test(t)).join(' - ') || null;

  // Opponent without any parens
  let opponentComplete = opponentRaw.replace(/\s*\([^)]*\)/g, '').trim();
  // Some feeds emit just "and X" in the parens; keep the main token as opponent
  let opponent = opponentComplete || 'TBD';

  // If opponent token is OPEN, treat paren text as the tournament/meet title
  let title;
  if (/^OPEN$/i.test(opponent)) {
    title = extraTitle || 'OPEN';
    opponent = title; // keep legacy behavior where OPEN events surface the title in opponent field
    opponentComplete = title;
  } else {
    title = extraTitle ? `${opponentComplete} (${extraTitle})` : opponentComplete;
  }

  const sport = sportMap[sportCode] || sportCode;
  const dateObj = DateTime.fromJSDate(evt.start).setZone('America/New_York');
  const startISO = dateObj.toISO();
  const cleanDate = dateObj.toFormat("yyyy-MM-dd");
  // Treat midnight or tagged summaries as TBA
  const eventTime = (!evt.start || isTimeTBATag || (dateObj.hour === 0 && dateObj.minute === 0))
    ? 'TBA'
    : dateObj.toFormat('h:mm a');
  const eventId = evt.uid.split(".")[0];
  const sportSlug = sport.toLowerCase().replace(/\s+/g, "-");
  const vsOrAt = homeOrAway === "Home" ? "vs" : "@";

  return {
    eventId: Number(eventId),
    sport,
    date: dateObj.toFormat("MM/dd/yyyy"),
    time: eventTime,
    title,
    homeOrAway,
    vsOrAt,
    location: evt.location || null,
    opponent,
    result: null,
    isCancelled: false,
    isPostponed: false,
    url: `https://polandbulldogs.bigteams.com/main/event/scid/OH4451495857/eventId/${eventId}/`,
    startISO,
    isTimeTBATag,
  };
}

function writeCalendar(events) {
  const cal = ical({ name: 'PSHS Athletics Events' });

  events.forEach(event => {
    if (event.isCancelled || event.isPostponed || !event.date) return;

    // Prefer machine-readable ISO to avoid locale/format parsing issues
    const base = event.startISO
      ? DateTime.fromISO(event.startISO, { zone: 'America/New_York' })
      : DateTime.invalid('Missing startISO');

    const isTBA = Boolean(event.isTimeTBATag) || !event.time || /^(TBA|TBD|NA)$/i.test(event.time || '');

    if (!base.isValid) {
      console.warn(`\u26a0\ufe0f Skipping invalid date/time (bad ISO): ${event.date} ${event.time || ''} (${event.title}) — ${base.invalidExplanation || base.invalidReason}`);
      return;
    }

    const start = isTBA ? base.startOf('day') : base;
    const end = isTBA ? undefined : start.plus({ hours: 2 });

    cal.createEvent({
      start: start.toJSDate(),
      ...(end ? { end: end.toJSDate() } : {}),
      allDay: isTBA,
      summary: `${event.sport}: ${event.homeOrAway} ${event.vsOrAt} ${event.opponent}`,
      description: `${event.title}\n\nMore info: ${event.url}`,
      location: `${event.location || event.opponent}`,
      url: event.url
    });
  });

  fs.writeFileSync(CALENDAR_PATH, cal.toString());
  console.log('✅ iCal file created');
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const rawEvents = await fetchICS();
  const parsed = rawEvents.map(parseICSEvent).filter(Boolean);

  const missingISO = parsed.filter(e => !e.startISO);
  if (missingISO.length) {
    console.warn(`Found ${missingISO.length} events with missing startISO. Examples:`, missingISO.slice(0,3).map(e => ({ date: e.date, time: e.time, title: e.title })));
  }

  parsed.sort((a, b) => {
    const da = a.startISO ? DateTime.fromISO(a.startISO) : DateTime.invalid('no-start');
    const db = b.startISO ? DateTime.fromISO(b.startISO) : DateTime.invalid('no-start');
    const aMs = da.isValid ? da.toMillis() : Number.POSITIVE_INFINITY;
    const bMs = db.isValid ? db.toMillis() : Number.POSITIVE_INFINITY;
    return aMs - bMs;
  });
  fs.writeFileSync(COMBINED_PATH, JSON.stringify(parsed, null, 2));
  console.log(`📦 Wrote ${parsed.length} events to combined.json`);

  // Write per-sport schedule files
  const teams = JSON.parse(fs.readFileSync(TEAMS_PATH, 'utf-8'));
  const sports = [...new Set(teams.map(t => t.sportTitle))];

  for (const sportTitle of sports) {
    const sportGames = parsed.filter(e => e.sport === sportTitle);
    const sportSlug = sportTitle.toLowerCase().replace(/\s+/g, "-");
    const filePath = path.join(DATA_DIR, `${sportSlug}.json`);
    fs.writeFileSync(filePath, JSON.stringify(sportGames, null, 2));
    console.log(`✅ Wrote ${sportGames.length} events to ${sportSlug}.json`);
  }

  writeCalendar(parsed);
  console.log("🏁 Done.");
}

main();