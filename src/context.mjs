import fs from 'node:fs/promises';
import path from 'node:path';
import { discoverProjectFiles } from './source-snapshot.mjs';

const MAX_FILE_BYTES = 1024 * 1024;
const SEP = '='.repeat(80);

export async function buildContextFile({ projectRoot, outputFile }) {
  const files = await discoverProjectFiles(projectRoot);
  const handle = await fs.open(outputFile, 'w');
  try {
    await handle.writeFile('# LLM_CONTEXT\n\n');
    await handle.writeFile('FILE TREE\n');
    await handle.writeFile('---------\n');
    for (const relPath of files) {
      await handle.writeFile(`${relPath}\n`);
    }
    await handle.writeFile('\nFILE CONTENTS\n');
    await handle.writeFile('-------------\n');
    for (const relPath of files) {
      const absPath = path.join(projectRoot, relPath);
      const stat = await fs.lstat(absPath);
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(absPath);
        await handle.writeFile(`${SEP}\nFILE: ${relPath}\n${SEP}\n`);
        await handle.writeFile(`[symlink] -> ${target}\n`);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) continue;
      const buffer = await fs.readFile(absPath);
      if (!isProbablyText(buffer)) continue;
      await handle.writeFile(`${SEP}\nFILE: ${relPath}\n${SEP}\n`);
      await handle.writeFile(buffer.toString('utf8'));
      if (!buffer.toString('utf8').endsWith('\n')) {
        await handle.writeFile('\n');
      }
    }
  } finally {
    await handle.close();
  }
}

function isProbablyText(buffer) {
  if (!buffer.length) return true;
  let suspicious = 0;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 14 && byte < 32 && byte !== 9)) suspicious += 1;
  }
  return suspicious / sample.length < 0.02;
}
