// 目录句柄持久化：句柄本身可结构化克隆，直接存入 IndexedDB。
// 关闭浏览器后重新打开页面，可取出句柄并尝试无感恢复（queryPermission），
// 无感失败时在用户点击的手势里调用 requestPermission 重新授权。
import { kvGet, kvSet, kvDelete, openDB } from './lib/idb.js';

const KEY_ROOT = 'rootDirectoryHandle';
const KEY_META = 'rootDirectoryMeta';

export async function saveRootHandle(handle, meta) {
  const db = await openDB();
  await kvSet(db, KEY_ROOT, handle);
  await kvSet(db, KEY_META, { name: handle.name, savedAt: Date.now(), ...meta });
}

export async function loadRootHandle() {
  const db = await openDB();
  const handle = await kvGet(db, KEY_ROOT);
  const meta = await kvGet(db, KEY_META);
  return { handle: handle || null, meta: meta || null };
}

export async function clearRootHandle() {
  const db = await openDB();
  await kvDelete(db, KEY_ROOT);
  await kvDelete(db, KEY_META);
}

export async function getPermissionState(handle, mode = 'read') {
  if (!handle.queryPermission) return 'granted';
  return handle.queryPermission(mode === 'readwrite' ? { mode: 'readwrite' } : undefined);
}

/** 尝试无感恢复（无手势也能成功的情况）。 */
export async function tryRestorePermission(handle) {
  return getPermissionState(handle, 'read');
}

/** 必须在用户点击事件的调用栈中触发。 */
export async function requestPermissionFromGesture(handle, mode = 'read') {
  if (!handle.requestPermission) return 'granted';
  return handle.requestPermission(mode === 'readwrite' ? { mode: 'readwrite' } : undefined);
}
