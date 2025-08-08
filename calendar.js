import fs from 'fs';
import { DateTime } from 'luxon';
import ical from 'ical-generator';
import path from 'path';
import { fileURLToPath } from 'url';

// Needed to get __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const raw = fs.readFileSync(path.join(__dirname, 'dist', 'data', 'combined.json'), 'utf-8');
const events = JSON.parse(raw);

const cal = ical({ name: 'PSHS Athletics Events' });

events.forEach(event => {
  if (event.isCancelled || event.isPostponed) return;
  if (!event.date) return;

  const isTBA = !event.time || /^(TBA|TBD|NA)$/i.test(String(event.time).trim());

  let start;
  let end;
  let allDay = false;

  if (isTBA) {
    start = DateTime.fromFormat(event.date, 'MM/dd/yyyy', {
      zone: 'America/New_York',
    });
    allDay = true;
    if (!start.isValid) {
      console.warn(`⚠️ Skipping invalid all-day date: ${event.date} (${event.title || event.opponent || 'no title'})`);
      return;
    }
  } else {
    // Normalize whitespace and AM/PM artifacts
    const dateStr = (event.date || '').trim();
    const timeStr = (event.time || '').toString().trim().replace(/\s*(AM|PM)\s*$/i, ' $1');

    // Try primary format first: single-digit hour allowed
    start = DateTime.fromFormat(`${dateStr} ${timeStr}`, 'MM/dd/yyyy h:mm a', { zone: 'America/New_York' });

    // Fallbacks for edge cases (e.g., non-zero-padded month/day)
    if (!start.isValid) {
      start = DateTime.fromFormat(`${dateStr} ${timeStr}`, 'M/d/yyyy h:mm a', { zone: 'America/New_York' });
    }
    if (!start.isValid) {
      // Some feeds might include seconds; try that too
      start = DateTime.fromFormat(`${dateStr} ${timeStr}`, 'MM/dd/yyyy h:mm:ss a', { zone: 'America/New_York' });
    }

    if (!start.isValid) {
      console.warn(`⚠️ Skipping invalid date/time: ${event.date} ${event.time} (${event.title || event.opponent || 'no title'})`);
      return;
    }

    end = start.plus({ hours: 2 });
  }

  // Final safety: if start somehow wasn't set (edge case), skip this event
  if (!start || !DateTime.isDateTime(start) || !start.isValid) {
    console.warn(`⚠️ Skipping event due to unset/invalid start: ${event.date} ${event.time || ''} (${event.title || event.opponent || 'no title'})`);
    return;
  }

  cal.createEvent({
    start: start.toJSDate(),
    ...(end ? { end: end.toJSDate() } : {}),
    allDay,
    summary: `${event.sport || 'Event'}: ${event.vsOrAt || ''} ${event.opponent || ''}`.trim(),
    description: `${event.title || ''}\n\nMore info: ${event.url || ''}`.trim(),
    location: [event.homeOrAway, (event.location || event.opponent || '').trim()].filter(Boolean).join(' - '),
    url: event.url,
  });
});

import { writeFileSync } from 'fs';

writeFileSync(path.join(__dirname, 'dist', 'pshs-athletics.ics'), cal.toString());
console.log('✅ iCal file created: pshs-athletics.ics');