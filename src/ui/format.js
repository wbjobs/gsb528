export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Number(bytes);
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDate(timestamp) {
  if (!timestamp) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(new Date(timestamp));
}

export function formatClock(timestamp) {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat('zh-CN', { timeStyle: 'medium' }).format(new Date(timestamp));
}

export function truncateMiddle(value, max = 18) {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(6, max - 5))}…${value.slice(-6)}`;
}
