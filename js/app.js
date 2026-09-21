// 主线程：UI 编排。重活全部委托给 Worker，这里不做任何文件遍历/哈希/diff 计算。
import { WorkerClient } from './worker-client.js';
import {
  clearRootHandle,
  getPermissionState,
  loadRootHandle,
  requestPermissionFromGesture,
  saveRootHandle,
} from './handle-store.js';
import { estimateStorage } from './lib/idb.js';
import { DEFAULT_CHUNK_SIZE } from './lib/fs-helpers.js';

const $ = (sel) => document.querySelector(sel);

const config = readConfig();
const client = new WorkerClient(new URL('../worker/main.js', import.meta.url));
client.onError = (message) => {
  showBanner('error', `后台 Worker 不可用：${message}`, null);
};

const state = {
  rootHandle: null,
  permission: 'unknown',
  snapshots: [],
  scanning: false,
  scanToken: 0,
  autoTimer: null,
  diffSelection: { base: null, target: null },
  currentSnapshot: null,
  fileList: { path: '', kind: 'snapshot', snapshotId: null, page: 0 },
};

function readConfig() {
  const defaults = {
    autoScan: true,
    intervalMinutes: 30,
    chunkSize: DEFAULT_CHUNK_SIZE,
    ignoreText: '',
    skipSymlinks: true,
    concurrency: 4,
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('snapshot-config') || '{}') };
  } catch {
    return defaults;
  }
}

function saveConfig() {
  localStorage.setItem('snapshot-config', JSON.stringify(config));
}

function fmtBytes(n) {
  if (n == null) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showBanner(kind, message, action) {
  const banner = $('#banner');
  banner.className = `banner ${kind}`;
  banner.innerHTML = '';
  const msg = document.createElement('span');
  msg.textContent = message;
  banner.appendChild(msg);
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.className = 'banner-btn';
    btn.addEventListener('click', action.onClick);
    banner.appendChild(btn);
  }
  banner.classList.remove('hidden');
}

function hideBanner() {
  $('#banner').classList.add('hidden');
}

function log(message, kind = 'info') {
  const box = $('#log');
  const line = document.createElement('div');
  line.className = `log-line log-${kind}`;
  line.textContent = `[${fmtTime(Date.now())}] ${message}`;
  box.prepend(line);
  while (box.childNodes.length > 200) box.lastChild.remove();
}

async function init() {
  bindUI();
  applyConfigToForm();
  refreshStorageInfo();
  if (!('showDirectoryPicker' in window)) {
    showBanner('error',
      '当前浏览器不支持 File System Access API。请使用桌面版 Chrome/Edge（或 Opera）并通过 http(s)://localhost 打开本页面。',
      null);
    $('#btn-pick').disabled = true;
    return;
  }
  if (Worker === undefined) {
    showBanner('error', '当前浏览器不支持 Web Worker，无法运行扫描任务。', null);
    return;
  }
  await restoreSession();
  await refreshSnapshots();
  scheduleAutoScan();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkPermissionHealth();
  });
}

async function restoreSession() {
  const { handle, meta } = await loadRootHandle();
  if (!handle) {
    showBanner('warn',
      '尚未授权目录。点击“选择目录”授权一个本地文件夹后，授权会持久化，重开浏览器也能恢复。',
      { label: '选择目录', onClick: pickDirectory });
    return;
  }
  state.rootHandle = handle;
  const perm = await getPermissionState(handle, 'read');
  state.permission = perm;
  if (perm === 'granted') {
    onAuthorized(meta, /*restored*/ true);
  } else {
    showBanner('warn',
      `检测到上次授权的目录“${meta?.name || handle.name}”，但浏览器要求重新确认授权（每次浏览器会话至少一次）。`,
      { label: '重新授权此目录', onClick: () => reauthorize(handle) });
    setFolderInfo(handle, meta, '权限待确认');
  }
}

async function pickDirectory() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    state.rootHandle = handle;
    state.permission = 'granted';
    await saveRootHandle(handle, { mode: 'readwrite' });
    hideBanner();
    onAuthorized({ name: handle.name, savedAt: Date.now() }, false);
    log(`已授权目录：${handle.name}`, 'success');
  } catch (err) {
    if (err.name === 'AbortError') {
      log('已取消目录选择', 'info');
    } else {
      showBanner('error', `选择目录失败：${err.message || err}`, null);
    }
  }
}

async function reauthorize(handle) {
  try {
    const read = await requestPermissionFromGesture(handle, 'read');
    if (read !== 'granted') {
      showDegraded('你拒绝了读取授权。快照功能需要至少“只读”权限，随时可以点此重新授权。',
        () => reauthorize(handle));
      return;
    }
    let write = 'prompt';
    try {
      write = await requestPermissionFromGesture(handle, 'readwrite');
    } catch { /* 某些浏览器只支持读 */ }
    state.permission = read;
    state.writePermission = write === 'granted';
    hideBanner();
    onAuthorized({ name: handle.name }, true);
    if (write !== 'granted') {
      log('仅获得只读权限：可以扫描/对比，回滚功能将不可用。', 'warn');
    }
  } catch (err) {
    showDegraded(`授权失败：${err.message || err}`, () => reauthorize(handle));
  }
}

function showDegraded(message, retryFn) {
  state.permission = 'denied';
  showBanner('error', message, retryFn ? { label: '重新授权', onClick: retryFn } : null);
  log(message, 'error');
  renderActionState();
}

function onAuthorized(meta, restored) {
  hideBanner();
  setFolderInfo(state.rootHandle, meta, restored ? '已恢复授权' : '已授权');
  renderActionState();
  if (restored) log(`已恢复对目录“${state.rootHandle.name}”的授权`, 'success');
}

function setFolderInfo(handle, meta, statusText) {
  $('#folder-name').textContent = handle.name;
  $('#folder-status').textContent = `${statusText} · 句柄已持久化于 IndexedDB · ${meta?.savedAt ? '保存于 ' + fmtTime(meta.savedAt) : ''}`;
  $('#folder-card').classList.remove('hidden');
}

function renderActionState() {
  const ready = !!state.rootHandle && state.permission === 'granted';
  $('#btn-scan').disabled = !ready || state.scanning;
  $('#btn-rollback-apply').disabled = !ready || state.scanning;
  const writeReady = ready && state.writePermission !== false;
  $('#btn-rollback-apply').disabled = !writeReady || state.scanning;
  if (!ready) $('#btn-scan').disabled = true;
}

async function checkPermissionHealth() {
  if (!state.rootHandle) return;
  try {
    const perm = await getPermissionState(state.rootHandle, 'read');
    if (state.permission === 'granted' && perm !== 'granted') {
      state.permission = perm;
      showDegraded('目录权限已被撤销（可能在浏览器站点设置中被收回）。扫描与回滚已暂停。',
        () => reauthorize(state.rootHandle));
    }
  } catch { /* 忽略健康检查错误 */ }
}

async function forgetDirectory() {
  if (!confirm('忘记此目录授权？本地快照数据仍会保留，之后可以重新授权同一目录。')) return;
  await clearRootHandle();
  state.rootHandle = null;
  state.permission = 'unknown';
  $('#folder-card').classList.add('hidden');
  showBanner('warn', '已清除目录授权记录。', { label: '选择目录', onClick: pickDirectory });
  log('已忘记目录句柄', 'info');
}

async function ensureWritable() {
  if (!state.rootHandle) return false;
  let perm = 'prompt';
  try {
    perm = await getPermissionState(state.rootHandle, 'readwrite');
    if (perm !== 'granted') perm = await requestPermissionFromGesture(state.rootHandle, 'readwrite');
  } catch (err) {
    log(`写入权限检查失败：${err.message || err}`, 'warn');
  }
  state.writePermission = perm === 'granted';
  if (perm !== 'granted') {
    showDegraded('没有写入权限，无法回滚。请授权“读写”后重试。',
      () => ensureWritable().then((ok) => ok && startRollback()));
    return false;
  }
  return true;
}

async function startScan(label) {
  if (state.scanning || !state.rootHandle) return;
  const perm = await getPermissionState(state.rootHandle, 'read');
  if (perm !== 'granted') {
    showDegraded('权限已失效，无法开始扫描。重新授权后会自动恢复定时扫描。',
      () => reauthorize(state.rootHandle));
    return;
  }
  state.permission = 'granted';
  state.scanning = true;
  const token = ++state.scanToken;
  renderActionState();
  setProgress({ phase: 'walk', percent: 0, message: '准备扫描…' });
  const startedAt = Date.now();
  const baselineId = state.snapshots.at(-1)?.id || null;

  const promise = client.call('scan', {
    __taskId: `t${token}`,
    rootHandle: state.rootHandle,
    baselineId,
    label: label || '',
    chunkSize: Number(config.chunkSize),
    ignoreText: config.ignoreText,
    concurrency: Number(config.concurrency),
  }, {
    onProgress: (p) => {
      if (token !== state.scanToken) return;
      if (p.phase === 'walk') setProgress({ phase: 'walk', percent: null, message: p.message });
      else if (p.phase === 'hash') setProgress({ phase: 'hash', percent: p.percent, message: p.message });
    },
  });
  trackAbortable(promise, token);

  try {
    const { snapshot } = await promise;
    if (token !== state.scanToken) return;
    setProgress({ phase: 'done', percent: 100, message: '扫描完成' });
    log(`快照 ${shortId(snapshot.id)} 完成：${snapshot.stats.files} 文件，变化 ${snapshot.stats.changedFiles} 个，` +
      `新增块 ${fmtBytes(snapshot.stats.newChunkBytes)}，耗时 ${Math.round((Date.now() - startedAt) / 100) / 10}s`,
      'success');
    await refreshSnapshots();
    refreshStorageInfo();
  } catch (err) {
    if (token !== state.scanToken) return;
    handleTaskError(err, '扫描');
  } finally {
    if (token === state.scanToken) {
      state.scanning = false;
      renderActionState();
    }
  }
}

function trackAbortable(promise, token) {
  state.activeTask = { promise, token };
  promise.catch(() => {}).finally(() => {
    if (state.activeTask?.token === token) state.activeTask = null;
  });
}

function abortActive() {
  if (!state.activeTask) return;
  const { token } = state.activeTask;
  client.worker.postMessage({ type: 'abort', taskId: 'abort', abortTaskId: `t${token}` });
  state.scanToken++;
  state.scanning = false;
  log('已请求中止当前任务', 'warn');
  renderActionState();
}

function handleTaskError(err, action) {
  if (err.name === 'AbortError' || /abort/i.test(err.message || '')) {
    log(`${action}已中止`, 'warn');
    setProgress({ phase: 'idle', percent: null, message: '已中止' });
    return;
  }
  if (err.code === 'PERMISSION_DENIED' || err.name === 'NotAllowedError' || err.name === 'SecurityError') {
    showDegraded(`${action}失败：目录权限被撤销。点击重新授权后可继续，已保存的快照不会丢失。`,
      () => reauthorize(state.rootHandle));
    setProgress({ phase: 'error', message: '权限被撤销' });
    return;
  }
  if (err.code === 'MISSING_CHUNK') {
    showBanner('error',
      `${action}失败：部分快照块数据缺失（可能被浏览器的站点数据清理机制回收）。旧快照将无法精确回滚。`,
      { label: '知道了', onClick: hideBanner });
  }
  log(`${action}失败：${err.message || err}`, 'error');
  setProgress({ phase: 'error', message: err.message || String(err) });
}

function setProgress({ phase, percent, message }) {
  const bar = $('#progress-bar');
  const label = $('#progress-label');
  if (percent == null) {
    bar.classList.add('indeterminate');
    bar.style.width = '100%';
  } else {
    bar.classList.remove('indeterminate');
    bar.style.width = `${percent}%`;
  }
  label.textContent = message || '';
  $('#progress-row').classList.toggle('hidden', phase === 'idle');
}

function scheduleAutoScan() {
  if (state.autoTimer) clearTimeout(state.autoTimer);
  if (!config.autoScan) return;
  const minutes = Math.max(1, Number(config.intervalMinutes) || 30);
  state.autoTimer = setTimeout(() => {
    if (!state.scanning && state.rootHandle && state.permission === 'granted' && document.visibilityState === 'visible') {
      log(`定时扫描触发（间隔 ${minutes} 分钟）`, 'info');
      startScan('自动');
    }
    scheduleAutoScan();
  }, minutes * 60 * 1000);
}

async function refreshSnapshots() {
  state.snapshots = await client.call('listSnapshots');
  renderSnapshotList();
  if (state.currentSnapshot && !state.snapshots.some((s) => s.id === state.currentSnapshot.id)) {
    state.currentSnapshot = null;
    $('#panel-detail').classList.add('hidden');
  }
}

function shortId(id) {
  return String(id).replace(/^snap_/, '').slice(0, 13);
}

function renderSnapshotList() {
  const tbody = $('#snapshot-tbody');
  tbody.innerHTML = '';
  if (state.snapshots.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">还没有快照，点击“立即扫描”创建第一个快照。</td></tr>';
    updateDiffButton();
    return;
  }
  state.snapshots.forEach((snap, index) => {
    const tr = document.createElement('tr');
    tr.dataset.id = snap.id;
    const label = snap.label ? `${escapeHtml(snap.label)} · ` : '';
    tr.innerHTML = `
      <td><input type="radio" name="diff-base" class="diff-base" title="作为 diff 基准"></td>
      <td><input type="radio" name="diff-target" class="diff-target" title="作为 diff 目标"></td>
      <td><button class="link-btn view-btn">${label}${fmtTime(snap.createdAt)}</button></td>
      <td>${snap.stats.files} / ${snap.stats.dirs}</td>
      <td>${fmtBytes(snap.stats.totalBytes)}</td>
      <td>${index === 0 ? '基线' : `新增块 ${fmtBytes(snap.stats.newChunkBytes)}`}</td>
      <td class="row-actions">
        <button class="small-btn rollback-btn">回滚到此</button>
        <button class="small-btn danger delete-btn" title="删除此快照及其后所有快照">删除</button>
      </td>`;
    tr.querySelector('.view-btn').addEventListener('click', () => viewSnapshot(snap.id));
    tr.querySelector('.rollback-btn').addEventListener('click', () => beginRollback(snap));
    tr.querySelector('.delete-btn').addEventListener('click', () => deleteSnapshot(snap));
    tr.querySelector('.diff-base').addEventListener('change', () => { state.diffSelection.base = snap.id; updateDiffButton(); });
    tr.querySelector('.diff-target').addEventListener('change', () => { state.diffSelection.target = snap.id; updateDiffButton(); });
    if (state.diffSelection.base === snap.id) tr.querySelector('.diff-base').checked = true;
    if (state.diffSelection.target === snap.id) tr.querySelector('.diff-target').checked = true;
    tbody.appendChild(tr);
  });
  updateDiffButton();
}

function updateDiffButton() {
  const { base, target } = state.diffSelection;
  $('#btn-diff').disabled = !(base && target && base !== target);
}

async function viewSnapshot(id) {
  state.currentSnapshot = await client.call('getSnapshot', { id });
  renderSnapshotDetail();
}

function renderSnapshotDetail() {
  const snap = state.currentSnapshot;
  const panel = $('#panel-detail');
  panel.classList.remove('hidden');
  $('#detail-title').textContent = `快照 ${snap.label ? snap.label + ' · ' : ''}${fmtTime(snap.createdAt)}`;
  $('#detail-meta').textContent =
    `${snap.stats.files} 个文件，${snap.stats.dirs} 个目录，共 ${fmtBytes(snap.stats.totalBytes)} · ` +
    `变化文件 ${snap.stats.changedFiles} · 新增分块 ${fmtBytes(snap.stats.newChunkBytes)} · ` +
    `块大小 ${fmtBytes(snap.chunkSize)}`;
  state.fileList = { kind: 'snapshot', snapshotId: snap.id, query: '', page: 0 };
  renderFileList();
  const skipped = $('#detail-skipped');
  const items = [
    ...(snap.stats.skippedItems || []).map((x) => `跳过 ${x.path}（${x.reason}）`),
    ...(snap.stats.inaccessibleItems || []).map((x) => `无法访问 ${x.path}（${x.error}）`),
  ];
  skipped.classList.toggle('hidden', items.length === 0);
  skipped.textContent = items.length ? `⚠ ${items.length} 项被跳过/不可访问（悬停查看）` : '';
  skipped.title = items.join('\n');
}

function renderFileList() {
  const snap = state.currentSnapshot;
  const query = (state.fileList.query || '').trim().toLowerCase();
  const filtered = query
    ? snap.entries.filter((e) => e.path.toLowerCase().includes(query))
    : snap.entries;
  const pageSize = 100;
  const page = state.fileList.page || 0;
  const slice = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const tbody = $('#file-tbody');
  tbody.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const entry of slice) {
    const tr = document.createElement('tr');
    if (entry.kind === 'dir') {
      tr.innerHTML = `<td>📁</td><td>${escapeHtml(entry.path)}/</td><td>-</td><td>-</td><td></td>`;
    } else {
      tr.innerHTML = `
        <td>📄</td>
        <td>${escapeHtml(entry.path)}</td>
        <td>${fmtBytes(entry.size)}</td>
        <td>${entry.chunks.length} 块</td>
        <td><button class="small-btn download-btn">下载此版本</button></td>`;
      tr.querySelector('.download-btn').addEventListener('click', () => downloadVersion(entry));
    }
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pager = $('#file-pager');
  pager.innerHTML = '';
  const info = document.createElement('span');
  info.textContent = `${filtered.length} 项 · 第 ${page + 1}/${pages} 页`;
  pager.appendChild(info);
  if (pages > 1) {
  for (const [label, delta, enabled] of [
      ['上一页', -1, page > 0],
      ['下一页', 1, page < pages - 1],
    ]) {
      const btn = document.createElement('button');
      btn.className = 'small-btn';
      btn.textContent = label;
      btn.disabled = !enabled;
      btn.addEventListener('click', () => { state.fileList.page = page + delta; renderFileList(); });
      pager.appendChild(btn);
    }
  }
}

async function downloadVersion(entry) {
  try {
    const { blob } = await client.call('readFile', { snapshotId: state.currentSnapshot.id, path: entry.path });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = entry.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    handleTaskError(err, '读取快照文件');
  }
}

let pendingRollback = null;

async function beginRollback(snapshot) {
  if (!state.rootHandle) return;
  const ok = await ensureWritable();
  if (!ok) return;
  pendingRollback = snapshot;
  $('#rollback-title').textContent =
    `回滚到快照：${snapshot.label ? snapshot.label + ' · ' : ''}${fmtTime(snapshot.createdAt)}`;
  $('#rollback-detail').textContent =
    '将先扫描当前目录并展示将要发生的精确变更，确认后才会写入磁盘。';
  $('#rollback-plan').innerHTML = '<p class="muted">正在扫描当前目录并生成回滚计划…</p>';
  $('#btn-rollback-apply').onclick = applyRollback;
  openModal('#modal-rollback');
  try {
    const result = await client.call('rollback', {
      rootHandle: state.rootHandle,
      targetId: snapshot.id,
      planOnly: true,
      chunkSize: Number(config.chunkSize),
      ignoreText: config.ignoreText,
      concurrency: Number(config.concurrency),
    });
    if (pendingRollback?.id !== snapshot.id) return;
    if (result.alreadyMatch) {
      $('#rollback-plan').innerHTML = '<p class="success-text">当前目录内容与该快照完全一致，无需回滚。</p>';
      $('#btn-rollback-apply').disabled = true;
      return;
    }
    const r = result.report;
    $('#rollback-plan').innerHTML = `
      <ul class="plan-list">
        <li>重写/恢复文件：<b>${r.filesToWrite}</b> 个（验收关注的文件都会按快照字节精确重建）</li>
        <li>删除多余文件：<b>${r.filesToDelete}</b> 个</li>
        <li>创建目录：<b>${r.dirsToCreate}</b> 个 · 删除目录：<b>${r.dirsToDelete}</b> 个</li>
        <li>保持不动：<b>${r.unchanged}</b> 个条目</li>
      </ul>
      <p class="muted">注：Web 平台 API 无法恢复文件的修改时间(mtime)，文件字节内容会完全一致。</p>`;
    $('#btn-rollback-apply').disabled = false;
    $('#btn-rollback-apply').dataset.resultPending = '1';
    state.rollbackDryRun = result;
  } catch (err) {
    $('#rollback-plan').innerHTML = `<p class="error-text">${escapeHtml(err.message || String(err))}</p>`;
    $('#btn-rollback-apply').disabled = true;
  }
}

async function applyRollback() {
  const snapshot = pendingRollback;
  $('#btn-rollback-apply').disabled = true;
  $('#rollback-detail').textContent = '正在按快照重建文件…';
  // 说明：回滚的扫描+写入是一次 Worker 任务；上面弹窗里已做过一次干跑，
  // 这里重新执行以保证写入基于最新磁盘状态。
  try {
    const result = await client.call('rollback', {
      rootHandle: state.rootHandle,
      targetId: snapshot.id,
      chunkSize: Number(config.chunkSize),
      ignoreText: config.ignoreText,
      concurrency: Number(config.concurrency),
    }, {
      onProgress: (p) => {
        if (p.phase === 'apply' || p.phase === 'scan') {
          $('#rollback-detail').textContent =
            `${p.phase === 'scan' ? '扫描当前目录' : '写入磁盘'} ${p.processed ?? ''}/${p.total ?? ''} ${p.current || ''}`;
        }
      },
    });
    if (result.alreadyMatch) {
      $('#rollback-detail').textContent = '内容已一致。';
      return;
    }
    if (result.success) {
      log(`回滚完成：写入 ${result.report.filesToWrite}，删除 ${result.report.filesToDelete}（快照 ${shortId(snapshot.id)}）`, 'success');
      $('#rollback-plan').innerHTML = '<p class="success-text">回滚成功。建议立即生成一个新快照以记录当前状态。</p>';
      $('#btn-rollback-apply').disabled = true;
    } else {
      const list = result.failed
        .map((f) => `<li>${escapeHtml(f.path)}：${escapeHtml(f.error)}</li>`).join('');
      $('#rollback-plan').innerHTML = `<p class="error-text">${result.failed.length} 项失败：</p><ul>${list}</ul>`;
      log(`回滚部分失败：${result.failed.length} 项`, 'error');
    }
    refreshStorageInfo();
  } catch (err) {
    handleTaskError(err, '回滚');
    $('#rollback-plan').innerHTML = `<p class="error-text">${escapeHtml(err.message || String(err))}</p>`;
  }
}

async function deleteSnapshot(snap) {
  const index = state.snapshots.findIndex((s) => s.id === snap.id);
  const after = state.snapshots.length - index - 1;
  if (!confirm(`删除 ${fmtTime(snap.createdAt)} 的快照会同时删除其后的 ${after} 个快照（快照按时间链存储）。块数据会在清理后自动回收。确定？`)) return;
  try {
    const { removed } = await client.call('deleteSnapshot', { id: snap.id });
    log(`已删除 ${removed.length} 个快照`, 'info');
    await runGC();
    await refreshSnapshots();
  } catch (err) {
    handleTaskError(err, '删除快照');
  }
}

async function runGC() {
  try {
    const result = await client.call('gc', {});
    log(`存储清理完成：回收 ${result.removed} 个无引用块，保留 ${result.kept} 个`, 'info');
    refreshStorageInfo();
  } catch (err) {
    log(`清理失败：${err.message || err}`, 'error');
  }
}

async function runDiff() {
  const { base, target } = state.diffSelection;
  if (!base || !target || base === target) return;
  openModal('#modal-diff');
  $('#diff-summary').textContent = '计算差异中…';
  $('#diff-added').innerHTML = '';
  $('#diff-removed').innerHTML = '';
  $('#diff-changed').innerHTML = '';
  try {
    const result = await client.call('diff', { baseId: base, targetId: target });
    renderDiff(result);
  } catch (err) {
    $('#diff-summary').textContent = `Diff 失败：${err.message || err}`;
  }
}

function renderDiff(result) {
  const s = result.summary;
  $('#diff-summary').textContent =
    `${fmtTime(result.base.createdAt)} → ${fmtTime(result.target.createdAt)}：` +
    `新增 ${s.filesAdded} 文件 / 删除 ${s.filesRemoved} / 修改 ${s.filesChanged} ` +
    `/ 未变 ${s.filesUnchanged}；目录 +${s.dirsAdded}/-${s.dirsRemoved}`;
  renderDiffGroup('#diff-added', result.added, 'added', (x) =>
    `<span class="diff-path">+ ${escapeHtml(x.path)}</span><span class="muted">${fmtBytes(x.size)}</span>`);
  renderDiffGroup('#diff-removed', result.removed, 'removed', (x) =>
    `<span class="diff-path">- ${escapeHtml(x.path)}</span><span class="muted">${fmtBytes(x.size)}</span>`);
  renderDiffGroup('#diff-changed', result.changed, 'changed', (x) => {
    const b = x.block;
    const modCount = b.modifiedRanges.length + b.addedRanges.length + b.removedRanges.length;
    const detail = `修改块区间 ${b.modifiedRanges.map(fmtRange).join(', ') || '无'}` +
      `${b.addedRanges.length ? '；新增 ' + b.addedRanges.map(fmtRange).join(',') : ''}` +
      `${b.removedRanges.length ? '；删除 ' + b.removedRanges.map(fmtRange).join(',') : ''}` +
      `；复用 ${b.reusedChunks} 块`;
    return `<details>
      <summary><span class="diff-path">~ ${escapeHtml(x.path)}</span>
      <span class="muted">${fmtBytes(x.oldSize)} → ${fmtBytes(x.newSize)} · ${modCount} 个块区间变化</span></summary>
      <div class="block-detail">${escapeHtml(detail)}</div>
    </details>`;
  });
}

function fmtRange([start, end]) {
  return start === end ? `#${start}` : `#${start}-${end}`;
}

function renderDiffGroup(selector, items, kind, renderItem) {
  const container = document.querySelector(selector);
  const box = container.querySelector('.diff-list');
  container.querySelector('.diff-count').textContent = items.length;
  if (items.length === 0) {
    box.innerHTML = '<p class="muted">无</p>';
    return;
  }
  const cap = 500;
  const shown = items.slice(0, cap);
  box.innerHTML = shown.map((x) => `<div class="diff-row diff-${kind}">${renderItem(x)}</div>`).join('');
  if (items.length > cap) {
    const more = document.createElement('p');
    more.className = 'muted';
    more.textContent = `…另有 ${items.length - cap} 项未显示`;
    box.appendChild(more);
  }
}

function bindUI() {
  $('#btn-pick').addEventListener('click', pickDirectory);
  $('#btn-reauth').addEventListener('click', () => state.rootHandle && reauthorize(state.rootHandle));
  $('#btn-forget').addEventListener('click', forgetDirectory);
  $('#btn-scan').addEventListener('click', () => startScan($('#scan-label').value.trim()));
  $('#btn-abort').addEventListener('click', abortActive);
  $('#btn-diff').addEventListener('click', runDiff);
  $('#btn-gc').addEventListener('click', runGC);
  $('#btn-refresh').addEventListener('click', refreshSnapshots);
  $('#file-search').addEventListener('input', (e) => {
    if (state.currentSnapshot) { state.fileList.query = e.target.value; state.fileList.page = 0; renderFileList(); }
  });

  // 设置
  $('#cfg-auto').addEventListener('change', (e) => { config.autoScan = e.target.checked; persistConfig(); });
  $('#cfg-interval').addEventListener('change', (e) => {
    config.intervalMinutes = Number(e.target.value) || 30;
    persistConfig();
  });
  $('#cfg-chunk').addEventListener('change', (e) => {
    config.chunkSize = (Number(e.target.value) || 4) * 1024 * 1024;
    persistConfig();
  });
  $('#cfg-concurrency').addEventListener('change', (e) => {
    config.concurrency = Math.min(8, Math.max(1, Number(e.target.value) || 4));
    persistConfig();
  });
  $('#cfg-ignore').addEventListener('change', (e) => { config.ignoreText = e.target.value; persistConfig(); });

  document.querySelectorAll('[data-close]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const modal = document.querySelector(btn.dataset.close);
      if (modal) modal.classList.add('hidden');
      if (btn.dataset.close === '#modal-rollback') pendingRollback = null;
    }));
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) =>
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.classList.add('hidden');
    }));

  if (navigator.storage?.persist) {
    navigator.storage.persist().then((persisted) => {
      if (persisted) log('已请求持久化存储，浏览器将尽量避免清理快照数据', 'info');
    });
  }
}

function persistConfig() {
  saveConfig();
  scheduleAutoScan();
  log('设置已保存', 'info');
}

function applyConfigToForm() {
  $('#cfg-auto').checked = config.autoScan;
  $('#cfg-interval').value = config.intervalMinutes;
  $('#cfg-chunk').value = config.chunkSize / (1024 * 1024);
  $('#cfg-concurrency').value = config.concurrency;
  $('#cfg-ignore').value = config.ignoreText;
}

async function refreshStorageInfo() {
  try {
    const { usage, quota } = await estimateStorage();
    $('#storage-info').textContent =
      `IndexedDB 已用 ${fmtBytes(usage)}` + (quota ? ` / 配额 ${fmtBytes(quota)}` : '');
  } catch {
    $('#storage-info').textContent = '';
  }
}

function openModal(selector) {
  document.querySelector(selector).classList.remove('hidden');
}

init().catch((err) => {
  log(`初始化失败：${err.message || err}`, 'error');
  showBanner('error', `初始化失败：${err.message || err}`, null);
});
