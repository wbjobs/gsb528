// Web Worker：所有扫描、diff、回滚重活都在这里，主线程只负责 UI。
import {
  deleteChunks,
  deleteSnapshotAndAfter,
  gcChunks,
  getChunk,
  getSnapshot,
  listSnapshots,
  openDB,
} from '../js/lib/idb.js';
import { diffFileBlocks, diffSnapshots, summarizeDiff } from '../js/lib/diff.js';
import { runScan } from './scanner.js';
import { planRollbackScan, runRollback } from './rollback.js';

let dbPromise = null;
const tasks = new Map();
let taskSeq = 0;

function db() {
  if (!dbPromise) dbPromise = openDB();
  return dbPromise;
}

function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

function makeSignal(taskId) {
  const controller = new AbortController();
  tasks.set(taskId, controller);
  const emit = (progress) => post('progress', { taskId, ...progress });
  return { signal: controller.signal, emit, done: () => tasks.delete(taskId) };
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  const taskId = msg.taskId || `t${++taskSeq}`;
  try {
    switch (msg.type) {
      case 'ping':
        post('pong', { taskId });
        break;
      case 'listSnapshots':
        post('result', { taskId, ok: true, result: await listSnapshots(await db()) });
        break;
      case 'getSnapshot':
        post('result', { taskId, ok: true, result: await getSnapshot(await db(), msg.id) });
        break;
      case 'scan': {
        const ctx = makeSignal(taskId);
        try {
          const database = await db();
          let previous = null;
          if (msg.baselineId) {
            previous = await getSnapshot(database, msg.baselineId);
          } else {
            // 默认基于最新快照做增量（size+mtime 未变则复用块哈希，不重读文件）。
            const all = await listSnapshots(database);
            previous = all.at(-1) || null;
          }
          const { snapshot } = await runScan(database, msg.rootHandle, {
            previousSnapshot: previous,
            label: msg.label,
            note: msg.note,
            chunkSize: msg.chunkSize,
            ignoreText: msg.ignoreText,
            concurrency: msg.concurrency,
            signal: ctx.signal,
            emit: ctx.emit,
          });
          post('result', { taskId, ok: true, result: { snapshot } });
        } finally {
          ctx.done();
        }
        break;
      }
      case 'diff': {
        const database = await db();
        const [a, b] = await Promise.all([getSnapshot(database, msg.baseId), getSnapshot(database, msg.targetId)]);
        if (!a || !b) throw new Error('快照不存在，可能已被删除');
        const diff = diffSnapshots(a.entries, b.entries);
        // 文件级结果附带块差异（不回传全部块哈希，只给索引/区间，控制消息体积）。
        const fileChanges = diff.changed
          .filter((c) => c.old.kind === 'file' && c.new.kind === 'file')
          .map((c) => ({
            path: c.path,
            reason: c.reason,
            oldSize: c.old.size,
            newSize: c.new.size,
            block: diffFileBlocks(c.old.chunks, c.new.chunks),
          }));
        post('result', {
          taskId,
          ok: true,
          result: {
            summary: summarizeDiff(diff),
            added: diff.added.map((x) => ({ path: x.path, size: x.entry.size })),
            removed: diff.removed.map((x) => ({ path: x.path, size: x.entry.size })),
            changed: fileChanges,
            dirsAdded: diff.dirsAdded.map((x) => x.path),
            dirsRemoved: diff.dirsRemoved.map((x) => x.path),
            base: { id: a.id, label: a.label, createdAt: a.createdAt },
            target: { id: b.id, label: b.label, createdAt: b.createdAt },
          },
        });
        break;
      }
      case 'rollback': {
        const ctx = makeSignal(taskId);
        try {
          const database = await db();
          const target = await getSnapshot(database, msg.targetId);
          if (!target) throw new Error('目标快照不存在');
          if (msg.planOnly) {
            const result = await planRollbackScan(database, msg.rootHandle, target, {
              chunkSize: msg.chunkSize,
              ignoreText: msg.ignoreText,
              concurrency: msg.concurrency,
              signal: ctx.signal,
              emit: ctx.emit,
            });
            post('result', { taskId, ok: true, result });
            return;
          }
          const result = await runRollback(database, msg.rootHandle, target, {
            chunkSize: msg.chunkSize,
            ignoreText: msg.ignoreText,
            concurrency: msg.concurrency,
            signal: ctx.signal,
            emit: ctx.emit,
          });
          post('result', { taskId, ok: true, result });
        } finally {
          ctx.done();
        }
        break;
      }
      case 'deleteSnapshot': {
        const database = await db();
        const removed = await deleteSnapshotAndAfter(database, msg.id);
        post('result', { taskId, ok: true, result: { removed: removed.map((s) => s.id) } });
        break;
      }
      case 'gc': {
        const database = await db();
        const result = await gcChunks(database, (done, total) =>
          post('progress', { taskId, phase: 'gc', processed: done, total }),
        );
        post('result', { taskId, ok: true, result });
        break;
      }
      case 'readFile': {
        const database = await db();
        const snapshot = await getSnapshot(database, msg.snapshotId);
        const entry = snapshot.entries.find((e) => e.path === msg.path);
        if (!entry || entry.kind !== 'file') throw new Error('该快照中找不到此文件');
        const chunks = [];
        for (const hash of entry.chunks) {
          const record = await getChunk(database, hash);
          if (!record) {
            const err = new Error('缺少快照块数据');
            err.code = 'MISSING_CHUNK';
            throw err;
          }
          chunks.push(record.bytes);
        }
        const blob = new Blob(chunks, { type: 'application/octet-stream' });
        post('result', { taskId, ok: true, result: { blob, size: entry.size, mtime: entry.mtime } });
        break;
      }
      case 'abort': {
        const controller = tasks.get(msg.abortTaskId);
        if (controller) controller.abort();
        post('aborted', { taskId: msg.abortTaskId });
        break;
      }
      default:
        throw new Error(`未知任务类型: ${msg.type}`);
    }
  } catch (error) {
    post('result', {
      taskId,
      ok: false,
      error: { message: String(error.message || error), code: error.code || null, name: error.name || null },
    });
  }
};
