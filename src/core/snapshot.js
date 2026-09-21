import {
  computeFileContentHash,
  isPermissionError,
  readFileChunks
} from './fs.js';

function getFileMetadata(file) {
  return {
    size: file.size ?? 0,
    lastModified: typeof file.lastModified === 'number' ? file.lastModified : 0
  };
}

function metadataChanged(oldEntry, file) {
  if (!oldEntry || oldEntry.kind !== 'file') return true;
  return oldEntry.size !== file.size || oldEntry.lastModified !== file.lastModified;
}

function markUnreadable(path, error) {
  return {
    path,
    message: error?.message ?? String(error),
    name: error?.name ?? 'Error',
    unreadable: true,
    permission: isPermissionError(error)
  };
}

function summarizeChanges(previous, entries) {
  const previousFiles = new Map(
    Object.entries(previous?.entries ?? {}).filter(([, entry]) => entry.kind === 'file')
  );
  const currentFiles = new Set(
    Object.entries(entries).filter(([, entry]) => entry.kind === 'file').map(([path]) => path)
  );
  let added = 0;
  let removed = 0;
  let modified = 0;

  for (const [path, entry] of Object.entries(entries)) {
    if (entry.kind !== 'file') continue;
    const oldEntry = previousFiles.get(path);
    if (!oldEntry) added += 1;
    else if (oldEntry.contentHash !== entry.contentHash) modified += 1;
  }
  for (const path of previousFiles.keys()) {
    if (!currentFiles.has(path)) removed += 1;
  }
  return { added, removed, modified };
}

export async function createSnapshot({
  rootId,
  rootName,
  previous,
  walk,
  storage,
  signal,
  forceHash = false,
  chunkSize,
  crypto,
  id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  createdAt = Date.now(),
  onProgress
}) {
  const entries = {};
  const newChunks = new Map();
  const newChunkRefs = new Map();
  const errors = [];
  let seen = 0;
  let totalFiles = 0;
  let totalDirectories = 0;
  let totalBytes = 0;
  let symlinksSkipped = 0;
  let unreadableFiles = 0;
  let changedFiles = 0;
  let hashedFiles = 0;
  let reusedChunks = 0;
  let newChunkBytes = 0;

  const reportProgress = async (phase) => {
    if (onProgress) {
      await onProgress({
        phase,
        seen,
        totalFiles,
        totalDirectories,
        totalBytes,
        symlinksSkipped,
        unreadableFiles,
        changedFiles,
        hashedFiles,
        newChunks: newChunks.size,
        newChunkBytes
      });
    }
  };

  for await (const item of walk) {
    if (signal?.aborted) {
      const error = new DOMException('扫描已取消', 'AbortError');
      error.name = 'AbortError';
      throw error;
    }

    if (item.type === 'symlink') {
      symlinksSkipped += 1;
      await reportProgress('walk');
      continue;
    }

    if (item.type === 'error') {
      errors.push(markUnreadable(item.path, item.error));
      unreadableFiles += 1;
      await reportProgress('walk');
      continue;
    }

    seen += 1;
    const path = item.path;
    if (item.kind === 'directory') {
      totalDirectories += 1;
      entries[path] = {
        path,
        name: item.name,
        parent: item.parent,
        kind: 'directory',
        scannedAt: createdAt
      };
      await reportProgress('walk');
      continue;
    }

    totalFiles += 1;
    let file;
    try {
      file = await item.handle.getFile();
      totalBytes += file.size;
    } catch (error) {
      errors.push(markUnreadable(path, error));
      entries[path] = {
        path,
        name: item.name,
        parent: item.parent,
        kind: 'file',
        size: 0,
        lastModified: 0,
        chunks: [],
        contentHash: null,
        unreadable: true,
        scannedAt: createdAt
      };
      unreadableFiles += 1;
      await reportProgress('walk');
      continue;
    }

    const oldEntry = previous?.entries?.[path];
    const canReuseMetadata = !forceHash
      && oldEntry?.kind === 'file'
      && !oldEntry.unreadable
      && !metadataChanged(oldEntry, file);

    if (canReuseMetadata) {
      entries[path] = {
        ...oldEntry,
        name: item.name,
        parent: item.parent,
        lastAccessedAt: createdAt,
        scannedAt: createdAt
      };
      await reportProgress('skip');
      continue;
    }

    hashedFiles += 1;
    try {
      const { chunks } = await readFileChunks(item.handle, {
        path,
        signal,
        chunkSize,
        crypto,
        onChunk: async ({ chunk, buffer }) => {
          if (newChunks.has(chunk.hash)) return;
          const existing = await storage.getChunk?.(chunk.hash);
          if (existing) {
            reusedChunks += 1;
            return;
          }
          newChunkRefs.set(chunk.hash, (newChunkRefs.get(chunk.hash) ?? 0) + 1);
          newChunks.set(chunk.hash, new Blob([buffer], { type: 'application/octet-stream' }));
          newChunkBytes += chunk.size;
        }
      });
      const contentHash = await computeFileContentHash(chunks, crypto);
      entries[path] = {
        path,
        name: item.name,
        parent: item.parent,
        kind: 'file',
        size: file.size,
        lastModified: file.lastModified,
        chunks,
        contentHash,
        unreadable: false,
        scannedAt: createdAt,
        ...getFileMetadata(file)
      };
      if (!oldEntry || oldEntry.kind !== 'file' || oldEntry.contentHash !== contentHash) {
        changedFiles += 1;
      }
      await reportProgress('hash');
    } catch (error) {
      errors.push(markUnreadable(path, error));
      entries[path] = {
        path,
        name: item.name,
        parent: item.parent,
        kind: 'file',
        size: file.size,
        lastModified: file.lastModified,
        chunks: [],
        contentHash: null,
        unreadable: true,
        scannedAt: createdAt
      };
      unreadableFiles += 1;
      if (isPermissionError(error)) throw error;
      await reportProgress('error');
    }
  }

  const changes = summarizeChanges(previous, entries);
  const snapshot = {
    id,
    rootId,
    rootName,
    createdAt,
    chunkSize: chunkSize ?? 4 * 1024 * 1024,
    entries,
    errors: errors.slice(0, 500),
    stats: {
      fileCount: totalFiles,
      directoryCount: totalDirectories,
      totalBytes,
      symlinksSkipped,
      unreadableFiles,
      hashedFiles,
      changedFiles,
      addedFiles: changes.added,
      removedFiles: changes.removed,
      modifiedFiles: changes.modified,
      newChunkCount: newChunks.size,
      newChunkBytes,
      reusedChunks,
      errorCount: errors.length
    }
  };
  return { snapshot, newChunks, newChunkRefs, errors };
}

export function countEntryChanges(previousEntries = {}, entries = {}) {
  const paths = new Set([...Object.keys(previousEntries), ...Object.keys(entries)]);
  const result = { added: 0, removed: 0, modified: 0, typeChanged: 0, unchanged: 0 };
  for (const path of paths) {
    const left = previousEntries[path];
    const right = entries[path];
    if (!left) result.added += 1;
    else if (!right) result.removed += 1;
    else if (left.kind !== right.kind) result.typeChanged += 1;
    else if (left.kind === 'file' && left.contentHash !== right.contentHash) result.modified += 1;
    else result.unchanged += 1;
  }
  return result;
}
