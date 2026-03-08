import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { open } from 'lmdb';

test('lmdb fixture has a working native binary', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fixture-lmdb-test-'));
  const db = open({ path: dir });
  await db.put('k', 'v');
  assert.equal(await db.get('k'), 'v');
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});
