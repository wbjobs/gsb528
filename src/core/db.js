const DB_NAME = 'local-folder-snapshots';
const DB_VERSION = 1;

export const STORES = Object.freeze({
  roots: 'roots',
  snapshotSummaries: 'snapshotSummaries',
  snapshotManifests: 'snapshotManifests',
  chunkMeta: 'chunkMeta',
  chunkBlobs: 'chunkBlobs'
});

let dbPromise;
let databaseFactory = () => indexedDB.open(DB_NAME, DB_VERSION);

export function __setDatabaseFactoryForTesting(factory) {
  dbPromise = null;
  databaseFactory = factory ?? (() => indexedDB.open(DB_NAME, DB_VERSION));
}

export function openDatabase() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = databaseFactory();
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORES.roots)) {
          db.createObjectStore(STORES.roots, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.snapshotSummaries)) {
          const store = db.createObjectStore(STORES.snapshotSummaries, { keyPath: 'id' });
          store.createIndex('rootCreatedAt', ['rootId', 'createdAt']);
        }
        if (!db.objectStoreNames.contains(STORES.snapshotManifests)) {
          db.createObjectStore(STORES.snapshotManifests, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.chunkMeta)) {
          db.createObjectStore(STORES.chunkMeta, { keyPath: 'hash' });
        }
        if (!db.objectStoreNames.contains(STORES.chunkBlobs)) {
          db.createObjectStore(STORES.chunkBlobs, { keyPath: 'hash' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('IndexedDB 被其它标签页阻塞，请关闭旧页面后重试。'));
    });
  }
  return dbPromise;
}

export function requestDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeNames, mode, callback) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
    const stores = Array.isArray(storeNames)
      ? Object.fromEntries(storeNames.map((name) => [name, transaction.objectStore(name)]))
      : transaction.objectStore(storeNames);
    let result;
    let callbackFinished = false;
    transaction.oncomplete = () => {
      if (callbackFinished) resolve(result);
    };
    transaction.onerror = () => {
      reject(transaction.error);
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB 事务已中止'));
    };
    Promise.resolve(callback(stores, transaction)).then(
      (value) => {
        result = value;
        callbackFinished = true;
      },
      (error) => {
        transaction.abort();
        reject(error);
      }
    );
  });
}

function snapshotSummary(snapshot) {
  const summary = { ...snapshot };
  delete summary.entries;
  delete summary.errors;
  return summary;
}

export async function addChunkReferences(stores, hash, delta, blob) {
  const meta = await requestDone(stores.chunkMeta.get(hash));
  if (meta) {
    await requestDone(stores.chunkMeta.put({ ...meta, refs: meta.refs + delta }));
    return;
  }
  if (!blob) throw new Error(`内容块 ${hash.slice(0, 10)} 缺少二进制数据`);
  await requestDone(stores.chunkMeta.put({
    hash,
    bytes: blob.size,
    refs: delta
  }));
  await requestDone(stores.chunkBlobs.put({ hash, blob }));
}

export async function adjustChunkReference(stores, hash, delta) {
  const meta = await requestDone(stores.chunkMeta.get(hash));
  if (!meta) {
    if (delta < 0) return;
    throw new Error(`内容块 ${hash.slice(0, 10)} 缺少引用元数据`);
  }
  const refs = meta.refs + delta;
  if (refs <= 0) {
    await requestDone(stores.chunkMeta.delete(hash));
    await requestDone(stores.chunkBlobs.delete(hash));
  } else {
    await requestDone(stores.chunkMeta.put({ ...meta, refs }));
  }
}

export function allChunks(entries) {
  const chunks = new Map();
  for (const entry of Object.values(entries)) {
    if (entry.kind !== 'file') continue;
    for (const chunk of entry.chunks ?? []) {
      chunks.set(chunk.hash, (chunks.get(chunk.hash) ?? 0) + 1);
    }
  }
  return chunks;
}

export async function deleteSnapshotInTransaction(stores, snapshotId) {
  const manifest = await requestDone(stores.snapshotManifests.get(snapshotId));
  if (!manifest) return;
  for (const [hash, refs] of allChunks(manifest.entries)) {
    await adjustChunkReference(stores, hash, -refs);
  }
  await requestDone(stores.snapshotManifests.delete(snapshotId));
  await requestDone(stores.snapshotSummaries.delete(snapshotId));
}

export async function saveRoot(root) {
  await withStore(STORES.roots, 'readwrite', (store) => store.put(root));
}

export async function getRoot(rootId) {
  return withStore(STORES.roots, 'readonly', (store) => requestDone(store.get(rootId)));
}

export async function listRoots() {
  const roots = await withStore(STORES.roots, 'readonly', (store) => requestDone(store.getAll()));
  return roots.sort((a, b) => b.createdAt - a.createdAt);
}

export async function commitSnapshot(snapshot, chunkBlobs, previousSnapshot = null, newChunkRefs = null) {
  const storeNames = [
    STORES.snapshotSummaries,
    STORES.snapshotManifests,
    STORES.chunkMeta,
    STORES.chunkBlobs
  ];
  await withStore(storeNames, 'readwrite', async (stores) => {
    const previousRefs = allChunks(previousSnapshot?.entries ?? {});
    const currentRefs = allChunks(snapshot.entries);
    for (const [hash, refs] of currentRefs) {
      const delta = refs - (previousRefs.get(hash) ?? 0);
      const initialRefs = newChunkRefs?.get(hash);
      const effectiveDelta = initialRefs ? initialRefs : delta;
      if (effectiveDelta > 0) {
        await addChunkReferences(stores, hash, effectiveDelta, chunkBlobs.get(hash));
      }
    }
    await requestDone(stores.snapshotSummaries.put(snapshotSummary(snapshot)));
    await requestDone(stores.snapshotManifests.put({
      id: snapshot.id,
      rootId: snapshot.rootId,
      createdAt: snapshot.createdAt,
      entries: snapshot.entries,
      errors: snapshot.errors ?? []
    }));
  });
}

export async function listSnapshotSummaries(rootId) {
  return withStore(
    [STORES.snapshotSummaries],
    'readonly',
    async (stores) => {
      const index = stores.snapshotSummaries.index('rootCreatedAt');
      const range = IDBKeyRange.only(rootId);
      return requestDone(index.getAll(range));
    }
  );
}

export async function getSnapshotManifest(snapshotId) {
  return withStore(
    STORES.snapshotManifests,
    'readonly',
    (store) => requestDone(store.get(snapshotId))
  );
}

export async function getChunkBlob(hash) {
  const record = await withStore(
    STORES.chunkBlobs,
    'readonly',
    (store) => requestDone(store.get(hash))
  );
  return record?.blob;
}

export async function deleteSnapshot(snapshotId) {
  await withStore(
    [STORES.snapshotSummaries, STORES.snapshotManifests, STORES.chunkMeta, STORES.chunkBlobs],
    'readwrite',
    (stores) => deleteSnapshotInTransaction(stores, snapshotId)
  );
}

export async function forgetRoot(rootId) {
  const storeNames = [
    STORES.roots,
    STORES.snapshotSummaries,
    STORES.snapshotManifests,
    STORES.chunkMeta,
    STORES.chunkBlobs
  ];
  await withStore(storeNames, 'readwrite', async (stores) => {
    const summaries = await requestDone(
      stores.snapshotSummaries.index('rootCreatedAt').getAll(IDBKeyRange.only(rootId))
    );
    for (const summary of summaries) {
      await deleteSnapshotInTransaction(stores, summary.id);
    }
    await requestDone(stores.roots.delete(rootId));
  });
}

export async function getChunkStats() {
  return withStore(STORES.chunkMeta, 'readonly', (store) => new Promise((resolve, reject) => {
    let chunks = 0;
    let bytes = 0;
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve({ chunks, bytes });
        return;
      }
      chunks += 1;
      bytes += cursor.value.bytes;
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  }));
}
