import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSeason,
  formatTime12h,
  parseSportAndLevel,
  diffEvents,
  summariseEvent,
} from '../fetch.js';

// ── computeSeason ─────────────────────────────────────────────────────────────

test('computeSeason: Fall — Aug event uses school year start', () => {
  assert.equal(computeSeason('2026-08-28', 'Fall'), '2026');
});

test('computeSeason: Fall — Spring-month event uses previous school year start', () => {
  assert.equal(computeSeason('2027-03-01', 'Fall'), '2026');
});

test('computeSeason: Winter — Dec event spans both years', () => {
  assert.equal(computeSeason('2026-12-10', 'Winter'), '2026-2027');
});

test('computeSeason: Winter — Feb event spans both years', () => {
  assert.equal(computeSeason('2027-02-15', 'Winter'), '2026-2027');
});

test('computeSeason: Spring — Apr event uses school year end', () => {
  assert.equal(computeSeason('2027-04-10', 'Spring'), '2027');
});

test('computeSeason: school year boundary — July is start of new year', () => {
  assert.equal(computeSeason('2026-07-01', 'Fall'), '2026');
});

test('computeSeason: school year boundary — June is end of year', () => {
  assert.equal(computeSeason('2027-06-30', 'Spring'), '2027');
});

// ── formatTime12h ─────────────────────────────────────────────────────────────

test('formatTime12h: afternoon time', () => {
  assert.equal(formatTime12h('14:30'), '02:30 PM');
});

test('formatTime12h: morning time', () => {
  assert.equal(formatTime12h('09:00'), '09:00 AM');
});

test('formatTime12h: noon is PM', () => {
  assert.equal(formatTime12h('12:00'), '12:00 PM');
});

test('formatTime12h: midnight is AM', () => {
  assert.equal(formatTime12h('00:00'), '12:00 AM');
});

test('formatTime12h: null returns TBA', () => {
  assert.equal(formatTime12h(null), 'TBA');
});

test('formatTime12h: undefined returns TBA', () => {
  assert.equal(formatTime12h(undefined), 'TBA');
});

// ── parseSportAndLevel ────────────────────────────────────────────────────────

test('parseSportAndLevel: recognizes Boys Varsity basketball', () => {
  const r = parseSportAndLevel('Basketball (Boys V) vs. Fitch');
  assert.ok(r, 'should not return null');
  assert.equal(r.sport.slug, 'boys-basketball');
  assert.equal(r.level.slug, 'varsity');
  assert.equal(r.gender, 'Boys');
});

test('parseSportAndLevel: recognizes Girls JV volleyball', () => {
  const r = parseSportAndLevel('Volleyball (Girls JV) @ Springfield');
  assert.ok(r);
  assert.equal(r.sport.slug, 'volleyball');
  assert.equal(r.level.slug, 'jv');
  assert.equal(r.gender, 'Girls');
});

test('parseSportAndLevel: normalizes Coed to Co-ed', () => {
  const r = parseSportAndLevel('Cross Country (Coed V) @ Team');
  assert.ok(r);
  assert.equal(r.gender, 'Co-ed');
});

test('parseSportAndLevel: returns null for unrecognized sport', () => {
  assert.equal(parseSportAndLevel('Badminton (Boys V) vs. Team'), null);
});

test('parseSportAndLevel: returns null for unrecognized level code', () => {
  assert.equal(parseSportAndLevel('Football (Boys X) vs. Team'), null);
});

test('parseSportAndLevel: returns null when format does not match', () => {
  assert.equal(parseSportAndLevel('No parens here'), null);
});

test('parseSportAndLevel: recognizes Swim & Dive (Coed)', () => {
  const r = parseSportAndLevel('Swim & Dive (Coed V) vs. Warren');
  assert.ok(r);
  assert.equal(r.sport.slug, 'swim-dive');
  assert.equal(r.gender, 'Co-ed');
});

// ── diffEvents ────────────────────────────────────────────────────────────────

const makeEvent = (overrides = {}) => ({
  eventId:     'evt-1',
  eventDate:   '2026-09-01',
  eventTime:   '07:00 PM',
  homeOrAway:  'Home',
  opponent:    'Fitch',
  location:    'Bulldogs Stadium',
  isCancelled: false,
  isPostponed: false,
  isTimeTBD:   false,
  sport:       'Football',
  levelSlug:   'varsity',
  ...overrides,
});

test('diffEvents: detects added event', () => {
  const { added, removed, changed } = diffEvents([], [makeEvent()]);
  assert.equal(added.length, 1);
  assert.equal(removed.length, 0);
  assert.equal(changed.length, 0);
});

test('diffEvents: detects removed event', () => {
  const { added, removed, changed } = diffEvents([makeEvent()], []);
  assert.equal(added.length, 0);
  assert.equal(removed.length, 1);
  assert.equal(changed.length, 0);
});

test('diffEvents: detects changed field', () => {
  const prev = [makeEvent({ eventTime: '07:00 PM' })];
  const next = [makeEvent({ eventTime: '06:00 PM' })];
  const { changed } = diffEvents(prev, next);
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0].fields, ['eventTime']);
  assert.equal(changed[0].before.eventTime, '07:00 PM');
  assert.equal(changed[0].after.eventTime, '06:00 PM');
});

test('diffEvents: detects cancellation as a change', () => {
  const prev = [makeEvent({ isCancelled: false })];
  const next = [makeEvent({ isCancelled: true })];
  const { added, removed, changed } = diffEvents(prev, next);
  assert.equal(added.length, 0);
  assert.equal(removed.length, 0);
  assert.equal(changed.length, 1);
  assert.ok(changed[0].fields.includes('isCancelled'));
});

test('diffEvents: no diff when events are identical', () => {
  const events = [makeEvent()];
  const { added, removed, changed } = diffEvents(events, [...events]);
  assert.equal(added.length, 0);
  assert.equal(removed.length, 0);
  assert.equal(changed.length, 0);
});

test('diffEvents: handles empty prev and next', () => {
  const { added, removed, changed } = diffEvents([], []);
  assert.equal(added.length, 0);
  assert.equal(removed.length, 0);
  assert.equal(changed.length, 0);
});

// ── summariseEvent ────────────────────────────────────────────────────────────

test('summariseEvent: returns exactly the expected fields', () => {
  const full = makeEvent({
    levelLabel:       'Varsity',
    vsOrAt:           'vs',
    opponentComplete: 'Fitch Falcons',
    sportSlug:        'football',
    levelGroup:       'varsity',
    _time24:          '19:00',
    cleanDate:        '09/01',
  });
  const s = summariseEvent(full);
  assert.deepEqual(Object.keys(s).sort(), [
    'eventDate', 'eventId', 'isCancelled', 'isPostponed',
    'levelLabel', 'opponentComplete', 'sport', 'vsOrAt',
  ].sort());
});

test('summariseEvent: preserves field values', () => {
  const full = makeEvent({
    levelLabel: 'Varsity', vsOrAt: 'vs', opponentComplete: 'Fitch Falcons',
  });
  const s = summariseEvent(full);
  assert.equal(s.eventId, 'evt-1');
  assert.equal(s.sport, 'Football');
  assert.equal(s.opponentComplete, 'Fitch Falcons');
  assert.equal(s.isCancelled, false);
});
