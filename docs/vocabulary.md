# 生词本（Vocabulary）设计文档

> 状态：v1.0（已实现 P0 + P1 上下文字段）
> 范围：仅 P0 / P1；P2（标签、复习模式、跨设备同步、页面高亮）暂不实现。

## 1. 目标

为划词翻译提供"轻量本地生词收藏夹"：

- 划词气泡（含单词词典模式）一键收藏／取消收藏
- 设置页集中查看、搜索、备注、删除
- 导入 / 导出（JSON 全量 / CSV 简易 / Anki TSV）
- 不做云同步、不做 SRS（间隔重复）算法
- 完全本地化，不引入新外部网络请求（除用户手动触发的导入导出）

## 2. 数据模型

### 2.1 `VocabItem`

```ts
interface VocabItem {
  id: string;            // crypto.randomUUID()
  word: string;          // 原词，保留大小写与原始空白
  normalized: string;    // word.toLowerCase().trim()，索引与去重用
  sourceLang: string;    // 收藏时检测 / 锁定的源语言（可能是 "auto"）
  targetLang: string;    // 当时的目标语言（与全局目标语言对应）
  translation: string;   // provider 返回的主译文
  dict: object | null;   // provider 返回的 dict 原样存储（音标/释义/例句），可空
  note: string;          // 用户备注，默认 ""
  sourceUrl: string;     // 收藏所在页面 URL
  sourceTitle: string;   // 收藏所在页面 title
  context: string;       // 选区前后 ~80 字符上下文（P1）
  createdAt: number;     // 时间戳 ms
}
```

### 2.2 不变量

- **去重键**：`(normalized, targetLang)` 全局唯一
- **重复添加**：静默更新 `sourceUrl / sourceTitle / context / createdAt`，**保留** 原 `id / note / dict / translation`（避免覆盖用户已写的备注；译文也以首次为准）
- **空 word 拒绝写入**：`trim` 后为空直接 reject
- **长度上限**：`word.length > 200` 拒绝（防止误把整段当生词）
- **dict 字段不内联展开**：原样存储，UI 渲染时按 provider 能力差异降级

## 3. 存储层

### 3.1 IndexedDB

| 项 | 值 |
|---|---|
| 库 | `itl-vocab` |
| 版本 | `1` |
| ObjectStore | `entries`，`keyPath: id` |
| 索引 `byNormalized` | `[normalized, targetLang]`，**unique** |
| 索引 `byCreatedAt` | `createdAt` |

选用 IndexedDB 而非 `chrome.storage.local` 的理由：

1. 容量更大（GB 级 vs 5MB）
2. 索引化查询：`byNormalized` 让 `vocab-check` 走 O(log n) 而非全表扫
3. 与既有 `cache.js` 用同一套技术栈，错误处理 / cleanup 模式一致

### 3.2 容量与淘汰

- 上限 `MAX_ENTRIES = 5000`
- 超出按 `byCreatedAt` 升序删除最旧条目（与 cache 一致）
- 接近上限时由设置页面板提示用户导出

### 3.3 错误处理

参照 [cache.js](../cache.js)：

- 写入失败：吞错 + console.warn，**不阻塞气泡 / 翻译主流程**
- 读取失败：返回 `null` / `[]`
- 唯一索引冲突：调用方按"已存在"处理（不抛错给 UI）

## 4. 消息协议（content / options → background）

所有走 `chrome.runtime.sendMessage`，响应格式统一 `{ok: boolean, ...}` 或 `{ok: false, error: string}`。

### 4.1 协议表

| `msg.type` | 入参字段 | 响应 |
|---|---|---|
| `vocab-add` | `payload: VocabAddPayload` | `{ok, added, id}` |
| `vocab-remove` | `id` | `{ok}` |
| `vocab-remove-by-word` | `normalized, targetLang` | `{ok}` |
| `vocab-check` | `normalized, targetLang` | `{ok, exists, id?}` |
| `vocab-list` | `filter?` | `{ok, items, total}` |
| `vocab-update-note` | `id, note` | `{ok}` |
| `vocab-clear-all` | — | `{ok, cleared}` |
| `vocab-export` | — | `{ok, data: ExportFile}` |
| `vocab-import` | `data, mode` | `{ok, added, skipped}` |
| `vocab-stats` | — | `{ok, count, oldestAt, newestAt}` |

### 4.2 `VocabAddPayload`

```ts
interface VocabAddPayload {
  word: string;
  translation: string;
  sourceLang: string;
  targetLang: string;
  dict?: object | null;
  sourceUrl?: string;
  sourceTitle?: string;
  context?: string;
}
```

`id / normalized / createdAt / note` 由 background 内部生成。

### 4.3 `vocab-list` 过滤参数

```ts
interface ListFilter {
  search?: string;       // 子串匹配 word / translation / note（全部 toLowerCase）
  targetLang?: string;   // 精确匹配；缺省返回全部
  sortBy?: "createdDesc" | "createdAsc" | "wordAsc" | "wordDesc";  // 默认 createdDesc
  limit?: number;        // 默认不限制（5000 上限本身足够小）
  offset?: number;       // 默认 0
}
```

### 4.4 `ExportFile`

```ts
interface ExportFile {
  version: 1;
  exportedAt: number;
  items: VocabItem[];
}
```

### 4.5 `vocab-import` 模式

- `mode: "merge"`：现有不动；新条目按 `(normalized, targetLang)` 去重后追加；返回 `{added, skipped}`
- `mode: "replace"`：先 `clear` 再批量插入；返回 `{added, skipped: 0}`

## 5. `vocab.js` API（数据层）

> `vocab.js` 与 `cache.js` 平级，仅在 Service Worker 中加载使用。content / options 不直接 import，全部走 message。

```js
export async function vocabAdd(payload) -> {added, id, item}
export async function vocabRemove(id) -> void
export async function vocabRemoveByWord(normalized, targetLang) -> void
export async function vocabCheck(normalized, targetLang) -> {exists, id?}
export async function vocabGet(id) -> VocabItem | null
export async function vocabList(filter) -> {items, total}
export async function vocabUpdateNote(id, note) -> void
export async function vocabClearAll() -> number
export async function vocabExportAll() -> ExportFile
export async function vocabImport(data, mode) -> {added, skipped}
export async function vocabStats() -> {count, oldestAt, newestAt}
export function normalizeWord(word) -> string  // 工具函数，与 background 共享
```

## 6. 划词气泡集成（`content.js`）

### 6.1 入口位置

仅在 **划词气泡**（普通模式 + 词典模式）显示星标按钮，**不**加到悬停 / 输入框 / 整页翻译。

### 6.2 星标 UI

- 普通模式：气泡左上角 / 右上角加 `<button class="itl-sel-star">☆</button>`，已收藏切到 `★` + `.starred`
- 词典模式：星标按钮放在 `itl-sel-headword-row` 末尾（与发音按钮同行）
- 按钮 `pointer-events: auto`，因为气泡整体 `user-select: none` 但需要点击

### 6.3 状态机

```
气泡显示
  └─ 翻译成功后 sendMessage({type: "vocab-check", normalized, targetLang})
     ├─ exists=true  → 星标渲染为 ★（.starred）
     └─ exists=false → 星标渲染为 ☆
点击星标 / 按 S
  ├─ 当前为 ☆ → sendMessage({type: "vocab-add", payload}) → 切换 ★
  └─ 当前为 ★ → sendMessage({type: "vocab-remove-by-word"}) → 切换 ☆
```

`S` 键监听只在 `selectionBubble` 存在时生效（不抢全局 `S`）。区分 input/textarea/contentEditable 不触发。

### 6.4 收藏数据来源

| 字段 | 来源 |
|---|---|
| `word` | 选区原文（trim 后） |
| `translation` | provider 返回的主译文 |
| `sourceLang` | 当前生效 `sourceLang`（划词通常 "auto"，无单独配置） |
| `targetLang` | 当前生效 `targetLang` |
| `dict` | provider 返回的 dict 字段 |
| `sourceUrl` | `location.href` |
| `sourceTitle` | `document.title` |
| `context` | 选区前后各 ~80 字符（见 6.5） |

### 6.5 上下文提取

```js
function extractContext(range) {
  // 取选区所在 block 的 textContent；
  // 选区在 block 中的偏移前后各取 ~80 字符，跨节点拼接，用 "…" 截断
  // 失败回退 ""
}
```

实现要点：

- 用 `range.startContainer` 找最近的 `BLOCK_SELECTOR`
- 用 `Range.toString()` + `parent.textContent` 的 `indexOf` 定位选区在父块中的偏移（启发式，对嵌入 `<strong>` / `<a>` 等行内标签足够）
- 极端失败（Shadow Root / 复杂富文本）回退空字符串

### 6.6 不变量

- 星标按钮 `pointer-events: auto`；`onclick` 内 `stopPropagation()` 防止误触发气泡级 mousedown 关闭
- 失败（network / storage）静默写 `console.warn`，气泡不报错，**仍切换视觉态再回滚**（乐观更新）
- `turnOff()` **不**清理 selectionBubble（既有约束保持）

## 7. 设置页面板（`options.html` / `options.js`）

### 7.1 侧栏入口

在「站点规则」与「本地缓存」之间插入 `<a class="nav-link" data-page="vocab" href="#vocab">生词本</a>`。`VALID_PAGES` 加 `vocab`。

### 7.2 工具栏（顶部）

| 控件 | 行为 |
|---|---|
| 搜索框 | 实时（debounce 200ms）过滤 `word / translation / note` |
| 语言下拉 | `targetLang` 精确筛选；首项「全部」 |
| 排序下拉 | 最近添加 / 最早添加 / 字母 A→Z / 字母 Z→A |
| 「导出」按钮 | 弹格式选择：JSON / CSV / Anki TSV |
| 「导入」按钮 | `<input type="file" accept=".json">` 隐藏触发 |
| 「全部清空」按钮 | 二次确认 |
| 统计文字 | "共 X 条，最早 YYYY-MM-DD" |

### 7.3 列表

表格视图：

```
☆/★  word           译文           来源             添加         操作
ubiquitous           无处不在的     nytimes.com     05-12 14:32  [详情] [备注] [删除]
```

- 点击行展开详情卡片（音标、词性释义、例句）
- 点击「备注」打开 inline `<input>`，blur 时保存
- 「删除」二次确认

### 7.4 导入 / 导出格式

**JSON**（完整结构）：

```json
{
  "version": 1,
  "exportedAt": 1737000000000,
  "items": [
    { "id": "...", "word": "...", "normalized": "...", ... }
  ]
}
```

**CSV**（Excel / Notion 友好）：

```
word,translation,phonetic,sourceLang,targetLang,note,sourceUrl,createdAt
"ubiquitous","无处不在的","/juːˈbɪkwɪtəs/","en","zh-CN","","https://...","2026-05-28T14:32:00Z"
```

`phonetic` 取 `dict.phonetics[0]?.ipa` 或空。CSV 转义按 RFC 4180（内含 `"` 时翻倍，含逗号 / 换行加引号）。

**Anki TSV**（两列）：

```
ubiquitous<TAB>/juːˈbɪkwɪtəs/<br>无处不在的<br>· widespread...<br>· present everywhere...
```

`<br>` 是 Anki 卡片字段里的换行（HTML 段）。

导入仅接受 JSON；CSV / TSV 是单向导出。

### 7.5 与 background 通信

设置页**所有**生词本操作都走 `sendMessage`，不在 options 直接打开 IndexedDB（保持"IDB 持有者只有一个"，与 cache 一致）。

## 8. 文件清单与改动范围

| 文件 | 新建 / 修改 | 改动描述 |
|---|---|---|
| `vocab.js` | **新建** | IndexedDB 数据层 + 工具函数 |
| `background.js` | 修改 | 增加 9 条 `vocab-*` 消息路由（含 `vocab-import` / `vocab-export`） |
| `content.js` | 修改 | 划词气泡内星标按钮、`S` 键、`extractContext`、`vocab-check / add / remove` 委托 |
| `content.css` | 修改 | `.itl-sel-star` / `.itl-sel-star.starred` 样式 |
| `options.html` | 修改 | 侧栏 + `<section data-page="vocab">` 工具栏、列表、详情、对话框 |
| `options.js` | 修改 | 路由加 `vocab`；生词本面板模块（独立 IIFE / 命名空间，避免污染） |
| `manifest.json` | 不变 | — |
| `CLAUDE.md` | 修改 | 文件清单加 vocab.js；新增「生词本」小节 |
| `docs/vocabulary.md` | **新建** | 本文档 |

## 9. 并行开发任务划分

### 9.1 阻塞前置（T0，必须先完成）

**T0 — 数据层 + 协议骨架**

- 写 `vocab.js`（导出函数签名 + IndexedDB schema + 错误吞咽实现）
- `background.js` 注册 9 条 `vocab-*` 路由
- 落本设计文档

> T0 完成后，后续三个任务**互不依赖**，可由 3 个开发者 / agent 并行做。

### 9.2 并行任务

**T1 — 划词气泡星标**（负责人：负责 content.js 的开发者）

- 改动文件：`content.js`、`content.css`
- 依赖：消息协议（4.1）；不需要等 options
- 验收：
  - 划词命中 → 气泡右上角 ☆，已收藏页面再次划词同一词显示 ★
  - 点击星标 / 按 S → 状态翻转，重新打开气泡仍正确
  - 收藏一段 200 字以上文本被拒（不写入）
  - turnOff() 后再 turnOn() 不影响星标功能

**T2 — 设置页生词本面板**（负责人：负责 options 的开发者）

- 改动文件：`options.html`、`options.js`
- 依赖：消息协议（4.1）；不需要等 content
- 验收：
  - 侧栏点击「生词本」跳到面板
  - 列表正确分页、搜索、筛选、排序
  - 导出 JSON / CSV / Anki TSV 三种格式可下载
  - 导入 JSON（合并 / 覆盖）成功后列表立刻刷新
  - 全部清空有二次确认

**T3 — 文档同步**（负责人：任意；可在 T0 完成后立即做）

- 改动文件：`CLAUDE.md`、`README.md`（可选）
- 依赖：T0 的设计落地（本文档）；不依赖 T1 / T2 的实现细节
- 验收：CLAUDE.md 文件清单含 vocab.js、新增「生词本」小节描述消息流

### 9.3 冲突表（哪些文件可能被多人改）

| 文件 | T0 | T1 | T2 | T3 | 冲突风险 |
|---|---|---|---|---|---|
| `vocab.js` | ✏️ | — | — | — | 无 |
| `background.js` | ✏️ | — | — | — | 无 |
| `content.js` | — | ✏️ | — | — | 无 |
| `content.css` | — | ✏️ | — | — | 无 |
| `options.html` | — | — | ✏️ | — | 无 |
| `options.js` | — | — | ✏️ | — | 无 |
| `CLAUDE.md` | — | — | — | ✏️ | 无 |
| `docs/vocabulary.md` | ✏️ | — | — | — | 无 |

**T0 是唯一的串行瓶颈**；T1 / T2 / T3 之间没有任何共享文件，可完全并行。

### 9.4 接口稳定性承诺

T0 落地后，本文档第 2 / 4 / 5 节列出的契约**视为冻结**。T1 / T2 仅依赖这些契约，不读 vocab.js 内部实现。任何对契约的变更需要同步改本文档并通知 T1 / T2 owner。

## 10. 不做的事 / 边界

- **不引入外部依赖**：沿用"无构建无依赖"约束
- **不发起额外网络请求**：除用户主动导入导出
- **不进入 content 上下文**：`vocab.js` 仅在 Service Worker 加载
- **不替代 `chrome.storage.sync`**：偏好仍走 sync；生词本数据量大用 IndexedDB
- **不做"自动加入生词本"**：必须用户显式点星标 / 按 S
- **不做 SRS / 复习模式**：与「Lite」定位冲突
- **不做云同步**：超出 Lite 范围
- **不做页面内自动高亮生词**（P2）：实现成本与性能开销不匹配 MVP 价值

## 11. 后续可选扩展（不在 v1.0 范围）

- **页面内自动高亮**（P2）：访问网页时遍历文本节点，为收藏过的词加下划虚线。需配套：
  - `Set<normalized>` 内存索引由 background 推送
  - IntersectionObserver 限定可视区
  - 与 `data-itl-done` 体系共存的标记
- **标签 / 文件夹**（P2）：`tags: string[]` 字段已预留位（数据模型扩展，向前兼容）
- **复习模式**（P2）：随机抽词 + 用户标"认识 / 不认识"，更新 `reviewedAt`
- **跨设备同步**（P2）：需要外部账号体系，超出 Lite 范围

## 12. 测试清单（手测）

> 无单元测试，按 README 的开发循环走手测。

- [ ] 划词单词 → 气泡显示 ☆ → 点击变 ★ → 关闭气泡再划同词显示 ★
- [ ] 点击 ★ → 变 ☆ → 设置页生词本中已删除
- [ ] 划词短语（≥ 2 字符 ≤ 200 字符）→ 收藏成功
- [ ] 划词 201 字符以上文本 → 收藏被拒，console.warn
- [ ] 同词不同 `targetLang` → 设置页显示 2 条独立记录
- [ ] 重复添加同 `(normalized, targetLang)` → 已存在记录的 `sourceUrl / createdAt` 更新，`note` 不丢
- [ ] 设置页搜索 "ubi" → 命中 ubiquitous
- [ ] 导出 JSON → 文件内容含全部字段 → 清空 → 导入 JSON（合并）→ 恢复
- [ ] 导出 CSV → Excel 可正确打开，含逗号 / 引号的备注转义正确
- [ ] 导出 Anki TSV → Anki 导入两列卡片显示正确
- [ ] 设置页全部清空 → 二次确认 → 列表清空
- [ ] IndexedDB 报错时（DevTools 模拟）→ 气泡仍正常显示译文，星标失败仅 console.warn

## 13. 版本历史

- **v1.0**（2026-05-29）— P0 + P1（含 context 字段）首版上线
