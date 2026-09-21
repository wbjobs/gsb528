// IndexedDB 封装。
// 数据库：folder-snapshots v1
//   kv       (keyPath 'key')       存放目录句柄、配置等
//   snapshots(keyPath 'id')        快照记录（含完整 entries）
//   chunks   (keyPath 'hash')      内容寻址的文件块 {hash,size,bytes:Blob}
export const DB_NAME = 'folder-snapshots';
const DB_VERSION = 1;
const STORES = ['kv', 'snapshots', 'chunks'];

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'hash' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function reqPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function kvGet(db, key) {
  const row = await reqPromise(tx(db, 'kv', 'readonly').get(key));
  return row ? row.value : undefined;
}

export async function kvSet(db, key, value) {
  await reqPromise(tx(db, 'kv', 'readwrite').put({ key, value }));
}

export async function kvDelete(db, key) {
  await reqPromise(tx(db, 'kv', 'readwrite').delete(key));
}

export async function listSnapshots(db) {
  const rows = await reqPromise(tx(db, 'snapshots', 'readonly').getAll());
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getSnapshot(db, id) {
  return reqPromise(tx(db, 'snapshots', 'readonly').get(id));
}

export async function putSnapshot(db, snapshot) {
  await reqPromise(tx(db, 'snapshots', 'readwrite').put(snapshot));
}

/** 删除指定快照及其之后的所有快照（快照为全量回放语义，删除中间快照会级联）。 */
export async function deleteSnapshotAndAfter(db, id) {
  const all = await listSnapshots(db);
  const idx = all.findIndex((s) => s.id === id);
  if (idx === -1) return [];
  const removed = all.slice(idx);
  // 同一个事务内顺序提交请求，事务在事件循环任务结束前保持存活。
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('snapshots', 'readwrite');
    const store = transaction.objectStore('snapshots');
    for (const snap of removed) store.delete(snap.id);
    transaction.oncomplete = () => resolve(removed);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function chunkExists(db, hash) {
  const count = await reqPromise(
    tx(db, 'chunks', 'readonly').count(IDBKeyRange.only(hash)),
  );
  return count > 0;
}

/** 批量查询块是否存在，返回缺失的 hash 集合。 */
export async function missingChunks(db, hashes) {
  const unique = [...new Set(hashes)];
  const store = tx(db, 'chunks', 'readonly');
  const missing = new Set();
  await Promise.all(
    unique.map(async (hash) => {
      const n = await reqPromise(store.count(IDBKeyRange.only(hash)));
      if (n === 0) missing.add(hash);
    }),
  );
  return missing;
}

export async function putChunks(db, chunks) {
  if (chunks.length === 0) return;
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('chunks', 'readwrite');
    const store = transaction.objectStore('chunks');
    for (const c of chunks) store.put(c);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function getChunk(db, hash) {
  return reqPromise(tx(db, 'chunks', 'readonly').get(hash));
}

export async function getAllChunkKeys(db) {
  return reqPromise(tx(db, 'chunks', 'readonly').getAllKeys());
}

export async function deleteChunks(db, hashes) {
  const unique = [...new Set(hashes)];
  if (unique.length === 0) return;
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('chunks', 'readwrite');
    const store = transaction.objectStore('chunks');
    for (const h of unique) store.delete(h);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** 回收不再被任何快照引用的块，返回释放数量。 */
export async function gcChunks(db, onProgress) {
  const snapshots = await listSnapshots(db);
  const live = new Set();
  for (const s of snapshots) {
    for (const e of s.entries) {
      if (e.kind === 'file') for (const h of e.chunks) live.add(h);
    }
  }
  const keys = await getAllChunkKeys(db);
  const dead = keys.filter((h) => !live.has(h));
  const batch = 200;
  for (let i = 0; i < dead.length; i += batch) {
    await deleteChunks(db, dead.slice(i, i + batch));
    if (onProgress) onProgress(Math.min(i + batch, dead.length), dead.length);
  }
  return { removed: dead.length, kept: live.size };
}

export async function estimateStorage() {
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    return { usage: est.usage || 0, quota: est.quota || 0 };
  }
  return { usage: 0, quota: 0 };
}
