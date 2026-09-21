// 主线程 <-> Worker 的 Promise 化客户端。
export class WorkerClient {
  constructor(url) {
    this.worker = new Worker(url, { type: 'module' });
    this.seq = 0;
    this.pending = new Map();
    this.progressListeners = new Set();
    this.worker.addEventListener('error', (event) => {
      const message = event.message || event.error?.message || 'Worker 加载或运行失败（请确认通过 http(s)://localhost 访问）';
      for (const { reject } of this.pending.values()) reject(new Error(message));
      this.pending.clear();
      if (this.onError) this.onError(message);
    });
    this.worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'progress') {
        for (const fn of this.progressListeners) fn(msg);
        return;
      }
      const pending = this.pending.get(msg.taskId);
      if (!pending) return;
      this.pending.delete(msg.taskId);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, name: msg.error.name }));
    };

  }

  onProgress(fn) {
    this.progressListeners.add(fn);
    return () => this.progressListeners.delete(fn);
  }

  call(type, payload = {}, { onProgress } = {}) {
    const taskId = payload.__taskId || `t${++this.seq}`;
    delete payload.__taskId;
    return new Promise((resolve, reject) => {
      let offProgress = null;
      const settle = (fn) => (value) => {
        if (offProgress) offProgress();
        fn(value);
      };
      this.pending.set(taskId, { resolve: settle(resolve), reject: settle(reject) });
      if (onProgress) {
        offProgress = this.onProgress((msg) => {
          if (msg.taskId === taskId) onProgress(msg);
        });
      }
      // 句柄等使用结构化克隆传递。
      this.worker.postMessage({ type, taskId, ...payload });
    });
  }
}
