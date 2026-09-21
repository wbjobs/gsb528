import { getChunkBlob, getSnapshotManifest } from '../core/db.js';
import { isPermissionError } from '../core/fs.js';
import {
  buildRollbackPlan,
  executeRollbackPlan,
  inspectCurrentTree
} from '../core/rollback.js';

let activeRequestId = null;

function post(type, payload = {}) {
  self.postMessage({ type, requestId: activeRequestId, ...payload });
}

function normalizeError(error) {
  return {
    name: error?.name ?? error?.constructor?.name ?? 'Error',
    message: error?.message ?? String(error),
    permission: isPermissionError(error),
    stack: error?.stack
  };
}

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === 'plan') {
      activeRequestId = message.requestId ?? null;
      const target = await getSnapshotManifest(message.snapshotId);
      if (!target) throw new Error('找不到目标快照。');
      post('progress', { phase: 'inspect', message: 'Worker 正在遍历并哈希当前文件…' });
      const inspection = await inspectCurrentTree(message.root, target, {
        forceVerify: message.forceVerify !== false,
        onProgress: (progress) => post('progress', { progress })
      });
      const plan = buildRollbackPlan(target, inspection);
      post('plan', { plan });
      return;
    }

    if (message.type === 'execute') {
      activeRequestId = message.requestId ?? null;
      post('progress', { phase: 'execute', message: 'Worker 正在恢复文件和目录…' });
      const result = await executeRollbackPlan(
        message.root,
        message.plan,
        getChunkBlob,
        { onProgress: (progress) => post('progress', { progress }) }
      );
      if (!result.ok) {
        post('error', { error: normalizeError(result.error), result });
      } else {
        post('complete', { result });
      }
    }
  } catch (error) {
    post('error', { error: normalizeError(error) });
  }
};
