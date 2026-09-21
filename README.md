# 本地文件夹快照工具

零构建、零第三方运行时依赖的本地文件夹快照应用。技术栈为 File System Access API、IndexedDB、ES Module Web Worker。

## 功能

- 授权本地目录，并把 `FileSystemDirectoryHandle` 持久化到 IndexedDB；关闭浏览器后仍可恢复，只需用户再次确认授权。
- Worker 定时或手动遍历目录树，主线程不做目录扫描、哈希或 diff。
- 大文件按 4 MiB 块读取，使用 SHA-256 内容哈希做内容寻址，快照之间自动去重。
- 快照只提交新增内容块；旧快照仍保留各自清单和块引用，删除快照时通过引用计数回收块。
- 可浏览任意历史快照，从 IndexedDB 重新组装并下载其中的文件。
- 在 Worker 中对比任意两个快照，输出新增、删除、修改、类型变化，以及逐文件的新增/删除/相同块数。
- 回滚前在 Worker 中重新哈希当前目录并生成计划，确认后按块精确恢复，删除目标快照之后新增的文件和目录。
- 权限撤销后进入只读降级：历史快照、清单和已有 diff 仍可查看，扫描和回滚显示可操作提示，不崩溃。
- 遍历时跳过符号链接；如果运行环境支持非标准/未来的 `FileSystemHandle.isSymbolicLink()`，会直接识别，否则浏览器 API 本身不暴露链接类型。

## 运行

需要桌面版 Chrome、Edge 或 Opera，并通过 `localhost` 或 HTTPS 访问。

```bash
npm start
```

然后打开 <http://localhost:5173>。

也可以使用任何静态服务器，例如：

```bash
python3 -m http.server 5173
```

## 测试与检查

```bash
npm test
npm run check
```

测试覆盖：

- 20 个文件中精确识别 10 个修改文件。
- 文件级和块级 diff，验证共享块、新增块、删除块数量。
- 回滚计划精确恢复 10 个修改文件，并清理额外文件/目录。
- 文件与目录类型互换。
- 符号链接阻塞回滚，避免跟随链接写入。

## 5000 文件 / 2GB 验收数据

生成稀疏测试目录（逻辑大小约 2GB，实际磁盘占用很小；包含 5000 个文件和符号链接）：

```bash
node scripts/make-fixture.mjs ./fixture-large 5000 2147483648 10
```

建议流程：

1. 页面选择 `fixture-large`，等待首次快照。
2. 修改前 10 个标记文件：

   ```bash
   node scripts/mutate-markers.mjs ./fixture-large 10 acceptance-v2
   ```

3. 点击“立即扫描”，生成第二份快照。
4. 选择第一和第二份快照执行 diff，应看到 10 个 `file-0000.bin` 到 `file-0009.bin` 被修改；共享 4 MiB 块不计为变化，只有变化块增加。
5. 对第一份快照点击“回滚”，Worker 会重新哈希当前目录并显示计划：10 个文件修改、0 个阻塞。
6. 修改前先记录哈希；回滚后再次运行同一命令，应输出 `OK: 10 marker files match ...`：

   ```bash
   node scripts/hash-markers.mjs ./fixture-large 10 ./marker-hashes.json
   node scripts/mutate-markers.mjs ./fixture-large 10 acceptance-v2
   # 在页面生成第二份快照并回滚到第一份后：
   node scripts/hash-markers.mjs ./fixture-large 10 ./marker-hashes.json
   ```

   页面再次扫描或 diff 时，这 10 个文件也应与第一份快照一致。

扫描期间可滚动页面、切换快照和操作筛选器；扫描进度持续更新，主线程不遍历文件。

## 存储模型

IndexedDB 数据库：`local-folder-snapshots`

- `roots`：目录 ID、名称和目录句柄。
- `snapshotSummaries`：列表页使用的轻量统计，按 `rootId + createdAt` 建索引。
- `snapshotManifests`：完整目录树，每个文件保存大小、修改时间、内容哈希和分块描述。
- `chunkMeta`：块哈希、字节数、引用计数。
- `chunkBlobs`：内容寻址的 4 MiB `Blob`。

提交快照时，新块、快照摘要、完整清单在同一个 IndexedDB 读写事务中完成。引用计数根据相邻快照的块多集合差值更新，因此同一个块在多个文件或多个快照中复用也能正确释放。

## 回滚语义

- 目标中存在、当前缺失：创建父目录并按块写入。
- 当前内容哈希不同：先 truncate，再按原始偏移逐块写入。
- 目标之后新增：递归删除额外目录，非递归删除额外文件。
- 文件和目录类型互换：先删除当前项，再创建目标类型。
- 目标快照生成时不可读的文件没有块数据，会作为阻塞项阻止整次回滚，避免部分恢复造成误判。
- 当前路径是符号链接且目标需要该路径或其子路径时，回滚被阻塞，不会跟随或改写链接。

浏览器 File System Access API 不能恢复文件的原始 `lastModified`，所以回滚保证字节级内容一致，但修改时间可能变化。回滚完成后应用会建议立即扫描；内容哈希相同即恢复正确。

## 权限降级

- 初次选择目录必须由用户手势触发，并申请读取权限。
- 回滚时单独申请 `readwrite` 权限。
- 重新打开页面后会恢复句柄，但浏览器通常仍要求用户点击“重新授权”；这是浏览器安全模型，不代表数据丢失。
- 权限为 `prompt` 或 `denied` 时，页面显示“重新授权 / 重新选择目录 / 查看历史快照”操作；不会启动扫描或回滚。
- 如果 IndexedDB 配额不足，Worker 返回明确的配额提示，可删除旧快照或释放站点数据后重试。

## 符号链接说明

File System Access API 的公开标准长期不暴露符号链接类型。本应用会调用运行时存在的 `isSymbolicLink()` 方法（未来标准或支持该能力的浏览器可用），并在回滚计划中保护链接路径。在完全不暴露链接信息的浏览器中，浏览器可能按其底层安全策略把链接作为普通条目处理；这种能力缺口无法由网页单独可靠弥补。验收建议使用支持该检测能力的浏览器版本，或在测试目录中保留脚本生成的 `symlinks/` 观察统计。

## 主要文件

- `index.html`：页面结构。
- `src/main.js`：授权、定时任务、快照列表、diff 和回滚 UI 编排。
- `src/workers/scan-worker.js`：扫描、哈希、分块读取、快照提交。
- `src/workers/diff-worker.js`：快照清单加载和差异计算。
- `src/workers/rollback-worker.js`：当前目录校验、回滚计划和写入。
- `src/core/snapshot.js`：增量扫描算法。
- `src/core/diff.js`：文件和块差异算法。
- `src/core/rollback.js`：回滚计划与执行。
- `src/core/db.js`：IndexedDB 与引用计数事务。
