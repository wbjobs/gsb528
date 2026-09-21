export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

export function supportsFileSystemAccess() {
  return typeof globalThis.showDirectoryPicker === 'function';
}

export function isPermissionError(error) {
  if (!error) return false;
  const name = error.name ?? '';
  return name === 'NotAllowedError'
    || name === 'SecurityError';
}

export async function queryPermission(handle, mode = 'read') {
  if (!handle?.queryPermission) return 'unknown';
  try {
    return await handle.queryPermission({ mode });
  } catch {
    return 'unknown';
  }
}

export async function requestHandlePermission(handle, mode = 'read') {
  if (!handle?.requestPermission) {
    throw new Error('当前浏览器不支持目录句柄授权');
  }
  return handle.requestPermission({ mode });
}

export async function ensurePermission(handle, mode = 'read') {
  const current = await queryPermission(handle, mode);
  if (current === 'granted') return current;
  return requestHandlePermission(handle, mode);
}

async function detectSymlink(handle) {
  if (typeof handle.isSymbolicLink === 'function') {
    try {
      return await handle.isSymbolicLink();
    } catch {
      return false;
    }
  }
  return false;
}

export async function getEntryNameKind(handle) {
  const kind = typeof handle.kind === 'string'
    ? handle.kind
    : (typeof handle.isDirectory === 'function' && handle.isDirectory ? 'directory' : 'file');
  return { name: handle.name, kind };
}

export async function* walkDirectory(rootHandle, options = {}) {
  const signal = options.signal;
  const shouldSkip = options.shouldSkip ?? detectSymlink;
  const stack = [{
    handle: rootHandle,
    name: rootHandle.name,
    path: '',
    depth: 0,
    relative: ''
  }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (signal?.aborted) return;

    let iterator;
    try {
      iterator = frame.handle.entries();
    } catch (error) {
      yield {
        type: 'error',
        path: frame.relative,
        name: frame.name,
        error
      };
      continue;
    }

    const children = [];
    try {
      for await (const [name, childHandle] of iterator) {
        if (signal?.aborted) return;
        children.push({ name, handle: childHandle });
      }
    } catch (error) {
      yield {
        type: 'error',
        path: frame.relative,
        name: frame.name,
        error
      };
      continue;
    }

    children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    for (const child of children) {
      if (signal?.aborted) return;
      const relative = frame.relative ? `${frame.relative}/${child.name}` : child.name;
      let kind;
      try {
        ({ kind } = await getEntryNameKind(child.handle));
      } catch (error) {
        yield { type: 'error', path: relative, name: child.name, error };
        continue;
      }

      let skippedSymlink = false;
      try {
        skippedSymlink = Boolean(await shouldSkip(child.handle));
      } catch (error) {
        yield { type: 'error', path: relative, name: child.name, error };
        continue;
      }
      if (skippedSymlink) {
        yield { type: 'symlink', path: relative, name: child.name, kind };
        continue;
      }

      if (kind === 'directory') {
        yield {
          type: 'entry',
          path: relative,
          name: child.name,
          kind: 'directory',
          handle: child.handle,
          parent: frame.relative
        };
        stack.push({
          handle: child.handle,
          name: child.name,
          relative,
          depth: frame.depth + 1
        });
      } else if (kind === 'file') {
        yield {
          type: 'entry',
          path: relative,
          name: child.name,
          kind: 'file',
          handle: child.handle,
          parent: frame.relative
        };
      }
    }
  }
}

export function createAbortError() {
  const error = new DOMException('操作已取消', 'AbortError');
  return error;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

export async function hashEmptyBuffer(cryptoRef = globalThis.crypto) {
  const hash = await cryptoRef.subtle.digest('SHA-256', new Uint8Array(0));
  return bufferToHex(hash);
}

export function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function readFileChunks(handle, options = {}) {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const signal = options.signal;
  const cryptoRef = options.crypto ?? globalThis.crypto;
  const onChunk = options.onChunk;
  const chunks = [];
  const blob = await handle.getFile();
  let offset = 0;

  while (offset < blob.size) {
    throwIfAborted(signal);
    const length = Math.min(chunkSize, blob.size - offset);
    const slice = blob.slice(offset, offset + length);
    const buffer = await slice.arrayBuffer();
    throwIfAborted(signal);
    const digest = await cryptoRef.subtle.digest('SHA-256', buffer);
    const hash = bufferToHex(digest);
    const chunk = {
      index: chunks.length,
      offset,
      size: buffer.byteLength,
      hash
    };
    chunks.push(chunk);
    if (onChunk) {
      await onChunk({ chunk, buffer, file: blob, path: options.path });
    }
    offset += length;
  }

  return {
    file: blob,
    chunks
  };
}

export async function computeFileContentHash(chunks, cryptoRef = globalThis.crypto) {
  if (chunks.length === 0) return hashEmptyBuffer(cryptoRef);
  const combined = new Uint8Array(chunks.length * 32);
  chunks.forEach((chunk, index) => {
    const bytes = hexToBytes(chunk.hash);
    combined.set(bytes, index * 32);
  });
  const digest = await cryptoRef.subtle.digest('SHA-256', combined);
  return bufferToHex(digest);
}

export function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function getDirectoryTreeMetrics(handle, options = {}) {
  let files = 0;
  let directories = 0;
  let bytes = 0;
  let symlinks = 0;
  let errors = 0;
  for await (const item of walkDirectory(handle, options)) {
    if (item.type === 'symlink') {
      symlinks += 1;
    } else if (item.type === 'error') {
      errors += 1;
    } else if (item.kind === 'directory') {
      directories += 1;
    } else {
      files += 1;
      try {
        const file = await item.handle.getFile();
        bytes += file.size;
      } catch (error) {
        errors += 1;
        if (options.onError) options.onError(error, item);
      }
    }
  }
  return { files, directories, bytes, symlinks, errors };
}
