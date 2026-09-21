// 回滚执行（Worker 内运行）：扫描当前树 -> 生成计划 -> 在真实目录上执行。
import {
  DEFAULT_CHUNK_SIZE,
  emptyFileHash,
  isPermissionError,
  pool,
  readFileChunked,
  walkDirectory,
} from '../js/lib/fs-helpers.js';
import { chunkExists, getChunk } from '../js/lib/idb.js';
import { planRollback } from '../js/lib/diff.js';

export async function planRollbackScan(db, rootHandle, targetSnapshot, options = {}) {
  const signal = options.signal;
  const emit = options.emit || (() => {});
  emit({ phase: 'scan', message: '扫描当前目录生成回滚计划…', processed: 0, total: 0 });
  const currentEntries = await scanCurrent(db, rootHandle, options, emit, signal);
  const plan = planRollback(currentEntries, targetSnapshot.entries);
  return { alreadyMatch: plan.operations.length === 0, report: plan.stats, operationCount: plan.operations.length };
}

export async function runRollback(db, rootHandle, targetSnapshot, options = {}) {
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  const signal = options.signal;
  const emit = options.emit || (() => {});

  // 1) 扫描当前树（仅哈希内容未知的文件），得到当前完整条目集。
  emit({ phase: 'scan', message: '回滚前扫描当前目录…', processed: 0, total: 0 });
  const currentEntries = await scanCurrent(db, rootHandle, options, emit, signal);

  // 2) 计划。
  const plan = planRollback(currentEntries, targetSnapshot.entries);
  if (plan.operations.length === 0) {
    return { alreadyMatch: true, report: plan.stats, operations: [] };
  }
  if (options.planOnly) {
    return { alreadyMatch: false, planOnly: true, report: plan.stats, operationCount: plan.operations.length };
  }
  emit({
    phase: 'apply',
    message: `执行 ${plan.operations.length} 个变更…`,
    total: plan.operations.length,
    processed: 0,
  });

  // 3) 校验目标文件所需块都存在。
  const needed = new Set();
  for (const op of plan.operations) {
    if (op.op === 'writeFile') for (const h of op.entry.chunks) needed.add(h);
  }
  for (const h of needed) {
    if (!(await chunkExists(db, h))) {
      const error = new Error(`快照数据不完整：缺少块 ${h.slice(0, 12)}…（可能被浏览器清理）`);
      error.code = 'MISSING_CHUNK';
      throw error;
    }
  }

  // 4) 执行。删除/建目录用低并发，写文件可并发。
  const results = [];
  let done = 0;
  const writeOps = plan.operations.filter((op) => op.op === 'writeFile');
  const fsOps = plan.operations.filter((op) => op.op !== 'writeFile');

  for (const op of fsOps) {
    if (signal && signal.aborted) throw new DOMException('已中止', 'AbortError');
    try {
      await applyFsOp(rootHandle, op);
      results.push({ op: op.op, path: op.path, ok: true });
    } catch (err) {
      if (isPermissionError(err)) throw toPermissionError(err);
      if (err.name === 'NotFoundError' && (op.op === 'deleteFile' || op.op === 'deleteDir')) {
        results.push({ op: op.op, path: op.path, ok: true, note: 'already-gone' });
      } else {
        results.push({ op: op.op, path: op.path, ok: false, error: String(err.message || err) });
      }
    }
    done++;
    emit({ phase: 'apply', processed: done, total: plan.operations.length, current: op.path });
  }

  await pool(writeOps, options.concurrency || 3, async (op) => {
    if (signal && signal.aborted) throw new DOMException('已中止', 'AbortError');
    try {
      await writeFromSnapshot(db, rootHandle, op.entry, chunkSize, signal);
      results.push({ op: 'writeFile', path: op.path, ok: true });
    } catch (err) {
      if (isPermissionError(err)) throw toPermissionError(err);
      results.push({ op: 'writeFile', path: op.path, ok: false, error: String(err.message || err) });
    }
    done++;
    emit({ phase: 'apply', processed: done, total: plan.operations.length, current: op.path });
  });

  const failed = results.filter((r) => !r.ok);
  return {
    alreadyMatch: false,
    report: plan.stats,
    operations: results,
    failed,
    success: failed.length === 0,
  };
}

function toPermissionError(err) {
  const error = new Error('目录权限已被撤销，无法写入。请在页面上重新授权后重试。');
  error.code = 'PERMISSION_DENIED';
  error.cause = err;
  return error;
}

async function scanCurrent(db, rootHandle, options, emit, signal) {
  const fileItems = [];
  const dirEntries = [];
  const walkState = await walkDirectory(rootHandle, {
    ignoreText: options.ignoreText || '',
    signal,
    visit: (item) => {
      if (item.kind === 'dir') {
        dirEntries.push({ kind: 'dir', path: item.path, name: basename(item.path), mtime: 0 });
      } else {
        fileItems.push(item);
      }
    },
  });
  const total = fileItems.length;
  const entries = new Array(total);
  const emptyHash = await emptyFileHash();
  let processed = 0;
  await pool(fileItems, options.concurrency || 4, async (item, itemIndex) => {
    if (signal && signal.aborted) throw new DOMException('已中止', 'AbortError');
    const file = await item.handle.getFile();
    let chunks;
    if (file.size === 0) {
      chunks = [emptyHash];
    } else {
      const read = await readFileChunked(item.handle, options.chunkSize || DEFAULT_CHUNK_SIZE, { signal });
      chunks = read.chunks.map((c) => c.hash);
    }
    entries[itemIndex] = {
      kind: 'file',
      path: item.path,
      name: file.name,
      size: file.size,
      mtime: file.lastModified,
      chunks,
    };
    processed++;
    if (processed % 25 === 0 || processed === total) {
      emit({ phase: 'scan', processed, total, percent: total ? Math.round((processed / total) * 100) : 100 });
    }
  });
  return [...dirEntries, ...entries.filter(Boolean)].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

async function applyFsOp(rootHandle, op) {
  const parts = op.path.split('/');
  if (op.op === 'mkdir') {
    await ensureDir(rootHandle, parts);
  } else if (op.op === 'deleteDir') {
    const parent = await descend(rootHandle, parts.slice(0, -1));
    await parent.removeEntry(parts[parts.length - 1], { recursive: true });
  } else if (op.op === 'deleteFile') {
    const parent = await descend(rootHandle, parts.slice(0, -1));
    await parent.removeEntry(parts[parts.length - 1], { recursive: false });
  }
}

async function writeFromSnapshot(db, rootHandle, entry, chunkSize, signal) {
  const parts = entry.path.split('/');
  const parent = await ensureDir(rootHandle, parts.slice(0, -1));
  let handle = await findChild(parent, parts[parts.length - 1]);
  if (handle && handle.kind === 'directory') {
    // 路径类型冲突：删除目录后重建为文件。
    await parent.removeEntry(parts[parts.length - 1], { recursive: true });
    handle = null;
  }
  if (!handle) handle = await parent.getFileHandle(parts[parts.length - 1], { create: true });

  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    let offset = 0;
    for (const hash of entry.chunks) {
      if (signal && signal.aborted) throw new DOMException('已中止', 'AbortError');
      if (entry.size === 0) break;
      const record = await getChunk(db, hash);
      if (!record) {
        const err = new Error(`缺少块 ${hash.slice(0, 12)}…`);
        err.code = 'MISSING_CHUNK';
        throw err;
      }
      await writable.write({ type: 'write', position: offset, data: record.bytes });
      offset += record.bytes.size;
    }
  } finally {
    await writable.close();
  }
}

async function findChild(dirHandle, name) {
  try {
    return await dirHandle.getFileHandle(name);
  } catch {
    return null;
  }
}

async function descend(rootHandle, parts) {
  let dir = rootHandle;
  for (const part of parts) {
    if (!part) continue;
    dir = await dir.getDirectoryHandle(part);
  }
  return dir;
}

async function ensureDir(rootHandle, parts) {
  let dir = rootHandle;
  for (const part of parts) {
    if (!part) continue;
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

function basename(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}
