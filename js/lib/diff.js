// 纯逻辑模块：快照条目、块差异、回滚计划。
// 不依赖任何浏览器 API，可直接在 Node 中运行测试。
//
// 快照条目（entry）结构：
//   目录: { kind:'dir',  path, name, mtime }
//   文件: { kind:'file', path, name, size, mtime, chunks:[chunkHash...] }
// 快照记录（snapshot）：
//   { id, createdAt, label, note, entries:[...], stats:{...} }

/** 计算分块哈希列表（调用方传入异步哈希函数 hashBytes->hex）。 */
export async function chunkHashesFromBlobChunks(blobChunks, hashBytes, chunkIndex = []) {
  for (let i = 0; i < blobChunks.length; i++) {
    chunkIndex.push(await hashBytes(blobChunks[i]));
  }
  return chunkIndex;
}

/** 按 path 建立条目索引。 */
export function indexEntries(entries) {
  const map = new Map();
  for (const entry of entries) map.set(entry.path, entry);
  return map;
}

/**
 * 对比两个完整快照的条目集合。
 * 返回 { added, removed, changed, unchanged, dirsAdded, dirsRemoved }，
 * 各项为 { path, old?, new?, entry? }。
 */
export function diffSnapshots(baseEntries, targetEntries) {
  const base = indexEntries(baseEntries);
  const target = indexEntries(targetEntries);
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  const dirsAdded = [];
  const dirsRemoved = [];

  for (const [path, next] of target) {
    const prev = base.get(path);
    if (!prev) {
      (next.kind === 'dir' ? dirsAdded : added).push({ path, entry: next });
    } else if (prev.kind !== next.kind) {
      changed.push({ path, old: prev, new: next, reason: 'type' });
    } else if (next.kind === 'file' && !sameFile(prev, next)) {
      changed.push({ path, old: prev, new: next, reason: fileChangeReason(prev, next) });
    } else {
      unchanged.push({ path, entry: next });
    }
  }
  for (const [path, prev] of base) {
    if (!target.has(path)) {
      (prev.kind === 'dir' ? dirsRemoved : removed).push({ path, entry: prev });
    }
  }
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  added.sort(byPath); removed.sort(byPath); changed.sort(byPath);
  unchanged.sort(byPath); dirsAdded.sort(byPath); dirsRemoved.sort(byPath);
  return { added, removed, changed, unchanged, dirsAdded, dirsRemoved };
}

export function sameFile(a, b) {
  if (a.size !== b.size) return false;
  if (a.chunks.length !== b.chunks.length) return false;
  for (let i = 0; i < a.chunks.length; i++) {
    if (a.chunks[i] !== b.chunks[i]) return false;
  }
  return true;
}

function fileChangeReason(prev, next) {
  return prev.size !== next.size ? 'size' : 'content';
}

/**
 * 块级差异（同一文件的两个版本）。
 * 返回新增/删除/修改的块下标，及按连续区间合并后的 ranges。
 */
export function diffFileBlocks(oldChunks, newChunks) {
  const oldSet = new Set(oldChunks);
  const newSet = new Set(newChunks);
  const kept = new Set();
  for (const h of newChunks) if (oldSet.has(h)) kept.add(h);

  const blocksAdded = [];
  const blocksRemoved = [];
  const blocksModified = [];
  const commonLen = Math.min(oldChunks.length, newChunks.length);
  for (let i = 0; i < commonLen; i++) {
    if (oldChunks[i] !== newChunks[i]) blocksModified.push({ index: i, old: oldChunks[i], new: newChunks[i] });
  }
  for (let i = commonLen; i < newChunks.length; i++) {
    if (!oldSet.has(newChunks[i])) blocksAdded.push({ index: i, hash: newChunks[i] });
  }
  for (let i = commonLen; i < oldChunks.length; i++) {
    if (!newSet.has(oldChunks[i])) blocksRemoved.push({ index: i, hash: oldChunks[i] });
  }
  return {
    blocksAdded,
    blocksRemoved,
    blocksModified,
    addedRanges: toRanges(blocksAdded.map((b) => b.index)),
    removedRanges: toRanges(blocksRemoved.map((b) => b.index)),
    modifiedRanges: toRanges(blocksModified.map((b) => b.index)),
    reusedChunks: kept.size,
  };
}

function toRanges(indexes) {
  const ranges = [];
  let start = null;
  let prev = null;
  for (const i of indexes) {
    if (start === null) { start = i; prev = i; }
    else if (i === prev + 1) { prev = i; }
    else { ranges.push([start, prev]); start = i; prev = i; }
  }
  if (start !== null) ranges.push([start, prev]);
  return ranges;
}

/**
 * 生成回滚操作计划：把当前树 currentEntries 恢复成 targetEntries。
 * 操作按依赖顺序排列：类型冲突修正/删除文件 -> 删除多余目录(深层优先) ->
 * 创建目录(浅层优先) -> 写入文件。
 */
export function planRollback(currentEntries, targetEntries) {
  const d = diffSnapshots(currentEntries, targetEntries);

  const deleteFiles = [];
  for (const item of d.removed) deleteFiles.push({ op: 'deleteFile', path: item.path });
  // 内容变化（同类型 file->file）只需重写；类型冲突交给 typeFixes，避免重复删除。
  for (const item of d.changed) {
    if (item.old.kind === 'file' && item.new.kind === 'file') {
      // writeFile 会截断重写，无需先删；此处不计删除。
    }
  }

  const typeFixes = [];
  for (const item of d.changed) {
    if (item.old.kind !== item.new.kind) {
      typeFixes.push({ op: item.old.kind === 'dir' ? 'deleteDir' : 'deleteFile', path: item.path });
      if (item.new.kind === 'dir') typeFixes.push({ op: 'mkdir', path: item.path });
    }
  }

  const deleteDirs = d.dirsRemoved
    .map((x) => x.path)
    .sort((a, b) => pathDepth(b) - pathDepth(a) || (a < b ? 1 : -1))
    .map((path) => ({ op: 'deleteDir', path }));

  const makeDirs = d.dirsAdded
    .map((x) => x.path)
    .sort((a, b) => pathDepth(a) - pathDepth(b) || (a < b ? -1 : 1))
    .map((path) => ({ op: 'mkdir', path }));

  const writeFiles = [];
  for (const item of d.added) writeFiles.push({ op: 'writeFile', path: item.path, entry: item.entry });
  for (const item of d.changed) {
    if (item.new.kind === 'file') writeFiles.push({ op: 'writeFile', path: item.path, entry: item.new });
  }
  writeFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    diff: d,
    operations: [...deleteFiles, ...typeFixes, ...deleteDirs, ...makeDirs, ...writeFiles],
    stats: {
      filesToWrite: writeFiles.length,
      filesToDelete: deleteFiles.length + typeFixes.filter((o) => o.op === 'deleteFile').length,
      dirsToCreate: makeDirs.length + typeFixes.filter((o) => o.op === 'mkdir').length,
      dirsToDelete: deleteDirs.length + typeFixes.filter((o) => o.op === 'deleteDir').length,
      unchanged: d.unchanged.length,
    },
  };
}

function pathDepth(p) {
  let n = 0;
  for (const ch of p) if (ch === '/') n++;
  return n;
}

/** 汇总差异统计。 */
export function summarizeDiff(d) {
  return {
    filesAdded: d.added.length,
    filesRemoved: d.removed.length,
    filesChanged: d.changed.length,
    filesUnchanged: d.unchanged.length,
    dirsAdded: d.dirsAdded.length,
    dirsRemoved: d.dirsRemoved.length,
  };
}
