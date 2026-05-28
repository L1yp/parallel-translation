# CLAUDE.md

本文件为 Claude Code 在本仓库中工作时的项目级指引。

## 项目概览

**沉浸式翻译 Lite** —— 一个 Chrome 扩展（Manifest V3），实现"原文在上、译文在下"的双语对照网页翻译。后端走 `translate.googleapis.com` 的非官方免费接口，仅供个人学习使用。

## 架构

三段式 Chrome 扩展架构，按 MV3 的消息边界分离职责：

- **`manifest.json`** —— MV3 配置。声明权限（`activeTab` / `scripting` / `storage`）、host 权限（仅 `translate.googleapis.com`）、后台 Service Worker（`type: "module"`）、`<all_urls>` 上的内容脚本注入（`document_idle`）、`commands`（`Alt+T` 切换整页翻译）。
- **`background.js`** —— Service Worker（ES module）。**唯一发起翻译 fetch 的地方**，内容脚本通过 `chrome.runtime.sendMessage({type: "translate"})` 委托过来。这样做的目的：绕过部分页面的 CORS 限制，并集中处理网络请求。响应必须 `return true` 以走异步 `sendResponse`。也监听 `chrome.commands.onCommand`，把快捷键转成 `toggle` 消息发给当前 tab。
- **`cache.js`** —— Service Worker 内的 IndexedDB 翻译缓存层。`handleTranslate` 入口先 `cacheGet` 命中直接返回，未命中走 provider，成功 `cacheSet`。key = `sha1(provider + text + targetLang + sourceLang + wantDict)`，TTL 7 天，容量上限 5000 条，超出按 createdAt 升序淘汰。冷启动懒触发一次 cleanup（`maybeCleanupCache`，标志位防重）。缓存命中对所有 caller（页面/悬停/输入框/划词）透明，无需改 content 侧。**任何 IDB 错误都吞掉**，缓存层永远不能阻断翻译主流程。同时暴露 `cacheStats` / `cacheClearAll` / `cleanupCache` 给设置页缓存管理面板使用，对应 background 的 `cache-stats` / `cache-cleanup` / `cache-clear` 三条消息。
- **`providers/`** —— 翻译服务实现。`providers/index.js` 提供 `translate(name, text, targetLang, config)` 路由，返回 `{text}`。当前两个 provider：`google.js`（免费）和 `microsoft.js`（Azure Translator）。**敏感配置（API Key 等）由 background 从 `chrome.storage.sync` 读取后注入 provider，永远不进 content.js 上下文**。新增源（DeepL、OpenAI 兼容端点等）只需在此目录加文件并注册到 `PROVIDERS`，不动 `background.js` 主流程。
- **`content.js`** —— 注入到每个页面的核心逻辑。负责 DOM 遍历、可见性过滤、并发调度、译文插入与清理、`MutationObserver` 监听动态内容、悬停翻译、输入框三击空格翻译、划词翻译气泡。**所有 DOM 操作都集中在这里**，不要把 DOM 逻辑下沉到 background。
- **`popup.html` / `popup.js`** —— 工具栏弹窗。用户交互：选语言、选译文样式、选悬停修饰键、选输入框翻译触发方式、开关 observer；持久化到 `chrome.storage.sync`，并通过 `{type: "toggle"}` 把当前偏好一并发给 content.js。配置按"基础翻译 / 悬停翻译 / 划词翻译 / 输入框翻译"四组（`.group` + `.group-title`）聚合，便于视觉扫描。
- **`options.html` / `options.js`** —— 独立设置页（`options_ui`，open_in_tab）。**镜像 popup 的全部偏好**（同步走 `chrome.storage.onChanged`，两边任一改动另一边立刻反映），按 4 组 card 分类排版，同时承载凭证（Microsoft / 有道）和**缓存管理**面板（条目数 / 最旧最新时间 / 刷新统计 / 清理过期 / 清空全部）。缓存操作走 `chrome.runtime.sendMessage` 委托给 background，不在设置页直开 IndexedDB，保持"IDB 持有者只有一个"。

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

**目标语言独立于页面翻译**：用单独的 `inputTargetLang` 字段（默认 `en`），不复用 `targetLang`。因为页面翻译是「外文 → 我读的语言」（zh-CN），输入框翻译方向相反：用户用熟悉的语言输入、想翻成不熟悉的语言发出去。

**源语言也单独配置**：`inputSourceLang` 字段（默认 `"auto"`）。auto 让 provider 自行识别；某些短句、人名、混合语言场景下自动检测会失败，让用户显式锁定源语言（比如固定 zh-CN → en），翻译质量更稳。

provider 接口里 `options.sourceLang` 走完整链路：

- Google：拼到 URL 的 `sl=` 参数（原本硬编码 `sl=auto`）
- Microsoft：`sourceLang === "auto"` 时省略 `from` 参数让 Azure 自动检测，否则 `from=mapLang(sourceLang)`
- Youdao：`from=auto` 或 `from=mapLang(sourceLang)`

`translateRemote(text, opts?)` 现在收 options 对象：`{ targetLang?, sourceLang?, wantDict? }`。原来的位置参数已淘汰，新增 caller 请走 opts。

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

### 单词词典模式

选区命中 `isSingleWord`（无空格、长度 ≤ 30、至少含一个字母 / CJK）时，`translateRemote` 带 `wantDict: true` 调 background；命中后浮层切到 `.itl-selection-dict` 视图，渲染 headword / 音标 / 词性释义 / 释义 / 网络释义 / 例句若干区块。**全程 `textContent` 逐节点 append**，永远不要为这部分引入 `innerHTML`。

各 provider 能力差异（不要凭空补齐缺失字段，让 UI 自行降级）：

| provider | phonetics | explains | definitions | webExplains | examples | audio |
|---|---|---|---|---|---|---|
| youdao   | ✅ 英/美 IPA（isWord=true 走 v3，否则 fallback 网页 #ec/#ce） | ✅ basic.explains 或 网页 fallback | — | ✅ web[] | — | ✅ 复用 Google `translate_tts`（有道自带的 speakUrl 在 `<audio>` 常播不出，已弃用） |
| google   | — | ✅ 解析 `data[1]`（dt=bd） | ✅ 解析 `data[12]`（dt=md） | — | ✅ 解析 `data[13]`（dt=ex，需 `stripHtml`） | ✅ 自拼 `translate_tts` URL（用 `data[2]` 检测到的源语言） |
| microsoft | — | — | — | — | — | — |

Google `dt=bd/md/ex` 只在 `wantDict` 时附加，避免长句翻译响应体翻倍。

有道 `basic` / `web` 仅在 API 判 `isWord=true` 时存在（连 `become` 这种动词原型也可能被判 false）。**audio 不复用有道 `speakUrl` / `tSpeakUrl`**——它们在 `<audio>` 里常播不出（mime / 鉴权 / 跨域综合作用），改为在 youdao provider 里自拼 Google `translate_tts` URL，把内部 `zh-CHS` / `zh-CHT` 映射回 `zh-CN` / `zh-TW`。即便 basic 缺失，只要有 audio 也能让 UI 渲染 headword + 播放按钮 + 译文。

**网页词典 fallback**：v3 API 没返回 basic 时（`wantDict && !data.basic`），youdao provider 额外 fetch `data.webdict.url`（http→https），用正则切出 `<div id="ec">`（英→中）或 `<div id="ce">`（中→英）那一段，提取音标、释义、词形变化（v3 API 没有，只在网页里）。Service Worker 没 DOMParser，所以用正则；先字符串切块缩小范围（找 `_contentWrp"` 边界）再小范围正则，避免被页面其它 div 干扰。有 basic 的快路径不动，避免每次都多一次 HTTP。`manifest.host_permissions` 必须包含 `m.youdao.com` 和 `mobile.youdao.com`。

**有道 `from=auto` 不触发词典通路**：调 `/api` 时 from=auto 通常只返回 `translation` 不带 basic/web；wantDict 命中时按 `/\p{Script=Han}/u` 与 `/^[A-Za-z][A-Za-z'\-]+$/` 启发式锁 from 为 `zh-CHS` / `en`，调用方无感知。

**音频播放走 background 代理**：Google `translate_tts` 拒绝带第三方页面 Referer 的请求（用户在 github.com 选词触发时浏览器自动带 referer=github，被 Google 当爬虫挡了）；`<audio>` 元素又没有 `referrerPolicy` 属性可以控制。所以 content.js `playAudio` 发 `{type: "audio", url}` 给 background，background fetch 时 `referrerPolicy: "no-referrer"` 拿到音频字节，转 base64 data URL 回传，content.js 用 `new Audio(dataUrl).play()` 本地解码。这一并绕过页面 CSP `media-src` 限制。失败时 fallback 直接 `new Audio(url)` 试一次。manifest 的 host_permissions 必须包含 TTS 域：`translate.googleapis.com` / `openapi.youdao.com`。

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
- **provider 接口签名**：`translate(text, targetLang, config?, options?) -> {text, dict?}`。必须返回对象。`options.wantDict` 为 `true` 时尽量返回 `dict`（音标 / 词性释义 / 例句 / 网络释义），不支持就不带这个字段，content.js 会降级为纯译文。`options.sourceLang` 为 `"auto"` 或省略时由 provider 自动检测，否则显式指定源语言代码（如 `"zh-CN"`），各 provider 自行映射成底层 API 格式。

## 文件清单

| 文件 | 角色 |
|------|------|
| `manifest.json` | MV3 配置（含 `commands` 快捷键、`type: "module"`） |
| `background.js` | Service Worker（ES module），翻译 fetch 入口 + 快捷键转发 + 音频代理 |
| `cache.js` | IndexedDB 翻译缓存（sha1 key、TTL 7 天、容量 5000） |
| `providers/index.js` | provider 路由表（返回 `{text}`） |
| `providers/google.js` | Google 免费翻译实现 |
| `providers/microsoft.js` | Microsoft Translator（Azure） |
| `content.js` | DOM 遍历、并发调度、译文插入/清理、MutationObserver、悬停翻译、输入框三击空格翻译、划词翻译气泡 |
| `content.css` | `.itl-translation` 译文块样式 + 5 种样式预设 |
| `popup.html` | 弹窗 UI（含内联样式），按"基础/悬停/划词/输入框"四组聚合 |
| `popup.js` | 弹窗交互、`chrome.storage.sync` 持久化、监听 storage.onChanged 同步反映 options 改动 |
| `options.html` | 设置页 UI：偏好镜像（4 组 card）+ 凭证 + 缓存管理面板 |
| `options.js` | 设置页交互：偏好/凭证双向绑定、缓存统计/清理/清空走 `cache-*` 消息 |
| `README.md` | 面向用户的安装与使用说明 |
| `docs/roadmap.md` | 开发路线图（功能调研 + P0/P1/P2 优先级） |
