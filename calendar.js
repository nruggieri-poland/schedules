import fs from 'fs';
import { DateTime } from 'luxon';
import ical from 'ical-generator';
import path from 'path';
import { fileURLToPath } from 'url';

// Needed to get __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const raw = fs.readFileSync(path.join(__dirname, 'data', 'combined.json'), 'utf-8');
const events = JSON.parse(raw);

const cal = ical({ name: 'PSHS Athletics Events' });

events.forEach(event => {
  if (event.isCancelled) return;

  const start = DateTime.fromFormat(`${event.date} ${event.time}`, 'MM/dd/yyyy hh:mm a', {
    zone: 'America/New_York',
  });

  const end = start.plus({ hours: 2 });

  cal.createEvent({
    start: start.toJSDate(),
    end: end.toJSDate(),
    summary: `${event.sport}: ${event.vsOrAt} ${event.opponent}`,
    description: `${event.title}\n\nMore info: ${event.url}`,
    location: event.location || event.opponent,
    url: event.url,
  });
});

cal.saveSync('pshs-athletics.ics');
console.log('✅ iCal file created: pshs-athletics.ics');