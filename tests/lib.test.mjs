// Node 纯逻辑测试：node tests/lib.test.mjs
import {
  diffFileBlocks,
  diffSnapshots,
  planRollback,
  summarizeDiff,
} from '../js/lib/diff.js';
import { isIgnored, parseIgnore } from '../js/lib/ignore.js';

let passed = 0;
let failed = 0;
function assert(cond, message) {
  if (cond) { passed++; }
  else { failed++; console.error(`✗ ${message}`); }
}
function eq(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected),
    `${message}\n  expected=${JSON.stringify(expected)}\n  actual  =${JSON.stringify(actual)}`);
}

const file = (path, size, chunks, mtime = 1000) =>
  ({ kind: 'file', path, name: path.split('/').pop(), size, mtime, chunks });
const dir = (path) => ({ kind: 'dir', path, name: path.split('/').pop(), mtime: 0 });

// --- 场景：10 个文件被修改的增量快照 ---
const baseEntries = [];
for (let i = 1; i <= 20; i++) {
  const name = `f${String(i).padStart(2, '0')}.txt`;
  baseEntries.push(file(name, 10, [`h${i}-a`, `h${i}-b`], 1000));
}
baseEntries.push(dir('docs'));
baseEntries.push(file('docs/readme.md', 5, ['hr1'], 1000));

// 新快照：修改 10 个文件 f01-f10（每个第二块变化），删除 f11，新增 2 个文件。
const targetEntries = baseEntries
  .filter((e) => e.path !== 'f11.txt')
  .map((e) => {
    const m = /^f(\d+)\.txt$/.exec(e.path);
    if (m && Number(m[1]) <= 10 && e.kind === 'file') {
      return file(e.path, 10, [e.chunks[0], `h${m[1]}-B`], 2000);
    }
    return e;
  });
targetEntries.push(file('new1.log', 3, ['hn1'], 2000));
targetEntries.push(file('docs/new2.md', 4, ['hn2'], 2000));
targetEntries.push(dir('docs/newdir'));

const d = diffSnapshots(baseEntries, targetEntries);
const s = summarizeDiff(d);
eq(s.filesAdded, 2, '应有 2 个新增文件');
eq(s.filesRemoved, 1, '应有 1 个删除文件');
eq(s.filesChanged, 10, '应有恰好 10 个修改文件（验收项）');
eq(s.dirsAdded, 1, '应有 1 个新增目录');
eq(s.filesUnchanged, baseEntries.length - 1 - 10, '其余文件应保持不变');
eq(d.changed.map((c) => c.path),
  ['f01.txt','f02.txt','f03.txt','f04.txt','f05.txt','f06.txt','f07.txt','f08.txt','f09.txt','f10.txt'],
  '修改集合应恰好为 f01-f10（f11 被删除而非修改）');

// --- 块级差异：第一块复用、第二块修改 ---
const blockDiff = diffFileBlocks(['h2-a', 'h2-b'], ['h2-a', 'h2-B']);
eq(blockDiff.modifiedRanges, [[1, 1]], '块 1(下标1) 被修改');
assert(blockDiff.reusedChunks >= 1, '应有块被复用（增量存储）');

// 相同内容重排：块哈希相同但顺序变了 -> 同下标比较能识别
const reordered = diffFileBlocks(['a', 'b', 'c'], ['a', 'c', 'b']);
eq(reordered.modifiedRanges, [[1, 2]], '块顺序变化应识别为修改');

// --- 回滚计划：从 target 恢复到 base，必须精确覆盖 10 个修改文件 ---
const rollback = planRollback(targetEntries, baseEntries);
const writes = rollback.operations.filter((o) => o.op === 'writeFile');
const writePaths = writes.map((o) => o.path).sort();
eq(writes.length, 11, '回滚写文件数 = 10 修改 + 1 恢复删除（新增文件走删除）');
for (let i = 1; i <= 10; i++) {
  const name = `f${String(i).padStart(2, '0')}.txt`;
  const op = writes.find((o) => o.path === name);
  assert(op, `回滚必须覆盖修改文件 ${name}`);
  if (op) eq(op.entry.chunks, [`h${i}-a`, `h${i}-b`], `${name} 恢复为基线块哈希`);
}
assert(writes.some((o) => o.path === 'f01.txt'), '必须恢复被删除的 f01.txt');
assert(rollback.operations.some((o) => o.op === 'deleteFile' && o.path === 'new1.log'), '必须删除新增文件');
assert(writes.some((o) => o.path === 'f11.txt'), '必须恢复被删除的 f11.txt');
assert(rollback.operations.some((o) => o.op === 'deleteFile' && o.path === 'docs/new2.md'), '必须删除新增嵌套文件');
assert(rollback.operations.some((o) => o.op === 'deleteDir' && o.path === 'docs/newdir'), '必须删除新增目录');
assert(!rollback.operations.some((o) => o.op === 'writeFile' && o.path === 'f12.txt'), '未变化文件不应出现在回滚操作中');

// 目录删除顺序深于创建，保证递归删除安全
const deleteDirIdxs = rollback.operations
  .map((o, i) => (o.op === 'deleteDir' ? i : -1)).filter((i) => i >= 0);
for (let i = 1; i < deleteDirIdxs.length; i++) {
  assert(
    rollback.operations[deleteDirIdxs[i - 1]].path.split('/').length >=
      rollback.operations[deleteDirIdxs[i]].path.split('/').length,
    '删除目录应深层优先',
  );
}

// --- 类型冲突：file <-> dir ---
const typeCurrent = [file('x', 1, ['xa']), dir('y')];
const typeTarget = [dir('x'), file('y', 2, ['ya', 'yb'])];
const typePlan = planRollback(typeCurrent, typeTarget);
const xOps = typePlan.operations.filter((o) => o.path === 'x').map((o) => o.op);
const yOps = typePlan.operations.filter((o) => o.path === 'y').map((o) => o.op);
assert(xOps.includes('deleteFile') && xOps.includes('mkdir'), 'x: file→dir 需要 deleteFile+mkdir');
assert(yOps.includes('deleteDir') && yOps.includes('writeFile'), 'y: dir→file 需要 deleteDir+writeFile');

// --- 空树 / 完全一致 ---
assert(planRollback(baseEntries, baseEntries).operations.length === 0, '完全一致时回滚操作应为 0');
assert(summarizeDiff(diffSnapshots([], [])).filesAdded === 0, '空树 diff 为 0');

// --- 忽略规则 ---
const rules = parseIgnore(['node_modules/', '*.log', '/build', 'src/tmp', '# comment', ''].join('\n'));
assert(isIgnored('a/node_modules', 'dir', rules), 'node_modules/ 匹配任意层级目录');
assert(!isIgnored('node_modules.txt', 'file', rules), 'node_modules/ 不匹配文件');
assert(isIgnored('x/y.log', 'file', rules), '*.log 按 basename 匹配');
assert(isIgnored('build', 'dir', rules), '/build 匹配根目录');
assert(!isIgnored('a/build', 'dir', rules), '/build 不匹配子目录');
assert(isIgnored('src/tmp/a', 'file', rules), 'src/tmp 按路径前缀匹配');
assert(!isIgnored('other/x', 'file', rules), '无关路径不忽略');

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
