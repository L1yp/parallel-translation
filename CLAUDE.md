# CLAUDE.md

本文件为 Claude Code 在本仓库中工作时的项目级指引。

## 项目概览

**沉浸式翻译 Lite** —— 一个 Chrome 扩展（Manifest V3），实现"原文在上、译文在下"的双语对照网页翻译。后端走 `translate.googleapis.com` 的非官方免费接口，仅供个人学习使用。

## 架构

三段式 Chrome 扩展架构，按 MV3 的消息边界分离职责：

- **`manifest.json`** —— MV3 配置。声明权限（`activeTab` / `scripting` / `storage`）、host 权限（仅 `translate.googleapis.com`）、后台 Service Worker（`type: "module"`）、`<all_urls>` 上的内容脚本注入（`document_idle`）、`commands`（`Alt+T` 切换整页翻译）。
- **`background.js`** —— Service Worker（ES module）。**唯一发起翻译 fetch 的地方**，内容脚本通过 `chrome.runtime.sendMessage({type: "translate"})` 委托过来。这样做的目的：绕过部分页面的 CORS 限制，并集中处理网络请求。响应必须 `return true` 以走异步 `sendResponse`。也监听 `chrome.commands.onCommand`，把快捷键转成 `toggle` 消息发给当前 tab。
- **`providers/`** —— 翻译服务实现。`providers/index.js` 提供 `translate(name, text, targetLang, config)` 路由，返回 `{text}`。当前两个 provider：`google.js`（免费）和 `microsoft.js`（Azure Translator）。**敏感配置（API Key 等）由 background 从 `chrome.storage.sync` 读取后注入 provider，永远不进 content.js 上下文**。新增源（DeepL、OpenAI 兼容端点等）只需在此目录加文件并注册到 `PROVIDERS`，不动 `background.js` 主流程。
- **`content.js`** —— 注入到每个页面的核心逻辑。负责 DOM 遍历、可见性过滤、并发调度、译文插入与清理、`MutationObserver` 监听动态内容、悬停翻译、输入框三击空格翻译、划词翻译气泡。**所有 DOM 操作都集中在这里**，不要把 DOM 逻辑下沉到 background。
- **`popup.html` / `popup.js`** —— 工具栏弹窗。用户交互：选语言、选译文样式、选悬停修饰键、选输入框翻译触发方式、开关 observer；持久化到 `chrome.storage.sync`，并通过 `{type: "toggle"}` 把当前偏好一并发给 content.js。

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

`isOn` 是页面级状态。`turnOff()` 通过移除 `.itl-translation` 节点 + 清掉 `data-itl-done` 属性来还原页面，**没有保存原始 DOM 快照**。因此：

- 不要把译文 **替换** 进原文节点 —— 必须作为新的子节点 append（当前实现已经是这样）。
- 增加新功能时，任何对原始 DOM 的修改都需要在 `turnOff()` 里有对应的逆操作。

## 动态内容（MutationObserver）

`startObserver()` / `stopObserver()` 在 `turnOn()` / `turnOff()` 之间配对调用。要点：

- **300ms 去抖**：Twitter/Reddit 之类高频 mutate 的页面如果不去抖会反复打 Google 接口触发限流。我们自己 append 的 `.itl-translation` 也会触发 mutation，去抖能合并这种回声。
- **`PROCESSED` 标记 + 立即 setAttribute**：worker 从 queue 取出元素后**先**打标再 await，避免在 await 期间 observer 把同一节点二次入队。
- **默认开**：用户可在 popup 关闭。`chrome.storage.onChanged` 监听 `observerEnabled` 切换，热更新无需 toggle。

## 悬停翻译

`onMouseMove` 全局监听（capture 阶段），`hoverKey` ∈ `{alt, ctrl, shift, off}`，`off` 时彻底拆掉 listener。命中流程：`elementFromPoint` → `closest(BLOCK_SELECTOR)` → `isLeafBlock` → 复用 `translateRemote`。悬停翻译过的节点也会被打上 `PROCESSED`，因此后续整页翻译不会重复处理。

## 输入框翻译（三击空格）

`inputTranslate` ∈ `{off, space3}`，默认 `off`（会改变原生输入行为，opt-in 更安全）。开启后：document 级 `keydown`（capture）监听，连按 3 次空格（间隔 ≤ 700ms）触发；第 3 次按键 `preventDefault()` 拦掉，前两个已落键的空格在取文本时用 `replace(/ {1,2}$/, "")` 剥掉。

支持的元素：

- `<textarea>`、`<input>`（type ∈ `text/search/email/url/tel`）：使用 `HTMLInputElement.prototype` / `HTMLTextAreaElement.prototype` 上的原生 `value` setter 写回，并 dispatch `input` 事件 —— 否则 React / Vue 等框架因虚拟 DOM 短路检测不到值变化。
- `contenteditable`（ChatGPT 输入框等）：`textContent` 替换 + dispatch `input` + caret 移到末尾。仅纯文本，会丢弃富文本格式（已知限制）。

**IME 守卫**：`e.isComposing || keyCode === 229` 时立即跳过 —— 中文/日文拼音输入法用空格选词，绝不能拦截，否则用户输入第一个汉字就会触发翻译。

提示气泡 `.itl-input-tip` append 到 `document.body`，`position: fixed` + 极高 z-index，遵循"翻译中 → 已替换/失败"三态。气泡不计入 `data-itl-done` 体系，`turnOff()` 也不清理（短暂浮层，自带 setTimeout 移除）。

## 划词翻译气泡

`selectionTranslate` ∈ `{off, button, auto}`，默认 `off`。开启后 document 级 `mousedown` / `mouseup` / `keydown`（capture）监听：

- **mouseup 后 setTimeout(0)**：等浏览器把 selection 落定再 `readSelection`；少于 2 个字符不弹。
- **mousedown 先清气泡**：开始新选择 / 点击空白都会拆掉旧浮层；点中浮层自身（`closest(".itl-selection-bubble")`）则保留。
- **Shadow DOM**：先遍历 `e.composedPath()` 上的 `ShadowRoot.getSelection()`（GitHub 评论框、Web Components 输入区），fallback 才是 `window.getSelection()`。
- **定位**：`getRangeAt(0).getBoundingClientRect()`，默认放在选区上方，上方放不下转到下方；`offsetWidth/Height` 实测后做视口边缘 clamp。空 rect（编辑器边缘）时回退到鼠标坐标。
- **两种模式**：`button` 先弹一个蓝色"翻译"按钮，点击后再请求；`auto` 直接走"翻译中… → 译文/失败"。失败浮层不自动消失，让用户看清错误信息（按 Esc 或点击空白处关）。

浮层 `.itl-selection-bubble` 同样 append 到 `document.body`，`position: fixed` + 极高 z-index + `user-select: none`，不进 `data-itl-done` 体系。

## 译文样式预设

`content.css` 内置 5 种：`default` / `underline` / `blur` / `bold` / `card`。`style` 字段存 storage，content.js 在插入 `.itl-translation` 时挂 `.itl-style-xxx`。切换样式时 `refreshExistingStyles()` 会更新已插入的节点，无需还原重译。

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
- **MV3 Service Worker 会休眠**：不要在 background.js 里持有跨消息的全局状态，每次 `onMessage` 都要按"冷启动"假设来写。
- **不要把样式预设的 class 加到原文 `el` 上**：`.itl-style-xxx` 只挂在 `.itl-translation` 子节点上；挂到原文节点会污染原网页样式且 `turnOff()` 不会清。
- **新增 provider 时不要在 content.js 里加分支**：路由集中在 `providers/index.js`。content.js 只透传 `provider` 字符串。
- **API Key 永远不进 content.js**：popup 写入 `chrome.storage.sync`，background 在 `handleTranslate` 里读取后传入 provider。content.js 不应感知任何凭证字段。
- **provider 接口签名**：`translate(text, targetLang, config?) -> {text}`。必须返回对象，不要返回字符串。

## 文件清单

| 文件 | 角色 |
|------|------|
| `manifest.json` | MV3 配置（含 `commands` 快捷键、`type: "module"`） |
| `background.js` | Service Worker（ES module），翻译 fetch 入口 + 快捷键转发 |
| `providers/index.js` | provider 路由表（返回 `{text}`） |
| `providers/google.js` | Google 免费翻译实现 |
| `providers/microsoft.js` | Microsoft Translator（Azure） |
| `content.js` | DOM 遍历、并发调度、译文插入/清理、MutationObserver、悬停翻译、输入框三击空格翻译、划词翻译气泡 |
| `content.css` | `.itl-translation` 译文块样式 + 5 种样式预设 |
| `popup.html` | 弹窗 UI（含内联样式） |
| `popup.js` | 弹窗交互、`chrome.storage.sync` 持久化 |
| `README.md` | 面向用户的安装与使用说明 |
| `docs/roadmap.md` | 开发路线图（功能调研 + P0/P1/P2 优先级） |
