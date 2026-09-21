// 目录扫描：在 Worker 中运行，生成带内容寻址分块的完整快照。
import {
  DEFAULT_CHUNK_SIZE,
  emptyFileHash,
  pool,
  readFileChunked,
  walkDirectory,
} from '../js/lib/fs-helpers.js';
import { chunkExists, getSnapshot, listSnapshots, putChunks, putSnapshot } from '../js/lib/idb.js';

export async function runScan(db, rootHandle, options = {}) {
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  const signal = options.signal;
  const emit = options.emit || (() => {});

  // 上一快照：size+mtime 未变的文件直接复用分块哈希，不重读内容。
  const previous = options.previousSnapshot;
  const prevByPath = new Map();
  if (previous) for (const entry of previous.entries) prevByPath.set(entry.path, entry);

  const fileItems = [];
  const dirEntries = [];

  emit({ phase: 'walk', message: '遍历目录树…', files: 0, dirs: 0 });
  const walkState = await walkDirectory(rootHandle, {
    ignoreText: options.ignoreText || '',
    signal,
    onProgress: (info) => {
      if (info.phase === 'walk') {
        emit({
          phase: 'walk',
          message: `遍历 ${info.state.dirs} 目录 / ${info.state.files} 文件`,
          files: info.state.files,
          dirs: info.state.dirs,
        });
      }
    },
    visit: (item) => {
      if (item.kind === 'dir') {
        dirEntries.push({ kind: 'dir', path: item.path, name: basename(item.path), mtime: 0 });
      } else {
        fileItems.push(item);
      }
    },
  });

  const total = fileItems.length;
  let processed = 0;
  let changedFiles = 0;
  let totalBytes = 0;
  let newChunkBytes = 0;
  let lastEmit = 0;
  const fileEntries = new Array(total);
  const pendingChunks = [];
  const emptyHash = await emptyFileHash();

  const processFile = async (item, itemIndex) => {
    if (signal && signal.aborted) throw new DOMException('已中止', 'AbortError');
    const file = await item.handle.getFile();
    const prev = prevByPath.get(item.path);
    const sameMeta =
      prev && prev.kind === 'file' && prev.size === file.size && prev.mtime === file.lastModified;
    const unchanged = !!(prev && sameMeta);

    let chunks;
    if (unchanged) {
      chunks = prev.chunks.slice();
    } else {
      if (prev) changedFiles++; // 已存在于上一快照且元信息变化 = 修改；无 prev = 新增

      if (file.size === 0) {
        chunks = [emptyHash];
        if (!(await chunkExists(db, emptyHash))) {
          pendingChunks.push({ hash: emptyHash, size: 0, bytes: new Blob([]) });
          newChunkBytes += 0;
        }
      } else {
        const read = await readFileChunked(item.handle, chunkSize, {
          signal,
          onProgress: (done, size) => maybeEmit(item.path, done, size),
        });
        chunks = read.chunks.map((c) => c.hash);
        // 内容寻址：仅写入数据库中尚不存在的块（增量存储核心）。
        for (const c of read.chunks) {
          if (!(await chunkExists(db, c.hash))) {
            pendingChunks.push({ hash: c.hash, size: c.blob.size, bytes: c.blob });
            newChunkBytes += c.blob.size;
          }
        }
      }
      // 边扫描边批量落盘，避免大量 Blob 堆积。
      if (pendingChunks.length >= 16) await flushChunks();
    }

    totalBytes += file.size;
    fileEntries[itemIndex] = {
      kind: 'file',
      path: item.path,
      name: file.name,
      size: file.size,
      mtime: file.lastModified,
      chunks,
    };
    processed++;
    maybeEmit(item.path, 0, 0, true);
  };

  async function flushChunks() {
    if (pendingChunks.length === 0) return;
    const batch = pendingChunks.splice(0, pendingChunks.length);
    await putChunks(db, batch);
  }

  function maybeEmit(path, fileDone, fileSize, force = false) {
    const now = performance.now();
    if (!force && now - lastEmit < 150) return;
    lastEmit = now;
    emit({
      phase: 'hash',
      message: `读取/哈希 ${processed}/${total}：${path}`,
      processed,
      total,
      percent: total ? Math.round((processed / total) * 100) : 100,
      currentFile: path,
      fileDone,
      fileSize,
      changedFiles,
    });
  }

  await pool(fileItems, options.concurrency || 4, processFile);
  await flushChunks();

  const entries = [...dirEntries, ...fileEntries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  const snapshot = {
    id: options.id || `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    label: options.label || '',
    note: options.note || '',
    chunkSize,
    entries,
    stats: {
      files: walkState.files,
      dirs: walkState.dirs,
      totalBytes,
      changedFiles,
      newChunkBytes,
      skipped: walkState.skipped.length,
      inaccessible: walkState.inaccessible.length,
      skippedItems: walkState.skipped,
      inaccessibleItems: walkState.inaccessible,
      elapsedMs: walkState.elapsedMs,
    },
  };
  await putSnapshot(db, snapshot);
  emit({ phase: 'done', message: '快照已保存', processed: total, total });
  return { snapshot };
}

function basename(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export { getSnapshot, listSnapshots };
