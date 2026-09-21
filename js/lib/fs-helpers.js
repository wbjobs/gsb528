// File System Access API 辅助函数（仅浏览器环境使用）。
import { isIgnored, parseIgnore } from './ignore.js';

export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB

export function joinPath(parent, name) {
  return parent ? `${parent}/${name}` : name;
}

let hashQueue = Promise.resolve();
/** 串行化 crypto.subtle 调用，保证 4 个文件并发读取时哈希计算稳定。 */
export async function sha256Hex(buffer) {
  const run = () => crypto.subtle.digest('SHA-256', buffer);
  const result = hashQueue.then(run, run);
  hashQueue = result.catch(() => {});
  return result.then((digest) =>
    [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
  );
}

/**
 * 分块读取文件并计算每块 SHA-256。
 * @returns {Promise<{chunks:Array<{hash:string,blob:Blob}>,size:number}>}
 * 大文件只在内存中保留 Blob 切片（浏览器由磁盘支撑，不复制全部内容）。
 */
export async function readFileChunked(fileHandle, chunkSize, { onProgress, signal } = {}) {
  const file = await fileHandle.getFile();
  const total = file.size;
  const chunks = [];
  let offset = 0;
  while (offset < total) {
    if (signal && signal.aborted) throw new DOMException('已中止', 'AbortError');
    const end = Math.min(offset + chunkSize, total);
    const blob = file.slice(offset, end);
    const buffer = await blob.arrayBuffer();
    const hash = await sha256Hex(buffer);
    chunks.push({ hash, blob });
    offset = end;
    if (onProgress) onProgress(offset, total);
  }
  return { chunks, size: total, mtime: file.lastModified };
}

/** 0 字节文件返回单个空块哈希，保证文件内容可回滚。 */
export async function emptyFileHash() {
  return sha256Hex(new ArrayBuffer(0));
}

export async function queryPermission(handle, mode = 'read') {
  if (!handle.queryPermission) return 'granted';
  const opts = mode === 'readwrite' ? { mode: 'readwrite' } : undefined;
  return handle.queryPermission(opts);
}

export async function requestPermission(handle, mode = 'read') {
  if (!handle.requestPermission) return 'granted';
  const opts = mode === 'readwrite' ? { mode: 'readwrite' } : undefined;
  return handle.requestPermission(opts);
}

export function isAbortError(err) {
  return err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
}

export function isPermissionError(err) {
  return err && (err.name === 'NotAllowedError' || err.name === 'SecurityError' || err.name === 'AbortError');
}

/**
 * 遍历目录树。
 *
 * 符号链接说明（重要限制）：
 * File System Access API 不暴露条目是否为符号链接，浏览器通常会透明跟随。
 * 因此无法 100% 跳过 symlink；这里做两层处理：
 *   1. 用户可在“忽略规则”中配置链接名称/路径（默认不忽略任何内容，不做静默跳过）；
 *   2. 遍历时用 isSameEntry 检测祖先环，避免链接指回树内导致的无限递归。
 * 指向树外的 symlink 会被跟随，这是 Web 平台的已知限制（README 有说明）。
 */
export async function walkDirectory(rootHandle, options = {}) {
  const rules = parseIgnore(options.ignoreText || '');
  const skipSymlinks = options.skipSymlinks !== false; // 保留配置位（平台限制下尽力而为）
  const signal = options.signal;
  const state = {
    files: 0,
    dirs: 0,
    bytes: 0,
    skipped: [],
    inaccessible: [],
    started: performance.now(),
  };

  async function walk(dirHandle, relPath, ancestors) {
    if (signal && signal.aborted) throw new DOMException('已中止', 'AbortError');
    let iter;
    try {
      iter = dirHandle.values();
    } catch (err) {
      if (isPermissionError(err)) throw err;
      state.inaccessible.push({ path: relPath || '.', error: String(err && err.message || err) });
      return;
    }
    for await (const handle of iter) {
      if (signal && signal.aborted) throw new DOMException('已中止', 'AbortError');
      const path = joinPath(relPath, handle.name);
      const kind = handle.kind === 'directory' ? 'dir' : 'file';
      const ignoredByRule = isIgnored(path, kind, rules);
      if (ignoredByRule) {
        state.skipped.push({ path, reason: `忽略规则: ${ignoredByRule}` });
        continue;
      }
      if (handle.kind === 'directory') {
        // 符号链接环路保护：与任一祖先目录指向同一条目则跳过。
        let cycle = false;
        for (const ancestor of ancestors) {
          try {
            if (await handle.isSameEntry(ancestor)) { cycle = true; break; }
          } catch { /* 忽略检测失败 */ }
        }
        if (cycle) {
          state.skipped.push({ path, reason: '疑似符号链接环路（isSameEntry 命中祖先目录）' });
          continue;
        }
        state.dirs++;
        if (options.onProgress) options.onProgress({ phase: 'walk', state, current: path });
        await options.visit?.({ handle, kind: 'dir', path });
        await walk(handle, path, [...ancestors, handle]);
      } else if (handle.kind === 'file') {
        state.files++;
        await options.visit?.({ handle, kind: 'file', path });
      }
    }
  }

  await walk(rootHandle, '', []);
  state.elapsedMs = performance.now() - state.started;
  return state;
}

/** 简单并发池。 */
export async function pool(items, concurrency, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

export function throttle(fn, minIntervalMs) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = performance.now();
    const wait = minIntervalMs - (now - last);
    if (wait <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = performance.now();
        timer = null;
        fn(...args);
      }, wait);
    }
  };
}
