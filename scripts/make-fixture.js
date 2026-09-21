#!/usr/bin/env node
// 生成验收用目录树：默认约 5100 个文件、总大小约 2GB（稀疏写入，不实际占满磁盘）。
// 用法：
//   node scripts/make-fixture.js /tmp/snap-fixture            # 2GB（稀疏文件）
//   node scripts/make-fixture.js /tmp/snap-small --gb 0.05    # 小体积冒烟测试
//
// 注意：稀疏文件在 Chromium 中 getFile().slice().arrayBuffer() 会读到真实的零，
// 浏览器经内核看到的大小仍为声明大小，哈希内容确定（全零）。
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const gbArg = process.argv.indexOf('--gb');
const targetGb = gbArg >= 0 ? Number(process.argv[gbArg + 1]) : 2;
if (!root) {
  console.error('用法: node scripts/make-fixture.js <目标目录> [--gb 2]');
  process.exit(1);
}

const FILES = 5100;
const DIRS = 120;

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

// 目录分布
const dirs = [];
for (let d = 0; d < DIRS; d++) {
  const rel = path.join('branch' + Math.floor(d / 12), `sub_${String(d).padStart(3, '0')}`);
  fs.mkdirSync(path.join(root, rel), { recursive: true });
  dirs.push(rel);
}

// 文件大小规划：
//   2 个大文件占总目标的 20%（压测 4MB 分块），30 个中等文件(3~6MB)，
//   其余小文件平均摊薄到目标总大小（2GB / 5100 时每个约 385KB）。
const GB = 1024 * 1024 * 1024;
const totalBytes = Math.round(targetGb * GB);
const plan = new Array(FILES).fill(0);
let used = 0;
plan[0] = Math.floor(totalBytes * 0.12);
plan[1] = Math.floor(totalBytes * 0.08);
used = plan[0] + plan[1];
for (let i = 2; i < 32; i++) {
  plan[i] = 3 * 1024 * 1024 + ((i * 31337) % (3 * 1024 * 1024));
  used += plan[i];
}
const restFiles = FILES - 32;
const restBytes = Math.max(0, totalBytes - used);
const each = Math.floor(restBytes / restFiles);
let carry = restBytes - each * restFiles;
for (let i = 32; i < FILES; i++) {
  plan[i] = each + (carry-- > 0 ? 1 : 0);
}

let sum = 0;
const manifest = [];
for (let i = 0; i < FILES; i++) {
  const dir = dirs[i % dirs.length];
  const name = `file_${String(i).padStart(5, '0')}.bin`;
  const rel = path.join(dir, name);
  const full = path.join(root, rel);
  const size = Math.max(0, plan[i]);
  const fd = fs.openSync(full, 'w');
  // 每个文件写入一个由序号决定的小块，其余稀疏填零，保证内容确定且互不相同。
  const header = Buffer.alloc(64);
  header.write(`fixture:${i}:${size}:`);
  fs.writeSync(fd, header, 0, header.length, 0);
  if (size > header.length) fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
  sum += size;
  manifest.push({ path: rel.split(path.sep).join('/'), size });
}
// 写一个校验清单，供后续“修改/校验”脚本使用。
fs.writeFileSync(path.join(root, 'fixture-manifest.json'), JSON.stringify(manifest));
console.log(`已生成 ${FILES} 文件 / ${DIRS} 目录，声明总大小 ${(sum / 1024 / 1024 / 1024).toFixed(2)} GB`);
console.log(root);
