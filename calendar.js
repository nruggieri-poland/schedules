import fs from 'fs';
import { DateTime } from 'luxon';
import ical from 'ical-generator';
import events from '/data/combined.json' assert { type: 'json' };

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