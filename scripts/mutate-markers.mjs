#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, exit } from 'node:process';

const target = argv[2] || join(process.cwd(), 'fixture-large');
const count = Number(argv[3] || 10);
const version = argv[4] || `version-${Date.now()}`;

for (let index = 0; index < count; index += 1) {
  const path = join(target, 'bucket-00', `file-${String(index).padStart(4, '0')}.bin`);
  const previous = await readFile(path, 'utf8').catch(() => '');
  await writeFile(path, `${version}\n${previous}\nmutated-by-script\n`, 'utf8');
}

console.log(`Updated ${count} marker files with ${version}.`);
