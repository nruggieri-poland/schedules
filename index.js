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

// Output folders
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Helper to clean events
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

// Generate HTML blocks for each game
function generateGameHTML(games) {
  return games.map(game => {
    const dateObj = new Date(`${game.date} ${game.time}`);
    const dateStr = dateObj.toLocaleDateString(undefined, {
      weekday: "short", month: "short", day: "numeric"
    });

    const statusDot = game.isCancelled
      ? '<span class="status-dot dot-red"></span>'
      : game.isPostponed
      ? '<span class="status-dot dot-yellow"></span>'
      : '<span class="status-dot dot-green"></span>';

    const titleClass = game.isCancelled ? 'title cancelled' : 'title';

    return `
    <div class="game compact" data-sport="${game.sport}" data-date="${game.date}">
      <div class="${titleClass}">
        ${statusDot}<strong>${game.sport}</strong><br>${game.vsOrAt} ${game.opponent}
      </div>
      <div class="meta">
        <div>${dateStr} | ${game.time}</div>
      </div>
    </div>`;
  }).join('\n');
}

// Create final static index.html
function generateStaticHTML(games) {
  const scheduleHTML = generateGameHTML(games);
  const templatePath = path.join(__dirname, 'template.html');
  const template = fs.readFileSync(templatePath, 'utf-8');
  const outputPath = path.join(__dirname, 'index.html');

  const updated = template.replace(
    /<div id="schedule" class="game-list compact">[\s\S]*?<\/div>/,
    `<div id="schedule" class="game-list compact">\n${scheduleHTML}\n</div>`
  );

  const stripped = updated.replace(
    /<script>[\s\S]*?<\/script>/g,
    ''
  );

  fs.writeFileSync(outputPath, stripped);
  console.log(`✅ Wrote static index.html with ${games.length} events`);
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
  }

  // Combine all data
  const allGames = [];

  for (const team of teams) {
    const teamFile = path.join(DATA_DIR, `${team.sport}.json`);
    if (fs.existsSync(teamFile)) {
      const games = JSON.parse(fs.readFileSync(teamFile, 'utf-8'));
      allGames.push(...games);
    }
  }

  allGames.sort((a, b) => {
    const aDate = new Date(`${a.date} ${a.time}`);
    const bDate = new Date(`${b.date} ${b.time}`);
    return aDate - bDate;
  });

  const combinedPath = path.join(DATA_DIR, 'combined.json');
  fs.writeFileSync(combinedPath, JSON.stringify(allGames, null, 2));
  console.log(`📦 Wrote combined.json with ${allGames.length} total events.`);

  generateStaticHTML(allGames);
  console.log("🏁 Done.");
}

// If called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}