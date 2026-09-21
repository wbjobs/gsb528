#!/usr/bin/env node
// 回滚后校验：被修改的 10 个文件必须恢复成修改前的字节（大小 + SHA-256）。
// 用法：node scripts/verify-rollback.js <fixture 目录>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.argv[2];
if (!root) { console.error('需要 fixture 目录参数'); process.exit(1); }
const record = JSON.parse(fs.readFileSync(path.join(root, 'modify-record.json'), 'utf8'));

let bad = 0;
for (const item of record) {
  const full = path.join(root, item.path);
  const stat = fs.statSync(full);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  const sizeOk = stat.size === item.beforeSize;
  const hashOk = hash === item.beforeHash;
  if (sizeOk && hashOk) {
    console.log(`✅ ${item.path} (${stat.size} B)`);
  } else {
    bad++;
    console.error(`❌ ${item.path} size=${stat.size}/${item.beforeSize} hashMatch=${hashOk}`);
  }
}
if (bad) { console.error(`\n${bad}/${record.length} 个文件未精确恢复`); process.exit(1); }
console.log(`\n🎉 全部 ${record.length} 个被修改文件均已精确恢复（字节级一致）`);
