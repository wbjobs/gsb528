import { formatBytes, formatDate } from './format.js';

const STATUS_LABELS = {
  added: '新增',
  removed: '删除',
  modified: '修改',
  typeChanged: '类型变化',
  inaccessible: '不可读'
};

export function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function setBanner(element, state) {
  if (!state) {
    element.className = 'banner info';
    element.replaceChildren();
    return;
  }
  element.className = `banner show ${state.level ?? 'info'}`;
  element.replaceChildren();
  const title = createElement('strong', null, state.title);
  const body = createElement('p', null, state.message);
  element.append(title, body);
  if (state.actions?.length) {
    const actions = createElement('div', 'banner-actions');
    for (const action of state.actions) {
      const button = createElement('button', `button ${action.danger ? 'danger' : ''}`, action.label);
      button.type = 'button';
      button.addEventListener('click', action.onClick);
      actions.append(button);
    }
    element.append(actions);
  }
}

export function renderSnapshotOptions(select, snapshots, selectedId) {
  const current = selectedId ?? select.value;
  select.replaceChildren();
  for (const snapshot of snapshots) {
    const option = document.createElement('option');
    option.value = snapshot.id;
    option.textContent = `${formatDate(snapshot.createdAt)} · ${snapshot.stats?.fileCount ?? 0} 文件`;
    select.append(option);
  }
  if (snapshots.some((snapshot) => snapshot.id === current)) select.value = current;
  select.disabled = snapshots.length < 1;
}

export function renderSnapshotTable(tbody, snapshots, handlers) {
  tbody.replaceChildren();
  if (!snapshots.length) {
    const row = createElement('tr');
    const cell = createElement('td', 'empty', '暂无快照；授权目录并完成一次扫描后生成。');
    cell.colSpan = 7;
    row.append(cell);
    tbody.append(row);
    return;
  }

  snapshots.forEach((snapshot, index) => {
    const row = createElement('tr');
    const stats = snapshot.stats ?? {};
    const label = createElement('td', null, `#${snapshots.length - index}`);
    label.append(createElement('div', 'mono', snapshot.id.slice(0, 8)));
    const time = createElement('td', null, formatDate(snapshot.createdAt));
    const files = createElement('td', null, String(stats.fileCount ?? 0));
    const changes = createElement('td');
    changes.append(
      createElement('span', 'change-added', `+${stats.addedFiles ?? 0} `),
      createElement('span', 'change-removed', `-${stats.removedFiles ?? 0} `),
      createElement('span', 'change-modified', `~${stats.modifiedFiles ?? 0}`)
    );
    const size = createElement('td', null, formatBytes(stats.totalBytes ?? 0));
    const chunks = createElement('td', null, `${stats.newChunkCount ?? 0} 块 / ${formatBytes(stats.newChunkBytes ?? 0)}`);
    const actions = createElement('td');
    const actionsRow = createElement('div', 'button-row');
    const browseButton = createElement('button', 'button', '浏览');
    browseButton.type = 'button';
    browseButton.addEventListener('click', () => handlers.browse(snapshot));
    const rollbackButton = createElement('button', 'button danger ghost', '回滚');
    rollbackButton.type = 'button';
    rollbackButton.addEventListener('click', () => handlers.rollback(snapshot));
    const deleteButton = createElement('button', 'button ghost', '删除');
    deleteButton.type = 'button';
    deleteButton.addEventListener('click', () => handlers.delete(snapshot));
    actionsRow.append(browseButton, rollbackButton, deleteButton);
    actions.append(actionsRow);
    row.append(label, time, files, changes, size, chunks, actions);
    tbody.append(row);
  });
}

export function renderBreadcrumbs(container, path, onNavigate) {
  container.replaceChildren();
  const root = createElement('button', null, '/');
  root.type = 'button';
  root.addEventListener('click', () => onNavigate(''));
  container.append(root);
  let current = '';
  for (const part of path.split('/').filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    const target = current;
    container.append(document.createTextNode('/'));
    const link = createElement('button', null, part);
    link.type = 'button';
    link.addEventListener('click', () => onNavigate(target));
    container.append(link);
  }
}

export function renderTreeTable(tbody, entries, path, handlers) {
  tbody.replaceChildren();
  const prefix = path ? `${path}/` : '';
  const children = entries
    .filter((entry) => entry.parent === path && entry.path.startsWith(prefix))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

  if (!children.length) {
    const row = createElement('tr');
    const cell = createElement('td', 'empty', '此目录为空');
    cell.colSpan = 5;
    row.append(cell);
    tbody.append(row);
    return;
  }

  for (const entry of children) {
    const row = createElement('tr');
    const nameCell = createElement('td');
    if (entry.kind === 'directory') {
      const button = createElement('button', 'linklike', `📁 ${entry.name}`);
      button.type = 'button';
      button.style.border = '0';
      button.style.background = 'none';
      button.style.color = 'var(--primary)';
      button.style.padding = '0';
      button.style.cursor = 'pointer';
      button.addEventListener('click', () => handlers.openDirectory(entry.path));
      nameCell.append(button);
    } else {
      nameCell.textContent = `📄 ${entry.name}`;
      if (entry.unreadable) {
        nameCell.append(createElement('span', 'change-inaccessible', '（不可读）'));
      }
    }
    const kind = createElement('td', null, entry.kind === 'directory' ? '目录' : '文件');
    const size = createElement('td', null, entry.kind === 'file' ? formatBytes(entry.size) : '—');
    const modified = createElement('td', null, entry.kind === 'file' ? formatDate(entry.lastModified) : '—');
    const operation = createElement('td');
    if (entry.kind === 'file' && !entry.unreadable) {
      const download = createElement('button', 'button', '下载');
      download.type = 'button';
      download.addEventListener('click', () => handlers.download(entry));
      operation.append(download);
    }
    row.append(nameCell, kind, size, modified, operation);
    tbody.append(row);
  }
}

export function renderDiffTable(tbody, changes, start, limit) {
  tbody.replaceChildren();
  const page = changes.slice(start, start + limit);
  if (!page.length) {
    const row = createElement('tr');
    const cell = createElement('td', 'empty', '没有匹配的差异');
    cell.colSpan = 4;
    row.append(cell);
    tbody.append(row);
    return;
  }
  for (const change of page) {
    const row = createElement('tr');
    const status = createElement('td', null, STATUS_LABELS[change.status] ?? change.status);
    status.classList.add(`change-${change.status}`);
    const path = createElement('td', 'path-cell', change.path);
    let sizeText = '';
    if (change.kind === 'file' || change.oldKind === 'file' || change.newKind === 'file') {
      sizeText = `${formatBytes(change.oldSize)} → ${formatBytes(change.newSize)}`;
    }
    const sizes = createElement('td', null, sizeText || '—');
    const chunks = createElement('td', null, change.chunks
      ? `+${change.chunks.added} / -${change.chunks.removed} / =${change.chunks.unchanged}`
      : '—');
    row.append(status, path, sizes, chunks);
    tbody.append(row);
  }
}
