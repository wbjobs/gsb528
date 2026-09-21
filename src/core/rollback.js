import {
  computeFileContentHash,
  isPermissionError,
  readFileChunks,
  walkDirectory
} from './fs.js';

function comparePath(a, b) {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function pathDepth(path) {
  return path ? path.split('/').length : 0;
}

export function isUnderPath(path, ancestor) {
  if (!ancestor) return false;
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

function hasAncestorIn(path, values) {
  return values.some((ancestor) => isUnderPath(path, ancestor));
}

function hasDescendant(path, targetPaths) {
  return targetPaths.some((candidate) => isUnderPath(candidate, path) && candidate !== path);
}

function parentPath(path) {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function emptyPlan(targetSnapshot) {
  return {
    targetSnapshotId: targetSnapshot.id,
    createdAt: Date.now(),
    mkdirs: [],
    removeFiles: [],
    removeDirectories: [],
    writes: [],
    blockers: [],
    warnings: targetSnapshot.errors?.map((error) => ({
      path: error.path,
      message: `目标快照记录了不可读文件：${error.message}`
    })) ?? [],
    stats: {
      createFiles: 0,
      modifyFiles: 0,
      removeFiles: 0,
      removeDirectories: 0,
      createDirectories: 0,
      blocked: 0
    }
  };
}

export async function inspectCurrentTree(rootHandle, targetSnapshot, options = {}) {
  const current = {};
  const symlinkPaths = [];
  const errors = [];
  const forceVerify = options.forceVerify !== false;

  for await (const item of walkDirectory(rootHandle, { signal: options.signal })) {
    if (options.signal?.aborted) throw new DOMException('回滚校验已取消', 'AbortError');
    if (item.type === 'symlink') {
      symlinkPaths.push(item.path);
      continue;
    }
    if (item.type === 'error') {
      errors.push({ path: item.path, error: item.error });
      continue;
    }
    if (item.kind === 'directory') {
      current[item.path] = {
        path: item.path,
        kind: 'directory',
        name: item.name
      };
      continue;
    }

    const target = targetSnapshot.entries[item.path];
    let file;
    try {
      file = await item.handle.getFile();
    } catch (error) {
      errors.push({ path: item.path, error });
      current[item.path] = {
        path: item.path,
        kind: 'file',
        name: item.name,
        unreadable: true
      };
      continue;
    }

    const metadataMatches = target?.kind === 'file'
      && !target.unreadable
      && target.size === file.size
      && target.lastModified === file.lastModified;
    if (!forceVerify && metadataMatches) {
      current[item.path] = { ...target, currentMetadataAssumed: true };
      continue;
    }

    try {
      const { chunks } = await readFileChunks(item.handle, {
        path: item.path,
        signal: options.signal,
        chunkSize: targetSnapshot.chunkSize,
        crypto: options.crypto
      });
      current[item.path] = {
        path: item.path,
        kind: 'file',
        name: item.name,
        size: file.size,
        lastModified: file.lastModified,
        chunks,
        contentHash: await computeFileContentHash(chunks, options.crypto)
      };
    } catch (error) {
      errors.push({ path: item.path, error });
      current[item.path] = {
        path: item.path,
        kind: 'file',
        name: item.name,
        size: file.size,
        lastModified: file.lastModified,
        unreadable: true
      };
      if (isPermissionError(error)) throw error;
    }
  }

  return { current, symlinkPaths, errors };
}

export function buildRollbackPlan(targetSnapshot, inspection) {
  const plan = emptyPlan(targetSnapshot);
  const targetEntries = targetSnapshot.entries ?? {};
  const targetPaths = Object.keys(targetEntries).sort(comparePath);
  const currentEntries = inspection.current ?? {};
  const currentPaths = Object.keys(currentEntries).sort(comparePath);
  const symlinkPaths = new Set(inspection.symlinkPaths ?? []);
  const blockers = new Set();
  const extraRoots = [];

  const addBlocker = (path, reason) => {
    if (!blockers.has(path)) {
      blockers.add(path);
      plan.blockers.push({ path, reason });
      plan.stats.blocked += 1;
    }
  };

  for (const symlinkPath of symlinkPaths) {
    if (targetEntries[symlinkPath] || hasDescendant(symlinkPath, targetPaths)) {
      addBlocker(symlinkPath, '当前路径是符号链接；为避免跟随链接，回滚不会修改它');
    }
  }

  for (const path of currentPaths) {
    const entry = currentEntries[path];
    const target = targetEntries[path];
    if (entry.kind === 'file'
      && (!target || target.kind === 'file')
      && hasDescendant(path, targetPaths)) {
      addBlocker(path, '当前文件遮挡了目标快照中的目录');
    }
  }

  for (const path of currentPaths) {
    if (targetEntries[path]) continue;
    if (hasAncestorIn(path, [...symlinkPaths, ...blockers])) continue;

    const targetAncestor = targetPaths
      .filter((targetPath) => isUnderPath(path, targetPath))
      .sort((a, b) => pathDepth(b) - pathDepth(a))[0];

    if (targetAncestor && targetEntries[targetAncestor].kind !== 'directory') {
      addBlocker(path, '目标路径是文件，当前目录中存在其子项');
      continue;
    }
    if (extraRoots.some((root) => isUnderPath(path, root))) continue;
    extraRoots.push(path);
  }

  for (const path of extraRoots.sort(comparePath)) {
    const entry = currentEntries[path];
    if (entry.kind === 'directory') {
      plan.removeDirectories.push(path);
      plan.stats.removeDirectories += 1;
    } else {
      plan.removeFiles.push(path);
      plan.stats.removeFiles += 1;
    }
  }

  for (const path of targetPaths) {
    const target = targetEntries[path];
    if (hasAncestorIn(path, [...symlinkPaths, ...blockers])) continue;
    if (target.unreadable) {
      addBlocker(path, '目标快照生成时该文件不可读，缺少恢复内容');
      continue;
    }

    const current = currentEntries[path];
    if (target.kind === 'directory') {
      if (!current) {
        plan.mkdirs.push(path);
        plan.stats.createDirectories += 1;
      } else if (current.kind !== 'directory') {
        plan.removeFiles.push(path);
        plan.mkdirs.push(path);
        plan.stats.removeFiles += 1;
        plan.stats.createDirectories += 1;
      }
      continue;
    }

    if (!current) {
      plan.writes.push({ path, entry: target, reason: 'create' });
      plan.stats.createFiles += 1;
    } else if (current.kind !== 'file') {
      plan.removeDirectories.push(path);
      plan.writes.push({ path, entry: target, reason: 'replace' });
      plan.stats.removeDirectories += 1;
      plan.stats.modifyFiles += 1;
    } else if (current.unreadable) {
      addBlocker(path, '当前文件不可读，无法确认是否允许覆盖');
    } else if (current.contentHash !== target.contentHash) {
      plan.writes.push({ path, entry: target, reason: current.currentMetadataAssumed ? 'verify' : 'modify' });
      plan.stats.modifyFiles += 1;
    }
  }

  for (const error of inspection.errors ?? []) {
    plan.warnings.push({
      path: error.path,
      message: error.error?.message ?? String(error.error)
    });
  }

  plan.mkdirs.sort((a, b) => pathDepth(a) - pathDepth(b) || comparePath(a, b));
  plan.removeFiles.sort((a, b) => pathDepth(b) - pathDepth(a) || comparePath(b, a));
  plan.removeDirectories.sort((a, b) => pathDepth(b) - pathDepth(a) || comparePath(b, a));
  plan.writes.sort((a, b) => comparePath(a.path, b.path));
  return plan;
}

async function resolveParent(rootHandle, path) {
  const parts = path.split('/').filter(Boolean);
  let handle = rootHandle;
  for (let index = 0; index < parts.length - 1; index += 1) {
    handle = await handle.getDirectoryHandle(parts[index]);
  }
  return { parent: handle, name: parts[parts.length - 1] };
}

async function removeAtPath(rootHandle, path, recursive) {
  const { parent, name } = await resolveParent(rootHandle, path);
  await parent.removeEntry(name, { recursive });
}

async function ensureDirectoryPath(rootHandle, path) {
  const parts = path.split('/').filter(Boolean);
  let handle = rootHandle;
  for (const name of parts) {
    handle = await handle.getDirectoryHandle(name, { create: true });
  }
  return handle;
}

async function writeTargetFile(rootHandle, item, getChunkBlob, options) {
  const { parent, name } = await resolveParent(rootHandle, item.path);
  const fileHandle = await parent.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.truncate(0);
    for (const chunk of item.entry.chunks ?? []) {
      if (options.signal?.aborted) throw new DOMException('回滚已取消', 'AbortError');
      const blob = await getChunkBlob(chunk.hash);
      if (!blob) throw new Error(`缺少内容块：${chunk.hash.slice(0, 10)}`);
      await writable.write({ type: 'write', position: chunk.offset, data: blob });
      if (options.onProgress) {
        await options.onProgress({ path: item.path, bytes: chunk.size });
      }
    }
  } finally {
    await writable.close();
  }
}

async function assertPlanChunksAvailable(plan, getChunkBlob) {
  const hashes = new Set();
  for (const write of plan.writes) {
    for (const chunk of write.entry.chunks ?? []) {
      hashes.add(chunk.hash);
    }
  }
  const missing = [];
  for (const hash of hashes) {
    const blob = await getChunkBlob(hash);
    if (!blob) missing.push(hash);
  }
  if (missing.length) {
    throw new Error(`IndexedDB 缺少 ${missing.length} 个恢复内容块，已阻止回滚`);
  }
}

export async function executeRollbackPlan(rootHandle, plan, getChunkBlob, options = {}) {
  const completed = {
    removeFiles: [],
    removeDirectories: [],
    directories: [],
    files: [],
    failedAt: null
  };
  let processedBytes = 0;
  const report = async (phase, path) => {
    if (!options.onProgress) return;
    await options.onProgress({
      phase,
      path,
      processedBytes,
      totalWrites: plan.writes.length,
      completedFiles: completed.files.length,
      completedDirectories: completed.directories.length,
      completedRemoveFiles: completed.removeFiles.length,
      completedRemoveDirectories: completed.removeDirectories.length
    });
  };

  try {
    await assertPlanChunksAvailable(plan, getChunkBlob);
    for (const path of plan.removeDirectories) {
      if (options.signal?.aborted) throw new DOMException('回滚已取消', 'AbortError');
      await removeAtPath(rootHandle, path, true);
      completed.removeDirectories.push(path);
      await report('remove-directory', path);
    }
    for (const path of plan.removeFiles) {
      if (options.signal?.aborted) throw new DOMException('回滚已取消', 'AbortError');
      await removeAtPath(rootHandle, path, false);
      completed.removeFiles.push(path);
      await report('remove-file', path);
    }
    for (const path of plan.mkdirs) {
      if (options.signal?.aborted) throw new DOMException('回滚已取消', 'AbortError');
      await ensureDirectoryPath(rootHandle, path);
      completed.directories.push(path);
      await report('directory', path);
    }
    for (const item of plan.writes) {
      if (options.signal?.aborted) throw new DOMException('回滚已取消', 'AbortError');
      await writeTargetFile(rootHandle, item, getChunkBlob, {
        signal: options.signal,
        onProgress: async ({ bytes }) => {
          processedBytes += bytes;
          await report('write', item.path);
        }
      });
      completed.files.push(item.path);
      await report('file', item.path);
    }
    return { ok: true, completed, blockers: plan.blockers, warnings: plan.warnings };
  } catch (error) {
    return {
      ok: false,
      error,
      completed,
      blockers: plan.blockers,
      warnings: plan.warnings
    };
  }
}

export { parentPath };
