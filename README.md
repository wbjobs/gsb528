# 本地文件夹快照工具

纯前端（零构建、零运行时依赖）的本地目录增量快照与回滚工具。

- **File System Access API** 授权并读写本地目录，句柄持久化在 IndexedDB，重开浏览器可恢复。
- **分块 + 内容寻址**：文件按块（默认 4 MiB）切分，SHA-256 作为块 ID 存入 IndexedDB；
  每次扫描只写入新增/变化的块，未变化文件（size+mtime 相同）直接复用上一快照的块哈希。
- **任意历史快照 / 两快照 diff / 一键回滚**：回滚按快照字节精确重建被改动的文件。
- **扫描与 diff 全部在 Web Worker 中执行**，主线程只渲染 UI，扫描 5000+ 文件时页面保持可交互。
- **权限撤销降级**：句柄仍在但授权失效时，页面给出可操作的“重新授权”横幅，绝不崩溃。

## 运行

需要桌面版 **Chrome / Edge（Chromium 内核，较新版本）**，并通过 `http://localhost` 打开
（File System Access API 要求安全上下文，`file://` 不可用）。

```bash
node scripts/serve.js        # 或 npm start，默认 http://localhost:8731
# 也可以：python3 -m http.server 8731
```

打开 <http://localhost:8731> → “选择目录”并授予**读写**权限 → “立即扫描”。

## 使用流程

1. **选择目录**：授权后句柄写入 IndexedDB（`kv` 表）。关闭浏览器再打开会自动尝试恢复；
   浏览器策略要求每个会话至少一次用户确认时，会显示“重新授权此目录”按钮（必须在点击手势中授权）。
2. **立即扫描**：Worker 遍历目录树、对文件分块哈希，写入内容寻址块和快照记录。
3. **定时扫描**：设置中开启（默认 30 分钟）。仅在页面可见、未在扫描、权限有效时触发。
4. **查看历史快照**：点快照时间查看该版本全部文件，支持路径过滤、分页、下载文件的该版本内容。
5. **对比**：在列表中分别选中基准/目标快照 → “对比选中的两个快照”，得到新增/删除/修改清单，
   修改文件可展开查看块级差异（修改/新增/删除的块区间、复用块数）。
6. **回滚**：点“回滚到此”→ 先干跑扫描并列出精确变更（写多少、删多少）→ 确认后写入磁盘。
   回滚后建议再拍一个快照。
7. **清理**：删除快照会级联删除其后的快照（快照按时间链组织）；“清理无引用块”执行 GC 回收空间。

## 验收（5000 文件 / 2GB / 修改 10 个文件）

### A. 浏览器端人工验收

```bash
# 1) 生成 5100 文件、约 2GB 的稀疏夹具（实际磁盘占用很小）
node scripts/make-fixture.js /tmp/snap-fixture            # 或 npm run fixture -- /tmp/snap-fixture

# 2) 浏览器授权 /tmp/snap-fixture，扫描生成【快照 1（基线）】

# 3) 修改恰好 10 个文件（覆盖/追加/截断三种方式），生成 modify-record.json
node scripts/modify-files.js /tmp/snap-fixture 10

# 4) 回到页面【立即扫描】生成【快照 2】
#    对快照1→快照2做 diff，应精确显示 10 个修改文件

# 5) 点“回滚到此”选择【快照 1】并确认

# 6) 字节级校验 10 个文件全部恢复
node scripts/verify-rollback.js /tmp/snap-fixture
# => 🎉 全部 10 个被修改文件均已精确恢复（字节级一致）
```

其余验收点：

- **页面不阻塞**：扫描过程中点击设置、展开快照、在日志框滚动均流畅（重活全在 Worker）。
- **权限降级**：在浏览器站点设置里撤销该目录权限（或撤销文件系统授权），
  页面顶部出现错误横幅 + “重新授权”按钮；扫描/回滚停止且已存数据不丢失，重新授权后恢复。
- **大文件分块**：夹具含两个大文件（约 240MB / 160MB），按 4MiB 分块读取并带进度。
- **增量存储**：快照 2 的统计显示“新增块”仅为变化部分；未改动文件不重读内容。
- **存储占用**：页面右上角显示 IndexedDB 用量/配额。

> 提示：浏览器可能在存储压力下回收 IndexedDB。已在启动时请求 `navigator.storage.persist()`；
> 若块数据被清理，回滚会明确报“快照块数据缺失”而不是写入损坏内容。

### B. 自动化测试（纯逻辑 + 端到端语义模拟，无需浏览器）

```bash
npm test
# tests/lib.test.mjs           diff/块差异/回滚计划/忽略规则 47 个断言
# tests/rollback.sim.test.mjs  真实文件系统：5100 文件夹具 → 改 10 个 →
#                              diff 精确 10 → 按块回滚 → SHA-256 校验 10/10 一致
```

模拟测试使用与 Worker 完全相同的 `diffSnapshots`/`planRollback` 实现与 4MiB 分块规则，
端到端验证“修改 10 个文件后回滚精确恢复”。

## 架构

```
index.html                 页面骨架（横幅/快照表/详情/diff 弹窗/回滚弹窗/日志）
css/style.css
js/
  app.js                   主线程：UI、编排、定时、权限状态、降级提示
  worker-client.js         Worker 的 Promise 化封装 + 进度订阅
  handle-store.js          目录句柄持久化（IndexedDB kv）与权限 query/request
  lib/
    idb.js                 IndexedDB：kv / snapshots / chunks 三表 + GC + 配额
    fs-helpers.js          分块读取+SHA-256、目录遍历、并发池、环路检测、权限错误判定
    diff.js                纯逻辑：快照 diff、块级 diff、回滚操作计划（Node 可测）
    ignore.js              .gitignore 风格忽略规则
worker/
  main.js                  Worker 入口：scan/diff/rollback/gc/readFile/abort 协议
  scanner.js               扫描：遍历→(size,mtime)复用或分块哈希→只写新块→存快照
  rollback.js              回滚：扫描当前树→planRollback→删/建/写（块数据重建文件）
scripts/                   静态服务器 + 夹具生成/修改/校验
tests/                     Node 测试
```

### IndexedDB 结构（数据库 `folder-snapshots`）

- `kv`：`rootDirectoryHandle`（可结构化克隆的目录句柄）、元信息。
- `snapshots`：`{id,createdAt,label,chunkSize,entries[],stats}`，全量条目，
  按时间链组织；因此删除某快照会级联删除其后的快照（UI 有明确确认）。
- `chunks`：`{hash,size,bytes:Blob}`，内容寻址，跨所有快照去重；GC 按全量引用回收。

### 回滚正确性

回滚先完整扫描当前树得到“当前全量条目”，再与目标快照做集合 diff：

- 修改/新增（相对当前缺失）→ 用目标快照的块序列 `createWritable({keepExistingData:false})` 重写；
- 目标中不存在的文件 → `removeEntry`；多余目录深先删、缺失目录浅先建；
- 类型冲突（文件↔目录）先删后建/写。

未变化文件完全不触碰。文件**修改时间(mtime)无法经 Web API 恢复**，字节内容完全一致，
因此夹具校验与自动化测试均以 **大小 + SHA-256** 判定。

## 平台限制（请知悉）

- **符号链接**：File System Access API 不暴露条目是否为 symlink，Chromium 会透明跟随，
  无法可靠“跳过”。本工具：
  1. 提供 `.gitignore` 风格忽略规则，可按名称/路径跳过已知链接（如 `linkdir/`）；
  2. 遍历时用 `isSameEntry` 与祖先目录比对，检测指回树内的链接环路并跳过，杜绝无限递归。
  指向树外的符号链接仍可能被跟随，这是浏览器平台限制，非本工具可绕过。
- 只支持 Chromium 系桌面浏览器；Safari/Firefox 对 File System Access 的读写支持不完整。
- 写权限与读权限分开申请；仅有读权限时可扫描/diff，回滚按钮禁用并给出说明。
