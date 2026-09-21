import assert from 'node:assert/strict';
import { test } from 'node:test';

function allChunks(entries) {
  const chunks = new Map();
  for (const entry of Object.values(entries)) {
    if (entry.kind !== 'file') continue;
    for (const chunk of entry.chunks ?? []) {
      chunks.set(chunk.hash, (chunks.get(chunk.hash) ?? 0) + 1);
    }
  }
  return chunks;
}

test('new chunk refs preserve repeated copies inside a snapshot', () => {
  const previousEntries = {};
  const currentEntries = {};
  for (let index = 0; index < 20; index += 1) {
    previousEntries[`file-${index}`] = {
      kind: 'file',
      chunks: [{ hash: index < 10 ? `changed-${index}` : `same-${index}` }]
    };
    currentEntries[`file-${index}`] = {
      kind: 'file',
      chunks: [{ hash: index < 10 ? `new-${index}` : `same-${index}` }]
    };
  }

  const currentRefs = allChunks(currentEntries);
  const additions = [];
  const newChunkRefs = new Map();
  for (let index = 0; index < 10; index += 1) {
    const hash = `new-${index}`;
    newChunkRefs.set(hash, (newChunkRefs.get(hash) ?? 0) + 1);
  }
  for (const [hash, refs] of currentRefs) {
    const newRefs = newChunkRefs.get(hash) ?? 0;
    if (newRefs > 0) additions.push([hash, newRefs]);
  }

  assert.equal(additions.length, 10);
  assert.deepEqual(additions.map(([hash]) => hash),
    Array.from({ length: 10 }, (_, index) => `new-${index}`));

  const repeated = allChunks({
    a: { kind: 'file', chunks: [{ hash: 'same-copy' }] },
    b: { kind: 'file', chunks: [{ hash: 'same-copy' }] },
    c: { kind: 'file', chunks: [{ hash: 'same-copy' }] }
  });
  assert.equal(repeated.get('same-copy'), 3);
});
