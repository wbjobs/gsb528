import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { diffSnapshots } from '../src/core/diff.js';
import { buildRollbackPlan, isUnderPath } from '../src/core/rollback.js';
import { createSnapshot } from '../src/core/snapshot.js';

function digest(input) {
  return Uint8Array.from(createHash('sha256').update(Buffer.from(input)).digest()).buffer;
}

const cryptoStub = {
  subtle: {
    digest: async (_algorithm, data) => digest(Buffer.from(data))
  }
};

class FakeFile {
  constructor(path, content, name = path.split('/').pop()) {
    this.path = path;
    this.name = name;
    this.content = Buffer.from(content);
    this.size = this.content.length;
    this.lastModified = 1_000;
  }

  async getFile() {
    return {
      size: this.size,
      lastModified: this.lastModified,
      slice: (start, end) => {
        const content = this.content.subarray(start, end);
        return { arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) };
      }
    };
  }
}

function walkFiles(files) {
  return (async function* walk() {
    const directories = new Set(files.map((file) => file.path.split('/').slice(0, -1)).filter(Boolean).flatMap((parts) => {
      const result = [];
      let current = '';
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        result.push(current);
      }
      return result;
    }));
    for (const path of [...directories].sort()) {
      const index = path.lastIndexOf('/');
      yield {
        type: 'entry',
        path,
        name: index === -1 ? path : path.slice(index + 1),
        parent: index === -1 ? '' : path.slice(0, index),
        kind: 'directory'
      };
    }
    for (const file of files) {
      const index = file.path.lastIndexOf('/');
      yield {
        type: 'entry',
        path: file.path,
        name: file.name,
        parent: index === -1 ? '' : file.path.slice(0, index),
        kind: 'file',
        handle: file
      };
    }
  })();
}

test('creates an incremental snapshot and identifies ten modified files', async () => {
  const files = Array.from({ length: 20 }, (_, index) =>
    new FakeFile(`file-${String(index).padStart(2, '0')}.txt`, `v0-${index}`));
  const storage = new Map();
  const first = await createSnapshot({
    rootId: 'root',
    rootName: 'fixture',
    walk: walkFiles(files),
    storage: { getChunk: async (hash) => storage.has(hash) },
    forceHash: true,
    crypto: cryptoStub,
    id: 's1',
    createdAt: 1000
  });

  for (const file of files.slice(0, 10)) {
    file.content = Buffer.from(`v1-${file.path}`);
    file.size = file.content.length;
    file.lastModified = 2000;
  }

  const second = await createSnapshot({
    rootId: 'root',
    rootName: 'fixture',
    previous: first.snapshot,
    walk: walkFiles(files),
    storage: { getChunk: async () => null },
    forceHash: true,
    crypto: cryptoStub,
    id: 's2',
    createdAt: 2000
  });

  assert.equal(second.snapshot.stats.modifiedFiles, 10);
  assert.equal(second.snapshot.stats.addedFiles, 0);
  assert.equal(second.snapshot.stats.removedFiles, 0);
  const modifiedPaths = Object.values(second.snapshot.entries)
    .filter((entry) => first.snapshot.entries[entry.path]?.contentHash !== entry.contentHash)
    .map((entry) => entry.path);
  assert.deepEqual(modifiedPaths, files.slice(0, 10).map((file) => file.path));
});

test('diff reports exact file and block changes', () => {
  const block = (hash) => [{ index: 0, offset: 0, size: 1, hash }];
  const from = {
    id: 'a',
    entries: {
      'same.txt': { path: 'same.txt', kind: 'file', contentHash: 'same', chunks: block('c-same') },
      'old.txt': { path: 'old.txt', kind: 'file', contentHash: 'old', chunks: block('c-old') },
      'edit.txt': { path: 'edit.txt', kind: 'file', contentHash: 'e1', chunks: [
        { index: 0, offset: 0, size: 1, hash: 'shared' },
        { index: 1, offset: 1, size: 1, hash: 'old-tail' }
      ] }
    }
  };
  const to = {
    id: 'b',
    entries: {
      'same.txt': { path: 'same.txt', kind: 'file', contentHash: 'same', chunks: block('c-same') },
      'new.txt': { path: 'new.txt', kind: 'file', contentHash: 'new', chunks: block('c-new') },
      'edit.txt': { path: 'edit.txt', kind: 'file', contentHash: 'e2', chunks: [
        { index: 0, offset: 0, size: 1, hash: 'shared' },
        { index: 1, offset: 1, size: 1, hash: 'new-tail' }
      ] }
    }
  };
  const result = diffSnapshots(from, to);
  assert.equal(result.summary.added, 1);
  assert.equal(result.summary.removed, 1);
  assert.equal(result.summary.modified, 1);
  const edited = result.changes.find((change) => change.path === 'edit.txt');
  assert.deepEqual(edited.chunks, { added: 1, removed: 1, unchanged: 1, shared: [{ hash: 'shared', copies: 1 }] });
});

test('rollback plan restores ten changed files and removes extra tree', () => {
  const targetEntries = {};
  for (let index = 0; index < 12; index += 1) {
    targetEntries[`file-${index}.txt`] = {
      path: `file-${index}.txt`,
      kind: 'file',
      contentHash: `target-${index}`,
      chunks: [{ index: 0, offset: 0, size: 1, hash: `block-${index}` }]
    };
  }
  const target = { id: 'target', entries: targetEntries };
  const current = {};
  for (let index = 0; index < 12; index += 1) {
    current[`file-${index}.txt`] = {
      path: `file-${index}.txt`,
      kind: 'file',
      contentHash: index < 10 ? `current-${index}` : `target-${index}`,
      chunks: [{ index: 0, offset: 0, size: 1, hash: `current-block-${index}` }]
    };
  }
  current['new-dir'] = { path: 'new-dir', kind: 'directory' };
  current['new-dir/child.txt'] = { path: 'new-dir/child.txt', kind: 'file', contentHash: 'x' };
  current['extra.txt'] = { path: 'extra.txt', kind: 'file', contentHash: 'extra' };

  const plan = buildRollbackPlan(target, { current, symlinkPaths: [], errors: [] });
  assert.equal(plan.writes.length, 10);
  assert.deepEqual(plan.writes.map((write) => write.path),
    Array.from({ length: 10 }, (_, index) => `file-${index}.txt`));
  assert.deepEqual(plan.removeDirectories, ['new-dir']);
  assert.deepEqual(plan.removeFiles, ['extra.txt']);
  assert.equal(plan.blockers.length, 0);
});

test('rollback blocks operations under symlinks', () => {
  const target = {
    id: 'target',
    entries: {
      link: { path: 'link', kind: 'directory' },
      'link/file.txt': { path: 'link/file.txt', kind: 'file', contentHash: 'target' }
    }
  };
  const current = {};
  const plan = buildRollbackPlan(target, { current, symlinkPaths: ['link'], errors: [] });
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.mkdirs.length, 0);
  assert.equal(plan.blockers.length, 1);
});

test('rollback replaces a current file with a target directory', () => {
  const target = {
    id: 'target',
    entries: {
      conflict: { path: 'conflict', kind: 'directory' },
      'conflict/child.txt': { path: 'conflict/child.txt', kind: 'file', contentHash: 'child' }
    }
  };
  const current = {
    conflict: { path: 'conflict', kind: 'file', contentHash: 'blocks' }
  };
  const plan = buildRollbackPlan(target, { current, symlinkPaths: [], errors: [] });
  assert.deepEqual(plan.removeFiles, ['conflict']);
  assert.deepEqual(plan.mkdirs, ['conflict']);
  assert.deepEqual(plan.writes.map((write) => write.path), ['conflict/child.txt']);
  assert.equal(plan.blockers.length, 0);
});

test('path hierarchy helper', () => {
  assert.equal(isUnderPath('a/b/c', 'a/b'), true);
  assert.equal(isUnderPath('a/b', 'a/b'), true);
  assert.equal(isUnderPath('a/bc', 'a/b'), false);
});
