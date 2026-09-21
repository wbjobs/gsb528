import {
  deleteSnapshot,
  forgetRoot,
  getChunkStats,
  getSnapshotManifest,
  listRoots,
  listSnapshotSummaries,
  saveRoot
} from './core/db.js';
import {
  ensurePermission,
  queryPermission,
  requestHandlePermission,
  supportsFileSystemAccess
} from './core/fs.js';
import { formatBytes, formatClock, formatDate } from './ui/format.js';
import { downloadSnapshotEntry } from './ui/download.js';
import {
  renderBreadcrumbs,
  renderDiffTable,
  renderSnapshotOptions,
  renderSnapshotTable,
  renderTreeTable,
  setBanner
} from './ui/render.js';
import { WorkerClient } from './ui/worker-client.js';

const elements = {};
const DIFF_PAGE_SIZE = 200;
const state = {
  root: null,
  permission: 'unknown',
  snapshots: [],
  scanning: false,
  timer: null,
  currentSnapshot: null,
  currentSnapshotPath: '',
  manifests: new Map(),
  diff: null,
  diffFilter: 'all',
  diffPage: 0,
  pendingRollback: null,
  rollbackPlan: null,
  nextScanForceHash: null
};

for (const id of [
  'autoScan', 'interval', 'scanNow', 'cancelScan', 'permissionBanner', 'rootName',
  'permissionState', 'rootHint', 'pickFolder', 'requestPermission', 'forgetRoot',
  'snapshotCount', 'fileCount', 'totalSize', 'storageBytes', 'scanState', 'scanClock',
  'progressBar', 'scanMessage', 'scanWarnings', 'forceHash', 'refreshList', 'snapshotsBody',
  'breadcrumbs', 'treeBody', 'fromSnapshot', 'toSnapshot', 'runDiff', 'diffFilters',
  'diffSummary', 'diffBody', 'diffPrev', 'diffPage', 'diffNext', 'rollbackDialog',
  'rollbackTarget', 'rollbackPreview', 'rollbackVerify', 'executeRollback', 'toast'
]) {
  elements[id] = document.getElementById(id);
}

const scanWorker = supportsFileSystemAccess()
  ? new WorkerClient(new URL('./workers/scan-worker.js', import.meta.url))
  : null;
const diffWorker = supportsFileSystemAccess()
  ? new WorkerClient(new URL('./workers/diff-worker.js', import.meta.url))
  : null;
const rollbackWorker = supportsFileSystemAccess()
  ? new WorkerClient(new URL('./workers/rollback-worker.js', import.meta.url))
  : null;

let toastTimer;

function toast(message, level = 'info') {
  const item = document.createElement('div');
  item.className = `toast ${level}`;
  item.textContent = message;
  elements.toast.append(item);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => item.remove(), 4500);
}

function setControlsDisabled(disabled) {
  for (const id of ['scanNow', 'pickFolder', 'interval', 'forceHash', 'runDiff']) {
    elements[id].disabled = disabled;
  }
}

function latestSnapshot() {
  return state.snapshots[0];
}

function configureTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  if (!elements.autoScan.checked) return;
  if (state.permission !== 'granted') return;
  const delay = Number(elements.interval.value);
  state.timer = setInterval(() => {
    if (!state.scanning) startScan(false);
  }, delay);
}

function permissionLabel(permission) {
  return {
    granted: '已授权',
    prompt: '需要重新授权',
    denied: '权限已撤销',
    unknown: '未知'
  }[permission] ?? permission;
}

function setPermission(permission) {
  state.permission = permission;
  elements.permissionState.textContent = permissionLabel(permission);
  elements.permissionState.className = `status-pill ${permission}`;
  const granted = permission === 'granted';
  elements.scanNow.disabled = !granted;
  elements.requestPermission.hidden = granted || !state.root;
  elements.forgetRoot.hidden = !state.root;
  configureTimer();
}

function renderBannerForPermission() {
  if (!supportsFileSystemAccess()) {
    setBanner(elements.permissionBanner, {
      level: 'error',
      title: '当前浏览器不支持 File System Access API',
      message: '请使用桌面版 Chrome、Edge 或 Opera，并通过 localhost / HTTPS 打开。仍可查看本页代码，但不能扫描或回滚目录。'
    });
    return;
  }
  if (!state.root) {
    setBanner(elements.permissionBanner, {
      level: 'info',
      title: '选择一个本地目录开始',
      message: '建议准备包含至少 5000 个文件、总大小 2GB 的目录。目录句柄将保存到 IndexedDB；重开浏览器后只需点击一次重新授权。'
    });
    return;
  }
  if (state.permission === 'granted') {
    setBanner(elements.permissionBanner, {
      level: 'success',
      title: `已授权：${state.root.handle.name}`,
      message: '扫描和差异计算都在 Worker 中运行；页面可继续操作。符号链接会跳过且不会被跟随。'
    });
    return;
  }
  setBanner(elements.permissionBanner, {
    level: state.permission === 'denied' ? 'error' : 'warning',
    title: '目录权限当前不可用',
    message: '历史快照和差异结果仍可查看，但不能扫描或回滚。点击“重新授权”；如果目录被移动或改名，请重新选择目录。',
    actions: [
      { label: '重新授权', onClick: requestPermission },
      { label: '重新选择目录', onClick: pickFolder },
      { label: '查看历史快照', danger: false, onClick: () => toast('历史快照保持可读。', 'success') }
    ]
  });
}

async function refreshPermission() {
  if (!state.root) {
    setPermission('unknown');
    return;
  }
  let permission;
  try {
    permission = await queryPermission(state.root.handle, 'read');
  } catch {
    permission = 'denied';
  }
  setPermission(permission);
  renderBannerForPermission();
}

async function requestWritePermission() {
  if (!state.root) throw new Error('尚未选择目录');
  const permission = await requestHandlePermission(state.root.handle, 'readwrite');
  if (permission !== 'granted') {
    throw Object.assign(new Error('未授予写入权限，已取消回滚。'), { name: 'NotAllowedError' });
  }
  await refreshPermission();
}

async function pickFolder() {
  if (!supportsFileSystemAccess()) return;
  try {
    const handle = await globalThis.showDirectoryPicker({ mode: 'read' });
    const permission = await ensurePermission(handle, 'read');
    if (permission !== 'granted') {
      throw Object.assign(new Error('目录读取授权被拒绝'), { name: 'NotAllowedError' });
    }
    const root = {
      id: globalThis.crypto.randomUUID(),
      name: handle.name,
      handle,
      createdAt: Date.now()
    };
    await saveRoot(root);
    state.root = root;
    state.snapshots = [];
    state.manifests.clear();
    state.currentSnapshot = null;
    setPermission(permission);
    renderBannerForPermission();
    await refreshSnapshots();
    toast('目录已授权，开始首次扫描。', 'success');
    await startScan(true);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    toast(error.message || '选择目录失败', 'error');
  }
}

async function requestPermission() {
  if (!state.root) return;
  try {
    const permission = await ensurePermission(state.root.handle, 'read');
    setPermission(permission);
    renderBannerForPermission();
    if (permission === 'granted') toast('授权已恢复。', 'success');
  } catch (error) {
    setPermission('denied');
    renderBannerForPermission();
    toast(error.message || '授权失败', 'error');
  }
}

async function restoreLastRoot() {
  if (!supportsFileSystemAccess()) {
    setControlsDisabled(true);
    renderBannerForPermission();
    return false;
  }
  try {
    const roots = await listRoots();
    if (!roots.length) {
      renderBannerForPermission();
      return false;
    }
    state.root = roots[0];
    elements.rootName.textContent = state.root.name;
    await refreshPermission();
    if (state.permission === 'granted') {
      await refreshSnapshots();
    }
    return true;
  } catch (error) {
    setBanner(elements.permissionBanner, {
      level: 'warning',
      title: '无法恢复 IndexedDB 中的目录句柄',
      message: `可以重新选择目录；历史数据仍保留在本地。原因：${error.message}`
    });
    return false;
  }
}

async function forgetCurrentRoot() {
  if (!state.root) return;
  const confirmed = window.confirm(
    `确定忘记“${state.root.name}”并删除该目录的所有快照和内容块？此操作只影响浏览器本地 IndexedDB，不会删除磁盘文件。`
  );
  if (!confirmed) return;
  try {
    await forgetRoot(state.root.id);
    state.root = null;
    state.snapshots = [];
    state.currentSnapshot = null;
    state.manifests.clear();
    elements.rootName.textContent = '尚未选择目录';
    setPermission('unknown');
    renderBannerForPermission();
    refreshSnapshots();
    toast('已清除本地授权和快照。', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function refreshSnapshots() {
  if (!state.root) {
    state.snapshots = [];
  } else {
    const snapshots = await listSnapshotSummaries(state.root.id);
    state.snapshots = snapshots.sort((a, b) => b.createdAt - a.createdAt);
  }
  renderSnapshots();
  renderMetrics();
  renderDiffOptions();
}

function renderSnapshots() {
  renderSnapshotTable(elements.snapshotsBody, state.snapshots, {
    browse: browseSnapshot,
    rollback: openRollbackDialog,
    delete: removeSnapshot
  });
}

async function renderMetrics() {
  const newest = latestSnapshot();
  const stats = newest?.stats;
  elements.snapshotCount.textContent = String(state.snapshots.length);
  elements.fileCount.textContent = stats ? String(stats.fileCount) : '—';
  elements.totalSize.textContent = stats ? formatBytes(stats.totalBytes) : '—';
  elements.rootName.textContent = state.root?.name ?? '尚未选择目录';
  try {
    const chunkStats = await getChunkStats();
    elements.storageBytes.textContent = formatBytes(chunkStats.bytes);
  } catch {
    elements.storageBytes.textContent = '—';
  }
}

function renderDiffOptions() {
  const snapshots = state.snapshots;
  renderSnapshotOptions(elements.fromSnapshot, snapshots, snapshots[1]?.id);
  renderSnapshotOptions(elements.toSnapshot, snapshots, snapshots[0]?.id);
}

async function loadManifest(snapshotId) {
  if (!state.manifests.has(snapshotId)) {
    const manifest = await getSnapshotManifest(snapshotId);
    if (!manifest) throw new Error('快照清单不存在');
    state.manifests.set(snapshotId, manifest);
  }
  return state.manifests.get(snapshotId);
}

async function startScan(manual = false) {
  if (!scanWorker || state.scanning || !state.root || state.permission !== 'granted') {
    if (manual && state.permission !== 'granted') renderBannerForPermission();
    return;
  }
  state.scanning = true;
  elements.scanNow.disabled = true;
  elements.cancelScan.hidden = false;
  elements.scanState.textContent = '扫描中';
  elements.scanMessage.textContent = 'Worker 已启动…';
  elements.scanWarnings.textContent = '';
  elements.progressBar.style.width = '8%';
  try {
    const previous = latestSnapshot();
    const response = await scanWorker.request({
      type: 'start',
      root: state.root.handle,
      rootId: state.root.id,
      previousId: previous?.id ?? null,
      forceHash: state.nextScanForceHash ?? elements.forceHash.checked
    }, {
      onProgress: handleScanProgress
    });
    elements.progressBar.style.width = '100%';
    elements.scanState.textContent = response.type === 'unchanged' ? '无变化' : '完成';
    elements.scanClock.textContent = formatClock(Date.now());
    elements.scanMessage.textContent = response.message ?? '快照已提交到 IndexedDB。';
    toast(response.message ?? '快照生成完成。', response.type === 'unchanged' ? 'info' : 'success');
    await refreshSnapshots();
    const stats = response.snapshot?.stats ?? response.stats;
    if (response.type === 'complete' && stats && (stats.fileCount < 5000 || stats.totalBytes < 2 * 1024 ** 3)) {
      toast('该目录可用于测试，但规模小于 5000 文件或 2GB 的建议验收条件。', 'info');
    }
  } catch (error) {
    elements.scanState.textContent = error.name === 'AbortError' ? '已取消' : '失败';
    elements.scanMessage.textContent = error.message;
    const level = error.permission ? 'warning' : 'error';
    const message = error.permission
      ? '目录权限已撤销，请重新授权。'
      : error.details?.error?.quota
        ? 'IndexedDB 配额不足，请删除旧快照或释放站点数据。'
        : error.message;
    toast(message, level);
    if (error.permission) await refreshPermission();
  } finally {
    state.scanning = false;
    state.nextScanForceHash = null;
    elements.scanNow.disabled = state.permission !== 'granted';
    elements.cancelScan.hidden = true;
  }
}

function handleScanProgress(message) {
  const progress = message.progress;
  if (progress) {
    const discovered = progress.totalFiles + progress.totalDirectories;
    const hashRatio = progress.totalFiles ? progress.hashedFiles / progress.totalFiles : 0;
    const width = Math.min(96, 10 + (discovered / Math.max(discovered, 5000)) * 45 + hashRatio * 40);
    elements.progressBar.style.width = `${width}%`;
  }
  if (message.message) elements.scanMessage.textContent = message.message;
  if (message.progress) {
    const warnings = [];
    if (message.progress.symlinksSkipped) warnings.push(`跳过符号链接 ${message.progress.symlinksSkipped}`);
    if (message.progress.unreadableFiles) warnings.push(`不可读条目 ${message.progress.unreadableFiles}`);
    elements.scanWarnings.textContent = warnings.join(' · ');
  }
}

function cancelScan() {
  if (scanWorker) {
    scanWorker.replace(new URL('./workers/scan-worker.js', import.meta.url));
    state.scanning = false;
    elements.scanNow.disabled = state.permission !== 'granted';
    elements.cancelScan.hidden = true;
    elements.scanState.textContent = '已取消';
    elements.scanMessage.textContent = '扫描已取消，Worker 已重启。';
  }
}

async function browseSnapshot(snapshot) {
  try {
    state.currentSnapshot = await loadManifest(snapshot.id);
    state.currentSnapshotPath = '';
    renderCurrentTree();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderCurrentTree() {
  if (!state.currentSnapshot) return;
  const entries = Object.values(state.currentSnapshot.entries);
  renderBreadcrumbs(elements.breadcrumbs, state.currentSnapshotPath, (path) => {
    state.currentSnapshotPath = path;
    renderCurrentTree();
  });
  renderTreeTable(elements.treeBody, entries, state.currentSnapshotPath, {
    openDirectory: (path) => {
      state.currentSnapshotPath = path;
      renderCurrentTree();
    },
    download: async (entry) => {
      try {
        if (state.permission !== 'granted') {
          toast('下载快照内容不需要磁盘权限；正在从 IndexedDB 恢复。', 'info');
        }
        await downloadSnapshotEntry(entry);
      } catch (error) {
        toast(error.message, 'error');
      }
    }
  });
}

async function removeSnapshot(snapshot) {
  const confirmed = window.confirm(`确定删除 ${formatDate(snapshot.createdAt)} 的快照？唯一内容块会被引用计数回收。`);
  if (!confirmed) return;
  try {
    await deleteSnapshot(snapshot.id);
    state.manifests.delete(snapshot.id);
    if (state.currentSnapshot?.id === snapshot.id) {
      state.currentSnapshot = null;
      elements.treeBody.replaceChildren();
    }
    await refreshSnapshots();
    toast('快照已删除。', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function runDiff() {
  if (!diffWorker || !elements.fromSnapshot.value || !elements.toSnapshot.value) return;
  if (elements.fromSnapshot.value === elements.toSnapshot.value) {
    toast('请选择两个不同的快照。', 'warning');
    return;
  }
  elements.runDiff.disabled = true;
  elements.diffSummary.textContent = 'Worker 正在计算…';
  try {
    const result = await diffWorker.request({
      type: 'diff',
      fromId: elements.fromSnapshot.value,
      toId: elements.toSnapshot.value
    }, {
      onProgress: (message) => {
        elements.diffSummary.textContent = message.message;
      }
    });
    state.diff = result.result;
    state.diffFilter = 'all';
    state.diffPage = 0;
    renderDiff();
  } catch (error) {
    elements.diffSummary.textContent = error.message;
    toast(error.message, 'error');
  } finally {
    elements.runDiff.disabled = false;
  }
}

function filteredDiffChanges() {
  if (!state.diff) return [];
  if (state.diffFilter === 'all') return state.diff.changes;
  return state.diff.changes.filter((change) => change.status === state.diffFilter);
}

function renderDiff() {
  if (!state.diff) return;
  const changes = filteredDiffChanges();
  const pages = Math.max(1, Math.ceil(changes.length / DIFF_PAGE_SIZE));
  state.diffPage = Math.min(state.diffPage, pages - 1);
  const start = state.diffPage * DIFF_PAGE_SIZE;
  renderDiffTable(elements.diffBody, changes, start, DIFF_PAGE_SIZE);
  const summary = state.diff.summary;
  elements.diffSummary.innerHTML = '';
  elements.diffSummary.append(
    `共 ${summary.total} 项：新增 ${summary.added}，删除 ${summary.removed}，修改 ${summary.modified}，类型变化 ${summary.typeChanged}，不可读 ${summary.inaccessible}；块 +${summary.chunksAdded} / -${summary.chunksRemoved} / 相同 ${summary.chunksUnchanged}`
  );
  elements.diffPage.textContent = `${state.diffPage + 1} / ${pages}`;
  for (const chip of elements.diffFilters.querySelectorAll('.chip')) {
    chip.classList.toggle('active', chip.dataset.filter === state.diffFilter);
  }
}

function changeDiffFilter(filter) {
  state.diffFilter = filter;
  state.diffPage = 0;
  renderDiff();
}

async function openRollbackDialog(snapshot) {
  if (!state.root) return;
  if (state.permission !== 'granted') {
    renderBannerForPermission();
    toast('回滚前必须重新授权目录。', 'warning');
    return;
  }
  state.pendingRollback = snapshot;
  state.rollbackPlan = null;
  elements.rollbackTarget.textContent = `${snapshot.id.slice(0, 8)} · ${formatDate(snapshot.createdAt)}`;
  elements.rollbackPreview.textContent = '正在 Worker 中检查当前目录，请稍候…';
  elements.executeRollback.disabled = true;
  elements.rollbackDialog.showModal();
  try {
    const response = await rollbackWorker.request({
      type: 'plan',
      root: state.root.handle,
      snapshotId: snapshot.id,
      forceVerify: elements.rollbackVerify.checked
    }, {
      onProgress: (message) => {
        if (message.message) elements.rollbackPreview.textContent = message.message;
      }
    });
    state.rollbackPlan = response.plan;
    renderRollbackPlan();
  } catch (error) {
    elements.rollbackPreview.textContent = `无法生成回滚计划：${error.message}`;
    if (error.permission) await refreshPermission();
  }
}

function renderRollbackPlan() {
  const plan = state.rollbackPlan;
  if (!plan) return;
  const stats = plan.stats;
  elements.rollbackPreview.replaceChildren();
  const items = [
    ['新建文件', stats.createFiles],
    ['修改文件', stats.modifyFiles],
    ['删除额外文件', stats.removeFiles],
    ['删除额外目录', stats.removeDirectories],
    ['创建目录', stats.createDirectories],
    ['阻塞项', stats.blocked],
    ['警告', plan.warnings.length]
  ];
  for (const [label, value] of items) {
    const box = document.createElement('div');
    const number = document.createElement('strong');
    number.textContent = String(value);
    const name = document.createElement('div');
    name.className = 'muted';
    name.textContent = label;
    box.append(number, name);
    elements.rollbackPreview.append(box);
  }
  if (plan.blockers.length) {
    const blockerList = document.createElement('ul');
    for (const blocker of plan.blockers.slice(0, 8)) {
      const item = document.createElement('li');
      item.textContent = `${blocker.path || '/'}：${blocker.reason}`;
      blockerList.append(item);
    }
    elements.rollbackPreview.append(blockerList);
  }
  elements.executeRollback.disabled = plan.blockers.length > 0;
  elements.executeRollback.title = plan.blockers.length
    ? '存在符号链接或不可读阻塞项，已阻止回滚'
    : '执行恢复计划';
}

async function executeRollback() {
  if (!state.rollbackPlan || !state.root) return;
  try {
    await requestWritePermission();
  } catch (error) {
    toast(error.message, 'warning');
    return;
  }
  elements.executeRollback.disabled = true;
  elements.rollbackPreview.textContent = 'Worker 正在执行回滚…';
  try {
    const response = await rollbackWorker.request({
      type: 'execute',
      root: state.root.handle,
      plan: state.rollbackPlan
    }, {
      onProgress: (message) => {
        const progress = message.progress;
        if (progress?.path) {
          elements.rollbackPreview.textContent = `${message.progress.phase}: ${progress.path}`;
        }
      }
    });
    elements.rollbackDialog.close();
    const restored = response.result.completed.files.length;
    toast(`回滚完成，恢复了 ${restored} 个文件。建议立即生成新快照验证。`, 'success');
    await refreshPermission();
    state.nextScanForceHash = true;
    setTimeout(() => startScan(true), 250);
  } catch (error) {
    elements.rollbackPreview.textContent = `回滚中断：${error.message}。已完成的操作不会自动撤销。`;
    toast(error.permission ? '写入权限被撤销，回滚已停止。' : error.message, 'error');
    if (error.permission) await refreshPermission();
  }
}

function bindEvents() {
  elements.pickFolder.addEventListener('click', pickFolder);
  elements.requestPermission.addEventListener('click', requestPermission);
  elements.forgetRoot.addEventListener('click', forgetCurrentRoot);
  elements.scanNow.addEventListener('click', () => startScan(true));
  elements.cancelScan.addEventListener('click', cancelScan);
  elements.refreshList.addEventListener('click', refreshSnapshots);
  elements.runDiff.addEventListener('click', runDiff);
  elements.autoScan.addEventListener('change', configureTimer);
  elements.interval.addEventListener('change', configureTimer);
  elements.diffPrev.addEventListener('click', () => {
    if (state.diffPage > 0) {
      state.diffPage -= 1;
      renderDiff();
    }
  });
  elements.diffNext.addEventListener('click', () => {
    const pageCount = Math.ceil(filteredDiffChanges().length / DIFF_PAGE_SIZE);
    if (state.diffPage < pageCount - 1) {
      state.diffPage += 1;
      renderDiff();
    }
  });
  elements.diffFilters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (button) changeDiffFilter(button.dataset.filter);
  });
  elements.executeRollback.addEventListener('click', executeRollback);
  elements.rollbackDialog.addEventListener('close', () => {
    state.rollbackPlan = null;
    state.pendingRollback = null;
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.root && !state.scanning) refreshPermission();
  });

  if (navigator.storage?.persist) {
    document.addEventListener('click', async function persistOnce() {
      try {
        await navigator.storage.persist();
      } catch {
        // Storage persistence is best effort.
      }
      document.removeEventListener('click', persistOnce);
    }, { once: true });
  }
}

async function init() {
  bindEvents();
  renderSnapshotOptions(elements.fromSnapshot, [], null);
  renderSnapshotOptions(elements.toSnapshot, [], null);
  setControlsDisabled(!supportsFileSystemAccess());
  await restoreLastRoot();
}

init().catch((error) => {
  toast(error.message || '应用初始化失败', 'error');
});
