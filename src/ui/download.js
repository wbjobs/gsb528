import { getChunkBlob } from '../core/db.js';

export async function downloadSnapshotEntry(entry) {
  const blobs = [];
  for (const chunk of entry.chunks ?? []) {
    const blob = await getChunkBlob(chunk.hash);
    if (!blob) throw new Error(`缺少内容块：${chunk.hash.slice(0, 10)}`);
    blobs.push(blob);
  }
  const file = new Blob(blobs, { type: 'application/octet-stream' });
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = entry.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
