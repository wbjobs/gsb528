#!/usr/bin/env node
// 修改指定目录中恰好 10 个文件（覆盖/追加/截断混合），并把原始状态写入 manifest，
// 供 verify-rollback.js 校验“回滚能精确恢复这 10 个文件”。
// 用法：node scripts/modify-files.js <fixture 目录> [数量=10]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.argv[2];
const count = Number(process.argv[3] || 10);
if (!root) { console.error('需要 fixture 目录参数'); process.exit(1); }

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'fixture-manifest.json'), 'utf8'));
const chosen = manifest.filter((f) => f.size > 4096).slice(2, 2 + count);
const record = [];

function hashFile(full) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(full));
  return h.digest('hex');
}

for (let i = 0; i < chosen.length; i++) {
  const item = chosen[i];
  const full = path.join(root, item.path);
  const beforeHash = hashFile(full);
  const beforeSize = item.size;
  const fd = fs.openSync(full, 'r+');
  if (i % 3 === 0) {
    // 覆盖中部
    const pos = Math.floor(beforeSize / 2);
    fs.writeSync(fd, Buffer.from(`MODIFIED-${i}-${'A'.repeat(48)}`), 0, 58, pos);
  } else if (i % 3 === 1) {
    // 追加
    fs.writeSync(fd, Buffer.from(`\nAPPENDED-${i}`), null, null, beforeSize);
  } else {
    // 截断后重写开头
    fs.ftruncateSync(fd, Math.max(1, beforeSize - 128));
    fs.writeSync(fd, Buffer.from(`TRUNCATED-${i}`), 0, 11, 0);
  }
  fs.closeSync(fd);
  record.push({ path: item.path, beforeSize, beforeHash });
}
fs.writeFileSync(path.join(root, 'modify-record.json'), JSON.stringify(record, null, 2));
console.log(`已修改 ${record.length} 个文件，记录写入 modify-record.json`);
for (const r of record) console.log(' -', r.path);
