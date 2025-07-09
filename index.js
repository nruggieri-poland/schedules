// Refactored version with your original fetch method logic

import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import ical from 'ical-generator';
import { DateTime } from 'luxon';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEAMS_PATH = path.join(__dirname, 'teams', 'teams.json');
const DATA_DIR = path.join(__dirname, 'dist', 'data');
const COMBINED_PATH = path.join(DATA_DIR, 'combined.json');
const CALENDAR_PATH = path.join(__dirname, 'dist', 'pshs-athletics.ics');

const SCID = 'OH4451495857';
const RANGE_AFTER = '2025-07-01';
const RANGE_BEFORE = '2026-07-01';

function cleanEvents(edges = [], team) {
  return edges
    .map(({ node }) => {
      if (
        node.eventType === "Practice" ||
        node.eventType === "Scrimmage" ||
        node.eventType === "School" ||
        node.title?.toLowerCase().includes("practice") ||
        node.title?.toLowerCase().includes("scrimmage") ||
        node.isScrimmage === true
      ) {
        return null;
      }

      const opponent = node.participants?.find(p => p.school?.name !== "Poland Seminary")?.school?.name || null;
      const location = node.facility?.facility?.name || null;
      const title = node.title || (opponent ? `${opponent}` : 'Game');

      if (opponent === "OPEN" && e.node.title) {
        opponent = title;
      }

      return {
        eventId: node.eventId,
        sport: team.sportTitle,
        date: node.eventDate,
        time: node.eventTime,
        title: title.trim(),
        homeOrAway: node.homeOrAway,
        vsOrAt: node.homeOrAway === "Home" ? "vs" : "@",
        location,
        opponent,
        result: node.results?.result || null,
        isCancelled: node.results?.isCancelled || false,
        isPostponed: node.results?.isPostponed || false,
        url: node.url
      };
    })
    .filter(Boolean);
}

async function fetchSchedule(team) {
  const payload = new URLSearchParams({
    genderid: team.genderid,
    levelid: '1',
    sportid: team.sportid,
    offset: '0',
    rangeafter: RANGE_AFTER,
    rangebefore: RANGE_BEFORE,
    scid: SCID,
    seasonid: team.seasonid,
    id: team.id,
    scoretype: '1',
    isfan: 'false'
  });

  const response = await fetch('https://polandbulldogs.org/main/ajaxteamschedule', {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'origin': 'https://polandbulldogs.org',
      'referer': `https://polandbulldogs.org/main/teamschedule/id/${team.id}/seasonid/${team.seasonid}`,
      'x-requested-with': 'XMLHttpRequest'
    },
    body: payload
  });

  const text = await response.text();
  const data = JSON.parse(text);
  const edges = data?.[0]?.fullSchedule?.edges || [];
  return cleanEvents(edges, team);
}

function writeCalendar(events) {
  const cal = ical({ name: 'PSHS Athletics Events' });

  events.forEach(event => {
    if (event.isCancelled || event.isPostponed || !event.date) return;

    const isTBA = !event.time || event.time === 'TBA';
    let start = isTBA
      ? DateTime.fromFormat(event.date, 'MM/dd/yyyy', { zone: 'America/New_York' })
      : DateTime.fromFormat(`${event.date} ${event.time}`, 'MM/dd/yyyy hh:mm a', { zone: 'America/New_York' });

    if (!start.isValid) return;
    const end = isTBA ? undefined : start.plus({ hours: 2 });

    cal.createEvent({
      start: start.toJSDate(),
      ...(end ? { end: end.toJSDate() } : {}),
      allDay: isTBA,
      summary: `${event.sport}: ${event.vsOrAt} ${event.opponent}`,
      description: `${event.title}\n\nMore info: ${event.url}`,
      location: `${event.homeOrAway} - ${event.location || event.opponent}`,
      url: event.url
    });
  });

  fs.writeFileSync(CALENDAR_PATH, cal.toString());
  console.log('✅ iCal file created');
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const teams = JSON.parse(fs.readFileSync(TEAMS_PATH, 'utf-8'));
  const allGames = [];

  for (const team of teams) {
    try {
      console.log(`🔄 ${team.sport}...`);
      const data = await fetchSchedule(team);
      const filePath = path.join(DATA_DIR, `${team.sport}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      console.log(`✅ Wrote ${data.length} events to ${team.sport}.json`);
      allGames.push(...data);
    } catch (err) {
      console.error(`❌ Failed for ${team.sport}: ${err.message}`);
    }
  }

  const todayStr = new Date().toDateString();
  const filteredGames = allGames.filter(game => {
    const gameDate = new Date(`${game.date} ${game.time}`).toDateString();
    return !(gameDate === game.isCancelled || game.isPostponed);
  });

  filteredGames.sort((a, b) => {
    const aDate = new Date(`${a.date} ${a.time}`);
    const bDate = new Date(`${b.date} ${b.time}`);
    return aDate - bDate;
  });

  fs.writeFileSync(COMBINED_PATH, JSON.stringify(filteredGames, null, 2));
  console.log(`📦 Wrote filtered combined.json with ${filteredGames.length} events.`);

  const cancelledToday = allGames.filter(game => {
    const gameDate = new Date(`${game.date} ${game.time}`).toDateString();
    return gameDate === todayStr && (game.isCancelled || game.isPostponed);
  });

  const cancelledPath = path.join(DATA_DIR, 'cancelled-today.json');
  fs.writeFileSync(cancelledPath, JSON.stringify(cancelledToday, null, 2));
  console.log(`🚫 Wrote ${cancelledToday.length} cancelled/postponed games to cancelled-today.json`);

  writeCalendar(filteredGames);
  console.log("🏁 Done.");
}

main();