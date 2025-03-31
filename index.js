import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// For __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load teams from JSON
const teams = JSON.parse(fs.readFileSync(path.join(__dirname, 'teams.json'), 'utf-8'));

// Config
const SCID = 'OH4451495857';
const RANGE_AFTER = '2024-07-01';
const RANGE_BEFORE = '2025-07-01';

// In-memory cache
const cache = {};

// Output folder
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

// Helper to clean events
function cleanEvents(edges = [], team) {
  return edges
    .map(({ node }) => {
      // Filter out practices, scrimmages, and non-athletic events
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
    .filter(Boolean); // Remove nulls from filtered events
}

// Fetch and clean schedule
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

// Main runner
async function run() {
  console.log(`📅 Fetching ${teams.length} team schedules...`);

  for (const team of teams) {
    try {
      console.log(`🔄 ${team.sport}...`);
      const data = await fetchSchedule(team);
      const filePath = path.join(DATA_DIR, `${team.sport}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      console.log(`✅ Wrote ${data.length} events to ${team.sport}.json`);
    } catch (err) {
      console.error(`❌ Failed for ${team.sport}: ${err.message}`);
    }
  
  // Merge all games across all teams
  const allGames = [];

  for (const team of teams) {
    const teamFile = path.join(DATA_DIR, `${team.sport}.json`);
    if (fs.existsSync(teamFile)) {
      const games = JSON.parse(fs.readFileSync(teamFile, 'utf-8'));
      allGames.push(...games);
    }
  }

  // Sort by date/time
  allGames.sort((a, b) => {
    const aDate = new Date(`${a.date} ${a.time}`);
    const bDate = new Date(`${b.date} ${b.time}`);
    return aDate - bDate;
  });

  const combinedPath = path.join(DATA_DIR, 'combined.json');
  fs.writeFileSync(combinedPath, JSON.stringify(allGames, null, 2));
  console.log(`📦 Wrote combined.json with ${allGames.length} total events.`);
  }

  console.log("🏁 Done.");
  process.exit(0);
}

// If called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
