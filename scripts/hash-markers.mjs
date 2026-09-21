#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv } from 'node:process';

const target = argv[2] || join(process.cwd(), 'fixture-large');
const count = Number(argv[3] || 10);
const recordPath = argv[4] || join(process.cwd(), 'marker-hashes.json');

function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

const hashes = {};
for (let index = 0; index < count; index += 1) {
  const path = join(target, 'bucket-00', `file-${String(index).padStart(4, '0')}.bin`);
  hashes[path] = await hashFile(path);
}

try {
  const before = JSON.parse(await readFile(recordPath, 'utf8'));
  const changed = Object.entries(before).filter(([path, hash]) => hashes[path] !== hash);
  if (changed.length) {
    console.error(`Mismatch: ${changed.length} marker files differ from ${recordPath}`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${count} marker files match ${recordPath}`);
  }
} catch {
  await writeFile(recordPath, `${JSON.stringify(hashes, null, 2)}\n`);
  console.log(`Saved ${count} marker hashes to ${recordPath}`);
}
