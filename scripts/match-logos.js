/**
 * match-logos.js
 *
 * Matches each opponents.json entry to a logo file in the ohio_logos directory,
 * then writes the updated opponents.json with a "logo" field on every matched entry.
 *
 * Usage:
 *   node scripts/match-logos.js [--logos-dir /path/to/ohio_logos] [--write]
 *
 * Without --write it prints a report and exits dry-run.
 * With --write it updates opponents.json in place.
 *
 * Match strategy (tried in order):
 *   1. Exact slug: slugify(key) + '-' + slugify(mascot)
 *   2. Prefix:     any logo file whose name starts with slugify(key) + '-'
 *   3. Name prefix: any logo file whose name starts with slugify(canonical_name) + '-'
 *   4. No match   → flagged for manual review (logo field omitted)
 *
 * Aliases (multiple keys with the same name+mascot) are intentionally allowed to
 * resolve to the same logo file — e.g. "Girard High School" and "Girard Sr High School"
 * both resolve to girard-high-school-indians.png.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Args ─────────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const doWrite   = args.includes('--write');
const logosDirIdx = args.indexOf('--logos-dir');
const logosDirArg = args.find(a => a.startsWith('--logos-dir='))?.split('=')[1]
                 ?? (logosDirIdx >= 0 ? args[logosDirIdx + 1] : undefined);

const LOGOS_DIR       = logosDirArg
  ? path.resolve(logosDirArg)
  : path.resolve(__dirname, '..', '..', 'ohio_logos');
const OPPONENTS_PATH  = path.resolve(__dirname, '..', 'opponents.json');

// ── Slugify ───────────────────────────────────────────────────────────────────

function slugify(str) {
  return (str ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Load data ─────────────────────────────────────────────────────────────────

if (!fs.existsSync(LOGOS_DIR)) {
  console.error(`Logo directory not found: ${LOGOS_DIR}`);
  console.error('Pass --logos-dir=/path/to/ohio_logos to override.');
  process.exit(1);
}

const logoFiles = new Set(
  fs.readdirSync(LOGOS_DIR).filter(f => f.endsWith('.png'))
);
const opponents = JSON.parse(fs.readFileSync(OPPONENTS_PATH, 'utf-8'));

// ── Match ─────────────────────────────────────────────────────────────────────

const matched   = [];
const unmatched = [];
const updated   = {};

for (const [key, val] of Object.entries(opponents)) {
  const keySlug    = slugify(key);
  const nameSlug   = slugify(val.name);
  const mascotSlug = slugify(val.mascot);

  let logo = null;
  let how  = null;

  // Strategy 1: exact slug match (key + mascot)
  const exact = `${keySlug}-${mascotSlug}.png`;
  if (logoFiles.has(exact)) {
    logo = exact.replace(/\.png$/, '');
    how  = 'exact';
  }

  // Strategy 2: prefix match on key slug — catches mascot slug drift
  // (e.g. "Bluejays" in opponents.json vs "blue-jays" in filename)
  if (!logo) {
    const prefix  = keySlug + '-';
    const hits    = [...logoFiles].filter(f => f.startsWith(prefix));
    if (hits.length === 1) {
      logo = hits[0].replace(/\.png$/, '');
      how  = 'prefix(key)';
    } else if (hits.length > 1) {
      // Multiple files share this prefix — pick the one whose full slug
      // most closely matches key + mascot (shortest levenshtein proxy:
      // just pick the shortest filename, which is usually the canonical one).
      const best = hits.sort((a, b) => a.length - b.length)[0];
      logo = best.replace(/\.png$/, '');
      how  = `prefix(key)/multi(${hits.length})`;
    }
  }

  // Strategy 3: prefix match on canonical short name (for aliases where
  // EventLink uses a truncated name like "Fitch" vs "Austintown Fitch")
  if (!logo && nameSlug && nameSlug !== keySlug) {
    const prefix = nameSlug + '-';
    const hits   = [...logoFiles].filter(f => f.startsWith(prefix));
    if (hits.length === 1) {
      logo = hits[0].replace(/\.png$/, '');
      how  = 'prefix(name)';
    }
  }

  const entry = { ...val };
  if (logo) {
    entry.logo = logo;
    matched.push({ key, logo, how });
  } else {
    unmatched.push({ key, name: val.name, mascot: val.mascot });
  }
  updated[key] = entry;
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log(`\n=== Logo matching report ===`);
console.log(`  Logo directory : ${LOGOS_DIR}`);
console.log(`  Logo files     : ${logoFiles.size}`);
console.log(`  Opponents      : ${Object.keys(opponents).length}`);
console.log(`  Matched        : ${matched.length}`);
console.log(`  Unmatched      : ${unmatched.length}\n`);

if (unmatched.length) {
  console.log('--- Unmatched (no logo will be shown) ---');
  for (const { key, name, mascot } of unmatched) {
    console.log(`  "${key}"  →  ${name} ${mascot}`);
  }
  console.log();
}

const multiMatches = matched.filter(m => m.how.startsWith('prefix(key)/multi'));
if (multiMatches.length) {
  console.log('--- Multi-hit (shortest file was chosen — verify these) ---');
  for (const { key, logo, how } of multiMatches) {
    console.log(`  "${key}"  →  ${logo}  [${how}]`);
  }
  console.log();
}

console.log('--- Matched ---');
for (const { key, logo, how } of matched) {
  console.log(`  ${how.padEnd(20)} "${key}"  →  ${logo}`);
}
console.log();

// ── Write ─────────────────────────────────────────────────────────────────────

if (doWrite) {
  fs.writeFileSync(OPPONENTS_PATH, JSON.stringify(updated, null, 2) + '\n');
  console.log(`✓ opponents.json updated with ${matched.length} logo fields.`);
  if (unmatched.length) {
    console.log(`  ${unmatched.length} entries left without a logo field — add manually if needed.`);
  }
} else {
  console.log('Dry run — pass --write to update opponents.json.');
}
