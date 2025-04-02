const fs = require('fs');
const { DateTime } = require('luxon');
const ical = require('ical-generator');

const events = require('data/combined.json');
const cal = ical({ name: 'Poland Bulldogs Events' });

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

cal.saveSync('pshs-athletics-schedule.ics');
console.log('✅ iCal file created: calendar.ics');