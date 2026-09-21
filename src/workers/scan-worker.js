import { commitSnapshot, getChunkBlob, getSnapshotManifest } from '../core/db.js';
import { isPermissionError, walkDirectory } from '../core/fs.js';
import { createSnapshot } from '../core/snapshot.js';

let abortController = null;
let running = false;
let lastProgressAt = 0;
let activeRequestId = null;

function post(type, payload = {}) {
  self.postMessage({ type, requestId: activeRequestId, ...payload });
}

function normalizeError(error) {
  const quota = error?.name === 'QuotaExceededError' || error?.code === 22;
  return {
    name: error?.name ?? error?.constructor?.name ?? 'Error',
    message: quota
      ? '浏览器本地存储配额不足。请删除旧快照、释放站点数据，或改用更小的目录。'
      : error?.message ?? String(error),
    permission: isPermissionError(error),
    quota,
    stack: error?.stack
  };
}

self.onmessage = async (event) => {
  const message = event.data;
  if (message.type !== 'start' || running) return;

  running = true;
  activeRequestId = message.requestId ?? null;
  abortController = new AbortController();
  post('progress', { phase: 'start', message: '正在遍历目录树…' });

  try {
    const previousManifest = message.previousId
      ? await getSnapshotManifest(message.previousId)
      : null;
    if (message.previousId && !previousManifest) {
      throw new Error('上一份快照清单不存在，无法计算增量引用。');
    }
    const walk = walkDirectory(message.root, { signal: abortController.signal });
    const { snapshot, newChunks, newChunkRefs } = await createSnapshot({
      rootId: message.rootId,
      rootName: message.root.name,
      previous: previousManifest,
      walk,
      storage: { getChunk: getChunkBlob },
      signal: abortController.signal,
      forceHash: Boolean(message.forceHash),
      chunkSize: message.chunkSize,
      onProgress: async (progress) => {
        const now = Date.now();
        if (progress.phase === 'hash' || now - lastProgressAt > 120) {
          lastProgressAt = now;
          post('progress', {
            progress,
            message: progress.phase === 'hash'
              ? `正在分块读取并哈希：${progress.hashedFiles}/${progress.totalFiles} 个文件`
              : `正在遍历：${progress.seen} 个条目`
          });
        }
      }
    });

    post('progress', {
      phase: 'commit',
      message: `正在写入 ${newChunks.size} 个新内容块…`
    });
    const contentChanged = previousManifest
      ? snapshot.stats.addedFiles > 0
        || snapshot.stats.removedFiles > 0
        || snapshot.stats.modifiedFiles > 0
      : true;
    if (!contentChanged) {
      post('unchanged', {
        stats: snapshot.stats,
        message: '目录内容与上一份快照一致，未创建重复快照。'
      });
      return;
    }
    await commitSnapshot(snapshot, newChunks, previousManifest, newChunkRefs);
    post('complete', { snapshot });
  } catch (error) {
    if (error?.name === 'AbortError') {
      post('cancelled', { error: normalizeError(error) });
    } else {
      post('error', { error: normalizeError(error) });
    }
  } finally {
    running = false;
    abortController = null;
    activeRequestId = null;
  }
};
