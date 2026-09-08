/**
 * list-buffer-channels.js
 *
 * One-off helper to look up the Buffer channelId values needed for
 * BUFFER_CHANNEL_ID_INSTAGRAM / _FACEBOOK / _TWITTER (see post-to-buffer.js).
 * Buffer's API has no "list everything" shortcut — organizations first, then
 * channels per organization — so this just does both calls and prints a
 * table.
 *
 * Usage:
 *   BUFFER_ACCESS_TOKEN=xxxxx node scripts/list-buffer-channels.js
 *
 * Get a token from https://publish.buffer.com/settings/api
 */

const BUFFER_API = 'https://api.buffer.com/graphql';
const TOKEN = process.env.BUFFER_ACCESS_TOKEN;

async function gql(query) {
  const res = await fetch(BUFFER_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data;
}

async function main() {
  if (!TOKEN) {
    console.error('Set BUFFER_ACCESS_TOKEN first — get one at https://publish.buffer.com/settings/api');
    process.exit(1);
  }

  const { account } = await gql(`
    query { account { organizations { id name ownerEmail } } }
  `);

  for (const org of account.organizations) {
    console.log(`\nOrganization: ${org.name} (${org.id})`);
    const { channels } = await gql(`
      query { channels(input: { organizationId: "${org.id}" }) {
        id name displayName service
      } }
    `);
    if (channels.length === 0) {
      console.log('  (no connected channels)');
      continue;
    }
    for (const ch of channels) {
      console.log(`  [${ch.service.padEnd(10)}] ${ch.displayName || ch.name}`);
      console.log(`               channelId: ${ch.id}`);
    }
  }

  console.log('\nCopy the channelId for each of your Instagram, Facebook, and Twitter/X channels');
  console.log('into GitHub repo secrets as BUFFER_CHANNEL_ID_INSTAGRAM / _FACEBOOK / _TWITTER.');
}

main().catch(err => { console.error(err.message); process.exit(1); });
