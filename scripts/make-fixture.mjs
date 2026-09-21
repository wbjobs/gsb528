#!/usr/bin/env node
import { mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, exit } from 'node:process';

const target = argv[2] || join(process.cwd(), 'fixture-large');
const fileCount = Number(argv[3] || 5000);
const totalBytes = Number(argv[4] || 2 * 1024 ** 3);
const markerCount = Number(argv[5] || 10);
const small = 4096;
const largeBytes = Math.max(0, Math.floor((totalBytes - fileCount * small) / Math.max(1, fileCount - 1)));

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function main() {
  await rm(target, { recursive: true, force: true });
  await ensureDir(target);
  for (let index = 0; index < fileCount; index += 1) {
    const bucket = join(target, `bucket-${String(Math.floor(index / 250)).padStart(2, '0')}`);
    await ensureDir(bucket);
    const path = join(bucket, `file-${String(index).padStart(4, '0')}.bin`);
    const marker = index < markerCount;
    await writeFile(path, marker
      ? `version-0 marker ${index}\n`.repeat(24)
      : Buffer.allocUnsafe(small).fill(index % 251));
    if (!marker) {
      await truncate(path, largeBytes + small);
    }
  }
  await ensureDir(join(target, 'symlinks'));
  await symlink(join(target, 'bucket-00'), join(target, 'symlinks', 'to-bucket'), 'dir').catch(() => {});
  await symlink(join(target, 'bucket-00', 'file-0000.bin'), join(target, 'symlinks', 'marker-link'), 'file').catch(() => {});
  console.log(JSON.stringify({
    target,
    files: fileCount,
    logicalBytesApprox: fileCount * small + (fileCount - markerCount) * largeBytes,
    markers: markerCount
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  exit(1);
});
