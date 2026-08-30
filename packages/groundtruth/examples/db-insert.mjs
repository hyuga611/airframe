// A demonstration: what re-fetching catches that a return value does not.
//   node examples/db-insert.mjs
//
// The database is a fake held in memory, so this runs with nothing installed. In real work the
// probe is replaced by an actual re-fetch — a SQL count, an API GET, a stat on a file.

import { gate, verify, expect, GroundtruthIncomplete } from '../src/index.mjs';

// --- The fake. With drop:true the insert fails *silently*, the way real ones do. ---
const table = [];
async function insert(rows, { drop = false } = {}) {
  if (drop) return; // does nothing and throws nothing: the worst kind of failure there is
  table.push(...rows);
}
const countBatch = (batch) => table.filter((r) => r.batch === batch).length;

async function run() {
  // Case 1: the insert works, the re-fetch finds 2, and completion can be claimed.
  await insert([{ batch: 1 }, { batch: 1 }]);
  const n = await gate({
    action: 'insert 2 rows with batch=1',
    probe: () => countBatch(1),      // real state, re-fetched — not what insert() returned
    expect: expect.count(2),
  });
  console.log(`✓ done can be claimed: the re-fetch found ${n}`);

  // Case 2: the insert fails silently, the re-fetch finds 0, and the gate blocks.
  try {
    await insert([{ batch: 2 }, { batch: 2 }], { drop: true }); // the swallowed failure
    await gate({
      action: 'insert 2 rows with batch=2',
      probe: () => countBatch(2),
      expect: expect.count(2),
    });
    console.log('! unreachable — getting here means a false completion went through');
  } catch (e) {
    if (e instanceof GroundtruthIncomplete) {
      console.log(`✓ false completion blocked: ${e.verdict.reason} / ${e.message.split('\n')[0]}`);
    } else throw e;
  }

  // Case 3: the probe itself fails, and that is not filled in as a success.
  const v = await verify({
    action: 'connect to the database and check',
    probe: () => { throw new Error('connection refused'); },
  });
  console.log(`✓ a failed probe is not swallowed: ok=${v.ok} reason=${v.reason}`);
}

run();
