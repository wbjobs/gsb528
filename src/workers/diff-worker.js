import { getSnapshotManifest } from '../core/db.js';
import { diffSnapshots } from '../core/diff.js';

let activeRequestId = null;

function post(type, payload = {}) {
  self.postMessage({ type, requestId: activeRequestId, ...payload });
}

function normalizeError(error) {
  return {
    name: error?.name ?? error?.constructor?.name ?? 'Error',
    message: error?.message ?? String(error),
    stack: error?.stack
  };
}

self.onmessage = async (event) => {
  const message = event.data;
  if (message.type !== 'diff') return;
  activeRequestId = message.requestId ?? null;
  try {
    post('progress', { message: 'Worker 正在加载两个快照清单…' });
    const [fromSnapshot, toSnapshot] = await Promise.all([
      getSnapshotManifest(message.fromId),
      getSnapshotManifest(message.toId)
    ]);
    if (!fromSnapshot || !toSnapshot) {
      throw new Error('找不到用于对比的快照，请刷新快照列表。');
    }
    post('progress', { message: 'Worker 正在计算逐文件和逐块差异…' });
    const result = diffSnapshots(fromSnapshot, toSnapshot);
    post('complete', { result });
  } catch (error) {
    post('error', { error: normalizeError(error) });
  }
};
