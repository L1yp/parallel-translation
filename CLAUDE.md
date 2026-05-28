# CLAUDE.md

本文件为 Claude Code 在本仓库中工作时的项目级指引。

## 项目概览

**沉浸式翻译 Lite** —— 一个 Chrome 扩展（Manifest V3），实现"原文在上、译文在下"的双语对照网页翻译。后端走 `translate.googleapis.com` 的非官方免费接口，仅供个人学习使用。

## 架构

三段式 Chrome 扩展架构，按 MV3 的消息边界分离职责：

- **`manifest.json`** —— MV3 配置。声明权限（`activeTab` / `scripting` / `storage`）、host 权限（仅 `translate.googleapis.com`）、后台 Service Worker、`<all_urls>` 上的内容脚本注入（`document_idle`）。
- **`background.js`** —— Service Worker。**唯一发起翻译 fetch 的地方**，内容脚本通过 `chrome.runtime.sendMessage({type: "translate"})` 委托过来。这样做的目的：绕过部分页面的 CORS 限制，并集中处理网络请求。响应必须 `return true` 以走异步 `sendResponse`。
- **`content.js`** —— 注入到每个页面的核心逻辑。负责 DOM 遍历、可见性过滤、并发调度、译文插入与清理。**所有 DOM 操作都集中在这里**，不要把 DOM 逻辑下沉到 background。
- **`popup.html` / `popup.js`** —— 工具栏弹窗。仅做用户交互：选语言、发 `{type: "toggle"}` 给当前 tab 的内容脚本、持久化语言偏好到 `chrome.storage.sync`。

### 关键消息流

```
popup.js  --sendMessage(toggle)-->  content.js  --sendMessage(translate)-->  background.js  --fetch-->  Google
```

popup 不直接调 background；content 不直接 fetch 外部接口。每条边界都对应 MV3 的一个隔离上下文，跨越时必须用 `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`。

## 翻译单元的选择策略（content.js）

`BLOCK_SELECTOR` 列出候选的块级元素（`p, li, h1-h6, blockquote, dd, dt, figcaption, td, caption`）。`collect()` 里的过滤逻辑很关键，改动时务必保留这些不变量：

- **`data-itl-done` 标记**：已处理的元素打标，避免重复翻译。
- **跳过 `.itl-translation`**：不翻译我们自己插入的译文节点（否则会无限递归）。
- **跳过含子块的容器**：`el.querySelector(BLOCK_SELECTOR)` 命中则跳过 —— 只翻译叶子块，避免父子重复。
- **可见性过滤**：`display:none` / `visibility:hidden` 的元素不译。
- **文本长度 ≥ 2**：过滤掉空段、单字符。

并发由 `CONCURRENCY = 4` 个 worker 共享同一个 `queue` 控制。**提高这个值会触发 Google 的非官方接口限流**，谨慎调整。

## 开关 / 还原

`isOn` 是页面级状态。`removeAll()` 通过移除 `.itl-translation` 节点 + 清掉 `data-itl-done` 属性来还原页面，**没有保存原始 DOM 快照**。因此：

- 不要把译文 **替换** 进原文节点 —— 必须作为新的子节点 append（当前实现已经是这样）。
- 增加新功能时，任何对原始 DOM 的修改都需要在 `removeAll()` 里有对应的逆操作。

## 开发与调试

无构建步骤、无依赖、无测试。开发循环：

1. 改代码。
2. 打开 `chrome://extensions/` → 找到本扩展 → 点击刷新按钮（重新加载扩展）。
3. **刷新目标网页**（内容脚本只在页面加载时注入；安装/重载扩展之前已经打开的 tab 不会自动注入）。
4. content.js 的日志走页面 DevTools Console；background.js 的日志在扩展页面里点 "Service Worker" 链接打开的独立 DevTools。
5. popup.js 的日志：右键扩展图标 → "检查弹出内容"。

## 已知约束 / 不要做的事

- **不要把 fetch 移到 content.js**：会被很多站点的 CSP 拦掉，且无法统一处理。
- **不要使用 `innerHTML` 注入译文**：当前用 `textContent`，保持这种做法，避免在第三方页面里引入 XSS 风险。
- **Google 免费接口随时可能失效或限流**：失败时 `worker()` 里只是 `console.warn`，不要改成抛错中断整个队列。
- **没有 MutationObserver**：动态加载的内容（无限滚动、SPA 路由切换）不会被自动翻译。如果要加，需要：(a) 去抖、(b) 复用 `data-itl-done` 标记防重、(c) 在 `removeAll()` 里把 observer 也断开。
- **MV3 Service Worker 会休眠**：不要在 background.js 里持有跨消息的全局状态，每次 `onMessage` 都要按"冷启动"假设来写。

## 文件清单

| 文件 | 角色 |
|------|------|
| `manifest.json` | MV3 配置 |
| `background.js` | Service Worker，唯一的 fetch 入口 |
| `content.js` | DOM 遍历、并发调度、译文插入/清理 |
| `content.css` | `.itl-translation` 译文块样式 |
| `popup.html` | 弹窗 UI（含内联样式） |
| `popup.js` | 弹窗交互、`chrome.storage.sync` 持久化 |
| `README.md` | 面向用户的安装与使用说明 |
