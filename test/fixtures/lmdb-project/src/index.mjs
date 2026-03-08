import { sha256 } from 'mini-utils';
import { open } from 'lmdb';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const input = 'fixture-lmdb-project';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fixture-lmdb-'));
const db = open({ path: dir });

await db.put('value', { input, hash: sha256(input) });
console.log(await db.get('value'));

db.close();
await fs.rm(dir, { recursive: true, force: true });
