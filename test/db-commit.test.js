import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STORES,
  allChunks,
  commitSnapshot,
  deleteSnapshot,
  __setDatabaseFactoryForTesting
} from '../src/core/db.js';

class Request {
  constructor(value) {
    this.value = value;
  }

  get result() {
    return this.value;
  }

  succeed(value) {
    this.value = value;
    this.onsuccess?.();
  }
}

class MemoryStore {
  constructor(records = new Map(), keyPath = 'hash') {
    this.records = records;
    this.keyPath = keyPath;
  }

  get(key) {
    const request = new Request(this.records.get(key));
    queueMicrotask(() => request.succeed(this.records.get(key)));
    return request;
  }

  put(value) {
    const key = value[this.keyPath];
    const request = new Request(key);
    queueMicrotask(() => {
      this.records.set(key, value);
      request.succeed(key);
    });
    return request;
  }

  delete(key) {
    const request = new Request(undefined);
    queueMicrotask(() => {
      this.records.delete(key);
      request.succeed(undefined);
    });
    return request;
  }
}

class MemoryTransaction {
  constructor(stores, storeNames) {
    this.stores = stores;
    this.storeNames = storeNames;
  }

  objectStore(name) {
    return this.stores[name];
  }

  abort() {
    this.aborted = true;
    this.onabort?.(new Error('aborted'));
  }
}

class MemoryDatabase {
  constructor(stores) {
    this.stores = stores;
  }

  transaction(storeNames) {
    const transaction = new MemoryTransaction(this.stores, storeNames);
    setTimeout(() => {
      if (!transaction.aborted) transaction.oncomplete?.();
    }, 0);
    return transaction;
  }
}

test('commitSnapshot initializes shared new chunks and increments reused chunks', async () => {
  const chunkMeta = new Map();
  const chunkBlobs = new Map();
  const manifests = new Map();
  const summaries = new Map();
  const stores = {
    [STORES.chunkMeta]: new MemoryStore(chunkMeta),
    [STORES.chunkBlobs]: new MemoryStore(chunkBlobs),
    [STORES.snapshotManifests]: new MemoryStore(manifests, 'id'),
    [STORES.snapshotSummaries]: new MemoryStore(summaries, 'id')
  };

  const first = {
    id: 'first',
    rootId: 'root',
    createdAt: 1,
    entries: {
      a: { kind: 'file', chunks: [{ hash: 'shared-new' }] },
      b: { kind: 'file', chunks: [{ hash: 'shared-new' }] }
    },
    stats: {}
  };
  const second = {
    id: 'second',
    rootId: 'root',
    createdAt: 2,
    entries: {
      a: { kind: 'file', chunks: [{ hash: 'shared-new' }] },
      b: { kind: 'file', chunks: [{ hash: 'shared-new' }] },
      c: { kind: 'file', chunks: [{ hash: 'shared-new' }, { hash: 'new-only' }] }
    },
    stats: {}
  };

  const newFirstRefs = allChunks(first.entries);
  const databaseRef = { db: new MemoryDatabase(stores) };
  __setDatabaseFactoryForTesting(() => {
    const request = {};
    queueMicrotask(() => {
      request.result = databaseRef.db;
      request.onsuccess?.();
    });
    return request;
  });

  await commitSnapshot(first, new Map([
    ['shared-new', { size: 4 }]
  ]), null, newFirstRefs);
  assert.equal(chunkMeta.get('shared-new').refs, 2);

  const newSecondRefs = allChunks(second.entries);
  newSecondRefs.delete('shared-new');
  await commitSnapshot(second, new Map([
    ['new-only', { size: 2 }]
  ]), first, newSecondRefs);
  assert.equal(chunkMeta.get('shared-new').refs, 3);
  assert.equal(chunkMeta.get('new-only').refs, 1);

  await deleteSnapshot('first');
  assert.equal(chunkMeta.get('shared-new').refs, 1);
  assert.equal(manifests.has('first'), false);

  await deleteSnapshot('second');
  assert.equal(chunkMeta.size, 0);
  assert.equal(chunkBlobs.size, 0);
  __setDatabaseFactoryForTesting(null);
});
