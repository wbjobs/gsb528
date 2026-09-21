export class WorkerClient {
  constructor(url) {
    this.worker = new Worker(url, { type: 'module' });
    this.pending = new Map();
    this.worker.onmessage = (event) => this.handleMessage(event.data);
    this.worker.onerror = (event) => {
      this.rejectAll(new Error(event.message || 'Worker 执行失败'));
    }
  }

  request(message, options = {}) {
    const requestId = globalThis.crypto.randomUUID();
    const payload = { ...message, requestId };
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        onProgress: options.onProgress
      });
      this.worker.postMessage(payload);
    });
  }

  post(message) {
    this.worker.postMessage(message);
  }

  handleMessage(message) {
    if (!message.requestId || !this.pending.has(message.requestId)) return;
    const pending = this.pending.get(message.requestId);
    if (message.type === 'progress') {
      pending.onProgress?.(message);
      return;
    }
    if (message.type === 'complete' || message.type === 'plan' || message.type === 'cancelled' || message.type === 'unchanged') {
      this.pending.delete(message.requestId);
      pending.resolve(message);
      return;
    }
    if (message.type === 'error') {
      this.pending.delete(message.requestId);
      pending.reject(Object.assign(new Error(message.error?.message || 'Worker 错误'), {
        name: message.error?.name,
        permission: message.error?.permission,
        details: message
      }));
    }
  }

  rejectAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  terminate() {
    this.rejectAll(new Error('Worker 已终止'));
    this.worker.terminate();
  }

  replace(url) {
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      pending.reject(Object.assign(new Error('Worker 已取消并重启'), { name: 'AbortError' }));
    }
    this.pending.clear();
    this.worker = new Worker(url, { type: 'module' });
    this.worker.onmessage = (event) => this.handleMessage(event.data);
  }
}
