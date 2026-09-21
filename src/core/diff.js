function chunkCounts(entry) {
  const counts = new Map();
  if (entry?.kind !== 'file') return counts;
  for (const chunk of entry.chunks ?? []) {
    counts.set(chunk.hash, (counts.get(chunk.hash) ?? 0) + 1);
  }
  return counts;
}

export function compareChunks(leftEntry, rightEntry) {
  const left = chunkCounts(leftEntry);
  const right = chunkCounts(rightEntry);
  let added = 0;
  let removed = 0;
  const shared = [];

  for (const [hash, rightCount] of right) {
    const leftCount = left.get(hash) ?? 0;
    added += Math.max(0, rightCount - leftCount);
    if (Math.min(leftCount, rightCount) > 0) {
      shared.push({ hash, copies: Math.min(leftCount, rightCount) });
    }
  }
  for (const [hash, leftCount] of left) {
    const rightCount = right.get(hash) ?? 0;
    removed += Math.max(0, leftCount - rightCount);
  }

  return {
    added,
    removed,
    unchanged: shared.reduce((total, item) => total + item.copies, 0),
    shared
  };
}

function changeFor(path, left, right) {
  if (!left && right) {
    return {
      path,
      status: 'added',
      kind: right.kind,
      oldSize: null,
      newSize: right.size ?? null,
      chunks: right.kind === 'file'
        ? { added: right.chunks?.length ?? 0, removed: 0, unchanged: 0 }
        : null,
      inaccessible: Boolean(right.unreadable)
    };
  }

  if (left && !right) {
    return {
      path,
      status: 'removed',
      kind: left.kind,
      oldSize: left.size ?? null,
      newSize: null,
      chunks: left.kind === 'file'
        ? { added: 0, removed: left.chunks?.length ?? 0, unchanged: 0 }
        : null,
      inaccessible: Boolean(left.unreadable)
    };
  }

  if (left.kind !== right.kind) {
    return {
      path,
      status: 'typeChanged',
      oldKind: left.kind,
      newKind: right.kind,
      oldSize: left.size ?? null,
      newSize: right.size ?? null,
      chunks: null,
      inaccessible: Boolean(left.unreadable || right.unreadable)
    };
  }

  if (left.kind === 'directory') return null;

  if (left.contentHash === right.contentHash
    && !left.unreadable
    && !right.unreadable) {
    return null;
  }

  return {
    path,
    status: left.unreadable || right.unreadable ? 'inaccessible' : 'modified',
    kind: 'file',
    oldSize: left.size ?? null,
    newSize: right.size ?? null,
    chunks: compareChunks(left, right),
    oldLastModified: left.lastModified ?? null,
    newLastModified: right.lastModified ?? null,
    inaccessible: Boolean(left.unreadable || right.unreadable)
  };
}

export function diffSnapshots(fromSnapshot, toSnapshot) {
  const leftEntries = fromSnapshot?.entries ?? {};
  const rightEntries = toSnapshot?.entries ?? {};
  const paths = new Set([...Object.keys(leftEntries), ...Object.keys(rightEntries)]);
  const changes = [];

  for (const path of paths) {
    const change = changeFor(path, leftEntries[path], rightEntries[path]);
    if (change) changes.push(change);
  }

  changes.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));

  const summary = changes.reduce((acc, change) => {
    acc[change.status] = (acc[change.status] ?? 0) + 1;
    acc.total += 1;
    if (change.chunks) {
      acc.chunksAdded += change.chunks.added;
      acc.chunksRemoved += change.chunks.removed;
      acc.chunksUnchanged += change.chunks.unchanged;
    }
    return acc;
  }, {
    total: 0,
    added: 0,
    removed: 0,
    modified: 0,
    typeChanged: 0,
    inaccessible: 0,
    chunksAdded: 0,
    chunksRemoved: 0,
    chunksUnchanged: 0
  });

  return {
    fromSnapshotId: fromSnapshot?.id ?? null,
    toSnapshotId: toSnapshot?.id ?? null,
    createdAt: Date.now(),
    changes,
    summary
  };
}
