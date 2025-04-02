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
  if (!event.date) return;

  const isTBA = !event.time || event.time === 'TBA';

  let start;
  let end;
  let allDay = false;

  if (isTBA) {
    // Use all-day event
    start = DateTime.fromFormat(event.date, 'MM/dd/yyyy', {
      zone: 'America/New_York',
    });
    allDay = true;
  } else {
    start = DateTime.fromFormat(`${event.date} ${event.time}`, 'MM/dd/yyyy hh:mm a', {
      zone: 'America/New_York',
    });

    if (!start.isValid) {
      console.warn(`⚠️ Skipping invalid date/time: ${event.date} ${event.time} (${event.title})`);
      return;
    }

    end = start.plus({ hours: 2 });
  }

  cal.createEvent({
    start: start.toJSDate(),
    ...(end ? { end: end.toJSDate() } : {}),
    allDay,
    summary: `${event.sport}: ${event.vsOrAt} ${event.opponent}`,
    description: `${event.title}\n\nMore info: ${event.url}`,
    location: `${event.homeOrAway} - ${event.location || event.opponent}`,
    url: event.url,
  });
});

import { writeFileSync } from 'fs';

writeFileSync('pshs-athletics.ics', cal.toString());
console.log('✅ iCal file created: pshs-athletics.ics');