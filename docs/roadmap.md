# 对照式翻译 — 开发方向路线图（待审核）

> 调研日期：2026-05-28
> 范围：参考官方"沉浸式翻译"（immersive-translate）已实现功能 + GitHub 仓库 issue / discussions 中高频 feature request，结合本仓库 Lite 版当前能力，给出可执行的开发方向草案。
> 当前 Lite 版能力：MV3 三段式扩展、Google 免费接口、`p/li/h1-h6/blockquote/dd/dt/figcaption/td/caption` 块级元素双语对照、4 并发、popup 选语言、`isOn` 开关 + `removeAll()` 还原。**无** PDF / 视频 / 输入框 / 划词 / 悬停 / 多翻译服务 / 自定义样式 / 动态 DOM 监听。

---

## 一、官方"沉浸式翻译"功能盘点

按场景分组，标 ★ 表示与 Lite 现状差距最大、最常被用户提及的功能。

### 1. 网页翻译（与本项目最直接对标）
- **双语对照模式**：段落级"原文+译文"上下并排（Lite 已实现基础版）
- **智能识别主内容**：跳过导航/侧栏/页脚，只翻译正文
- **★ 多种双语显示样式**：下划线、虚线、模糊、加粗、彩色标记、卡片等可选主题
- **★ 站点级规则系统**：针对单个网站自定义选择器、显示样式、翻译服务、目标语言
- **★ 动态内容/SPA 支持**：MutationObserver 监听后续插入的 DOM 节点，自动翻译
- **★ 鼠标悬停翻译**：按住 Ctrl/Shift + 悬停段落即时翻译单段，不开启整页翻译
- **★ 划词翻译**：选中文本后弹出气泡显示译文
- **★ 输入框翻译**：在 input/textarea 中连按三次空格触发翻译（中→英输入辅助）
- **快捷键**：开关整页翻译、切换显示模式、翻译当前段
- **针对主流站点的深度适配**：Twitter / Reddit / YouTube / Facebook / GitHub 等
- **隐藏原文 / 仅显示译文模式**
- **翻译图片中的文字**（OCR）

### 2. PDF 翻译
- 浏览器内 PDF 双语对照
- 保留原排版（公式、表格、图片）
- 多栏排版处理
- 扫描件 OCR

### 3. EPUB / 电子书 / 文档
- EPUB、DOCX、TXT、Markdown、HTML、SRT 双语生成
- 字幕文件批量翻译（.srt / .ass）

### 4. 视频字幕翻译
- YouTube / Netflix / Prime Video / Bilibili 等 **127+ 平台**双语字幕
- 无字幕视频自动生成字幕
- 字幕样式（描边粗细、字号、位置）

### 5. 会议实时翻译
- Zoom / Google Meet / Microsoft Teams 实时双语字幕

### 6. 图片 / 漫画翻译
- 网页图片悬停翻译
- 本地图片上传翻译
- 日漫、韩漫、欧美漫画一键翻译

### 7. 翻译引擎集成（20+ 服务）
- **传统**：Google / DeepL / Bing / 腾讯 / 阿里 / 百度 / Yandex
- **AI（云端）**：OpenAI (ChatGPT) / Claude / Gemini / DeepSeek / Mistral / Grok
- **★ 本地 AI**：Ollama / 自部署 OpenAI 兼容端点
- **★ Custom API（自定义服务）**：用户实现固定 schema 的接口即可接入
- AI 专家角色（system prompt）、术语库、上下文记忆
- 混合模式：长段走 AI、短段走传统 API

### 8. 平台
- Chrome / Edge / Firefox / Safari 扩展
- iOS / Android 独立 App（含 Safari 扩展）
- 桌面 App（macOS / Windows）

### 9. Pro / 付费功能
- Pro 专用 AI 模型额度
- PDF / EPUB 文件配额提升
- 漫画翻译额度
- 优先客服 / 团队账号

---

## 二、GitHub Issue / Discussion 中的高频 Feature Request

按"热度（👍 / 评论数）+ 与 Lite 的相关性"筛选：

| 来源 issue | 主题 | 与 Lite 相关性 |
|---|---|---|
| [#1179（944 评论）](https://github.com/immersive-translate/immersive-translate/issues/1179) | 支持更多视频网站双语字幕 | 低（Lite 暂不做视频） |
| [#1809（392 评论）](https://github.com/immersive-translate/immersive-translate/issues/1809) | 支持更多漫画网站 | 低 |
| [#212（431 评论）](https://github.com/immersive-translate/immersive-translate/issues/212) | "疑难杂症网页"兼容性汇总 | **高**（Lite 也会遇到） |
| [#1451](https://github.com/immersive-translate/immersive-translate/issues/1451) | 本地 AI 模型（Ollama） | **中**（Lite 多翻译源时考虑） |
| [#293](https://github.com/immersive-translate/immersive-translate/issues/293) | 综合功能建议 | 中 |
| [#438](https://github.com/immersive-translate/immersive-translate/issues/438) | 译文背景色 / 自定义样式 / 可编辑 | **高** |
| [#526](https://github.com/immersive-translate/immersive-translate/issues/526) | 输入框翻译（搜索框、ChatGPT 等） | **高** |
| [#806](https://github.com/immersive-translate/immersive-translate/issues/806) | 自定义术语库（专业术语强制译法） | 中 |
| [#2282](https://github.com/immersive-translate/immersive-translate/issues/2282) | 双语字幕语言优先级 | 低 |
| [#2991](https://github.com/immersive-translate/immersive-translate/issues/2991) | 代理配置 | 中（Google 接口被墙时） |
| [#3160](https://github.com/immersive-translate/immersive-translate/issues/3160) | 按域名指定不同翻译服务 | 中 |
| [#1422](https://github.com/immersive-translate/immersive-translate/issues/1422) | 批量本地文件翻译 | 低 |
| [#1827](https://github.com/immersive-translate/immersive-translate/issues/1827) | 集成 Chrome 内置 Gemini Nano | **中**（无需 key 的本地 AI 入口） |
| [discussion #2098](https://github.com/immersive-translate/immersive-translate/discussions/2098) | 离线 / 本地 LLM 翻译 | 中 |
| [discussion #3076](https://github.com/immersive-translate/immersive-translate/discussions/3076) | 混合模式（传统 API + AI） | 中 |

---

## 三、给 Lite 版的开发方向（建议）

### 设计原则
Lite 版的定位是 **"够用、零依赖、单文件可读"**。不要变成官方版的 0.x 克隆。以下方向按"投入产出比"和"是否破坏现有架构"排序，分三档。

### 🟢 P0 — 高 ROI、改动局限，建议先做

1. **MutationObserver 支持动态内容**
   - 当前用户痛点最大：SPA / 无限滚动页面只翻一次首屏。
   - 做法：在 `content.js` `start()` 里启动 observer，监听 `childList`；新节点走同一 `collect()` + `queue` 路径，复用 `data-itl-done` 防重；`removeAll()` 里 `disconnect()`。
   - 风险：必须做去抖（建议 300ms），否则在频繁 mutate 的页面（如 Twitter）会狂打 Google 接口触发限流。CLAUDE.md 里已经明确点过这点，新增 observer 时务必同步更新。

2. **悬停翻译（Hover-to-translate）**
   - 仅翻译鼠标当前段落，按住 Ctrl 触发。无需开启整页翻译，零侵入。
   - 做法：document 级 mousemove + 节流；命中 `BLOCK_SELECTOR` 叶子块就走单段翻译，复用 `background.js` 的 fetch。
   - 与现有架构正交，不影响整页模式。

3. **多翻译源框架（先加 1 个：DeepL Free / 自定义 OpenAI 兼容端点）**
   - 重构 `background.js`：抽 `providers/google.js` / `providers/openai.js`，按 `chrome.storage.sync` 里的 `provider` 字段路由。
   - 不要一次性接 10 家，先把"切换框架"立起来。
   - 自定义 OpenAI 端点 = 顺带覆盖 Ollama / DeepSeek / 任何 OpenAI 兼容服务，一个 provider 顶多个。

4. **双语显示样式预设（3–5 种）**
   - `content.css` 加几个 class：`.itl-style-underline` / `.itl-style-dashed` / `.itl-style-blur` / `.itl-style-card`，popup 加 select 写入 storage，content.js 在插入 `.itl-translation` 时同时挂上 class。
   - 零架构改动，纯样式工作。issue #438 的核心诉求。

5. **快捷键开关整页翻译**
   - manifest 加 `commands`，绑定 `Alt+T` 之类，转发给当前 tab 的 content.js 切换 `isOn`。
   - 一行 manifest + 几行胶水代码。

### 🟡 P1 — 价值高但工作量大，按需做

6. **站点规则系统（按域名）**
   - storage 存 `{ "github.com": { selectors: [...], style: "card", provider: "openai", targetLang: "zh-CN" } }`。
   - popup 增加"为当前网站定制"按钮。
   - 同时可以解决 issue #212 那类"疑难杂症网页"——用户能自己加规则救火。

7. **输入框翻译（三击空格触发）**
   - content.js 监听 input/textarea 的 keyup，连续 3 次 Space 触发翻译整个 value，回填或显示气泡。
   - 注意：富文本编辑器（ChatGPT、Notion）不是真 `<input>`，处理 `contenteditable` 要单独走，复杂度比想象高。

8. **划词翻译气泡**
   - selectionchange 监听，弹一个浮层 + 译文。
   - 要处理浮层定位（视口边缘）、selection 在 Shadow DOM 内的兼容（GitHub 评论框等）。

9. **本地翻译缓存（IndexedDB）**
   - 同一段落短期内重复翻译命中缓存，省流量、扛限流。
   - 缓存 key = `sha1(originalText + targetLang + provider)`，TTL 7 天。

### 🔴 P2 — 与 Lite 定位不符 / 高复杂度，暂不建议做

- **PDF / EPUB 翻译**：需要接 PDF.js 或解 EPUB zip，本质是另一个产品。
- **视频字幕 / 会议翻译**：每个平台一套适配器，维护成本指数级。
- **OCR / 图片 / 漫画翻译**：依赖云端 OCR，成本和复杂度都高。
- **移动端 App**：跨出扩展范围。
- **Pro 付费体系 / 账号系统**：Lite 不需要。

---

## 四、近一两个月可落地的提议

按以上分析，**建议头 4 周排期**（每周一个 P0）：

1. **Week 1** — MutationObserver + 去抖（解决最大用户痛点）
2. **Week 2** — 悬停翻译模式（独立模块，不破坏现有逻辑）
3. **Week 3** — Provider 框架重构 + 接入"OpenAI 兼容自定义端点"
4. **Week 4** — 样式预设 + 快捷键 + 文档更新

之后再判断是否进入 P1（站点规则 / 输入框 / 划词 / 缓存）。

---

## 五、待用户决策的开放问题

1. Lite 版要不要彻底保持"单 provider"的简洁，还是接受 P0#3 的 provider 重构？
2. 悬停翻译用哪个修饰键？官方用 Ctrl，Mac 上 Ctrl 不常用，可能 Alt 更合适。
3. MutationObserver 默认开还是默认关？默认开会增加被限流风险，默认关大部分用户不会去开。
4. 是否接受引入轻量构建（如把 providers 拆多文件后做 bundle）？目前是"无构建"，加文件会让浏览器多次 import。
5. 设置项变多后，popup 是否拆分为"popup（开关）+ options 页（详细设置）"？

---

## 六、参考来源

- [Immersive Translate – Chrome Web Store](https://chromewebstore.google.com/detail/immersive-translate-trans/bpoadfkcbjbfhfodiogcnhhhpibjhbnh)
- [immersive-translate / immersive-translate – GitHub](https://github.com/immersive-translate/immersive-translate)
- [Issues by reactions](https://github.com/immersive-translate/immersive-translate/issues?q=is%3Aissue+label%3Aenhancement+sort%3Areactions-%2B1-desc)
- [Ideas Discussions](https://github.com/immersive-translate/immersive-translate/discussions/categories/ideas)
- [Immersive Translate 官方首页](https://immersivetranslate.com/home/)
- [Immersive Translate – 文档翻译](https://immersivetranslate.com/en/document/)
- 关键 issue：[#1179](https://github.com/immersive-translate/immersive-translate/issues/1179)、[#212](https://github.com/immersive-translate/immersive-translate/issues/212)、[#438](https://github.com/immersive-translate/immersive-translate/issues/438)、[#526](https://github.com/immersive-translate/immersive-translate/issues/526)、[#806](https://github.com/immersive-translate/immersive-translate/issues/806)、[#1451](https://github.com/immersive-translate/immersive-translate/issues/1451)、[#3160](https://github.com/immersive-translate/immersive-translate/issues/3160)
