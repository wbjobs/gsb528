// 端到端语义模拟（Node 真实文件系统 + 与 Worker 相同的 planRollback）：
//   1) 在临时目录生成 5100 文件的夹具
//   2) “基线快照”：4MB 分块 + SHA-256，内容寻址块存入 Map
//   3) 修改恰好 10 个文件（覆盖/追加/截断）
//   4) “新快照”：重新分块扫描，断言 diff 恰为 10 changed
//   5) planRollback 并用块数据回滚
//   6) SHA-256 校验 10 个文件与基线字节完全一致
// 用法：node tests/rollback.sim.test.mjs [fixtureGb=0.02]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, statSync, readFileSync, writeFileSync, openSync, writeSync, ftruncateSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { diffSnapshots, planRollback } from '../js/lib/diff.js';

const CHUNK = 4 * 1024 * 1024;
const gb = process.argv[2] || '0.02';
const root = mkdtempSync(path.join(tmpdir(), 'snap-sim-'));
const chunks = new Map(); // hash -> Buffer
let walkCount = 0;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function walk(dir, rel = '', out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const p = rel ? `${rel}/${name}` : name;
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push({ kind: 'dir', path: p, name, mtime: Math.floor(st.mtimeMs) });
      walk(full, p, out);
    } else {
      out.push({ kind: 'file', path: p, name, size: st.size, mtime: Math.floor(st.mtimeMs), full: full });
    }
  }
  return out;
}

function scan() {
  const entries = walk(root);
  for (const e of entries) {
    if (e.kind !== 'file') continue;
    walkCount++;
    const buf = readFileSync(e.full);
    const hashes = [];
    for (let off = 0; off < buf.length || (buf.length === 0 && off === 0); off += CHUNK) {
      const part = buf.subarray(off, Math.min(off + CHUNK, buf.length));
      const h = sha256(part);
      hashes.push(h);
      if (!chunks.has(h)) chunks.set(h, Buffer.from(part));
      if (buf.length === 0) break;
    }
    e.chunks = hashes;
    delete e.full;
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  return entries;
}

function hashOf(full) {
  return sha256(readFileSync(full));
}

console.log('生成夹具…');
execFileSync('node', [path.join(import.meta.dirname, '../scripts/make-fixture.js'), root, '--gb', gb], { stdio: 'inherit' });

console.log('基线快照（分块读取）…');
const base = scan();
const baseFiles = base.filter((e) => e.kind === 'file');

// 修改 10 个文件（与 scripts/modify-files.js 相同的三种方式）
const targets = baseFiles.filter((f) => f.size > 4096).slice(2, 12);
if (targets.length !== 10) throw new Error(`测试夹具不足：选中 ${targets.length}`);
const before = targets.map((f) => {
  const full = path.join(root, f.path);
  return { path: f.path, size: f.size, hash: hashOf(full) };
});
targets.forEach((f, i) => {
  const full = path.join(root, f.path);
  const fd = openSync(full, 'r+');
  if (i % 3 === 0) {
    writeSync(fd, Buffer.from(`MODIFIED-${i}-${'A'.repeat(48)}`), 0, 58, Math.floor(f.size / 2));
  } else if (i % 3 === 1) {
    writeSync(fd, Buffer.from(`\nAPPENDED-${i}`), null, null, f.size);
  } else {
    ftruncateSync(fd, Math.max(1, f.size - 128));
    writeSync(fd, Buffer.from(`TRUNCATED-${i}`), 0, 11, 0);
  }
  closeSync(fd);
});

console.log('修改后重新快照…');
const current = scan();
const diff = diffSnapshots(base, current);
const changed = diff.changed.filter((c) => c.old.kind === 'file' && c.new.kind === 'file');
console.log(`diff: +${diff.added.length} -${diff.removed.length} ~${changed.length}（文件）`);
if (changed.length !== 10) {
  console.error('❌ diff 应恰好报告 10 个修改文件，实际:', changed.map((c) => c.path));
  process.exit(1);
}
const changedPaths = changed.map((c) => c.path).sort();
const expectedPaths = before.map((b) => b.path).sort();
if (JSON.stringify(changedPaths) !== JSON.stringify(expectedPaths)) {
  console.error('❌ diff 路径集合不匹配');
  process.exit(1);
}

console.log('生成回滚计划并执行…');
const plan = planRollback(current, base);
let writes = 0;
for (const op of plan.operations) {
  const full = path.join(root, op.path);
  if (op.op === 'writeFile') {
    const parts = op.entry.chunks.map((h) => chunks.get(h));
    if (parts.some((p) => !p)) throw new Error(`缺少块: ${op.path}`);
    writeFileSync(full, Buffer.concat(parts));
    writes++;
  } else if (op.op === 'mkdir') {
    mkdirSync(full, { recursive: true });
  } else if (op.op === 'deleteFile' || op.op === 'deleteDir') {
    // 本场景没有新增/删除；若有应真实删除
  }
}
console.log(`写入文件 ${writes} 个（其余 ${plan.stats.unchanged} 条目不动）`);

console.log('校验 10 个文件字节级一致…');
let bad = 0;
for (const b of before) {
  const full = path.join(root, b.path);
  const st = statSync(full);
  const h = hashOf(full);
  if (st.size !== b.size || h !== b.hash) {
    console.error(`❌ ${b.path} ${st.size}/${b.size} hash=${h === b.hash}`);
    bad++;
  }
}
// 未改动文件抽检：分块存储是内容寻址的，额外验证未变文件仍可读
const untouched = baseFiles.find((f) => !expectedPaths.includes(f.path));
if (statSync(path.join(root, untouched.path)).size !== untouched.size) {
  console.error('❌ 未修改文件被波及');
  bad++;
}

rmSync(root, { recursive: true, force: true });
if (bad) { console.error(`\n❌ ${bad} 项失败`); process.exit(1); }
console.log(`\n🎉 集成模拟通过：10/10 修改文件精确恢复，共扫描 ${walkCount} 文件次，去重块 ${chunks.size}`);

