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
  const summary = evt.summary || '';
  if (!summary.includes("Poland Seminary High School")) return null;
  if (summary.toLowerCase().includes("scrimmage") || summary.toLowerCase().includes("practice")) return null;

  const cleaned = summary.replace("Poland Seminary High School ", "").trim();
  const parts = cleaned.split(" ");
  const hoaIndex = parts.findIndex(p => p === "Home" || p === "Away");
  if (hoaIndex === -1) return null;

  const homeOrAway = parts[hoaIndex];
  const sportCode = parts.slice(0, hoaIndex).join(" ");
  const opponentRaw = parts.slice(hoaIndex + 1).join(" ");
  const matchParen = opponentRaw.match(/\(([^)]+)\)/g);

  // Skip scrimmages
  if (matchParen && matchParen.some(p => p.toLowerCase().includes("scrimmage"))) return null;

  const extraTitle = matchParen
    ? matchParen.map(s => s.replace(/[()]/g, "").trim()).filter(t => t && !/scrimmage/i.test(t)).join(" - ")
    : null;

  let opponentComplete = opponentRaw.replace(/\s*\([^)]*\)/g, "").trim();
  let opponent = opponentComplete || "TBD";
  let title = extraTitle || opponent;

  if (opponent === "OPEN") {
    opponent = title;
    opponentComplete = title;
  }

  const sport = sportMap[sportCode] || sportCode;
  const dateObj = DateTime.fromJSDate(evt.start).setZone("America/New_York");
  const cleanDate = dateObj.toFormat("yyyy-MM-dd");
  const eventTime = evt.start ? dateObj.toFormat("h:mm a") : "TBA";
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
  };
}

function writeCalendar(events) {
  const cal = ical({ name: 'PSHS Athletics Events' });

  events.forEach(event => {
    if (event.isCancelled || event.isPostponed || !event.date) return;

    // Clean and normalize date/time strings before parsing
    const cleanDateStr = event.date.trim();
    const cleanTimeStr = event.time
      ? event.time.trim().toUpperCase().replace(/\s+/g, ' ')
      : '';

    const isTBA = !event.time || /^(TBA|TBD|NA)$/i.test(event.time);
    let start = isTBA
      ? DateTime.fromFormat(cleanDateStr, 'MM/dd/yyyy', { zone: 'America/New_York' })
      : DateTime.fromFormat(`${cleanDateStr} ${cleanTimeStr}`, 'MM/dd/yyyy h:mm a', { zone: 'America/New_York' });

    if (!start.isValid) {
      const pretty = `${cleanDateStr}${cleanTimeStr ? ' ' + cleanTimeStr : ''}`;
      console.warn(`\u26a0\ufe0f Skipping invalid date/time: ${pretty} (${event.title})`);
      return;
    }
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

  parsed.sort((a, b) => {
    const fmt = 'MM/dd/yyyy h:mm a';
    const aTime = a.time && a.time !== 'TBA' ? `${a.date} ${a.time}` : `${a.date} 11:59 PM`;
    const bTime = b.time && b.time !== 'TBA' ? `${b.date} ${b.time}` : `${b.date} 11:59 PM`;

    const da = DateTime.fromFormat(aTime, fmt, { zone: 'America/New_York' });
    const db = DateTime.fromFormat(bTime, fmt, { zone: 'America/New_York' });

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