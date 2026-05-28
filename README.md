# 沉浸式翻译 Lite

一个双语对照的 Chrome 翻译插件：原文在上，译文在下。支持 Google（免费）和 Microsoft Translator（带词对齐高亮）。

## 安装（加载未打包扩展）

1. 打开 Chrome，地址栏访问 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本文件夹 `immersive-translate-lite`
4. 安装后，**刷新**你想翻译的网页（安装前已打开的页面不会自动注入脚本）

## 使用

点击工具栏的插件图标 → 选择目标语言 → 点「翻译 / 还原」。再次点击即可移除译文、还原页面。

### 快捷键

- `Alt+T` 切换整页翻译（可在 `chrome://extensions/shortcuts` 自定义）

### 弹窗里的设置

- **目标语言** —— 中/英/日/韩/法/德/西 等
- **翻译服务**
  - **Google**（默认）：免费、无需配置，但**不支持词对齐高亮**
  - **Microsoft**：注册 Azure Translator 免费层（F0，每月 2M 字符），填 Key + Region，翻译时返回字符级对齐，**鼠标悬停原文/译文中的词会联动高亮另一侧的对应词**
- **译文样式** —— 默认（蓝色虚线）/ 下划线 / 模糊（悬停显示）/ 加粗 / 卡片
- **悬停翻译** —— 选 `Alt` / `Ctrl` / `Shift`，按住对应键 + 鼠标悬停在段落上即可单段翻译。选「关闭」彻底拆除监听。
- **自动翻译动态加载的内容** —— 默认开启，监听 SPA / 无限滚动新增的段落。Twitter/Reddit 触发限流可关。

### 注册 Microsoft Translator（可选，启用对齐高亮）

1. 去 https://portal.azure.com 注册 Azure 账号（需信用卡验证，免费层不扣费）
2. 直接打开 https://portal.azure.com/#create/Microsoft.CognitiveServicesTextTranslation
3. 区域选 **East Asia**（国内访问最快），定价层选 **Free F0**
4. 创建完成后进资源页 → 左侧"密钥和终结点" → 复制 Key 和 Region
5. 在本扩展 popup 选「Microsoft」，填入 Key 和 Region，点"测试连接"验证

### 词对齐高亮的限制

- 仅 Microsoft provider 支持
- 含内嵌格式（`<strong>`/`<a>` 等）的段落，**只在译文侧切 span**，原文不动 DOM；纯文本段落则双向都切。
- Microsoft 返回的是机器翻译的对齐，对长句、意译、惯用语的对齐质量会下降。

## 文件说明

- `manifest.json` —— 扩展配置（Manifest V3）
- `background.js` —— 后台 Service Worker，唯一的翻译 fetch 入口，转发快捷键，注入敏感配置
- `providers/` —— 翻译服务实现（`google.js` / `microsoft.js`）+ 路由
- `content.js` —— 注入网页：遍历段落 / 并发调度 / 译文插入 / MutationObserver / 悬停翻译 / 词对齐高亮
- `content.css` —— 译文块样式与样式预设 + token 高亮
- `popup.html` / `popup.js` —— 弹窗界面与交互

## 隐私 / 安全

- Microsoft API Key 存在 `chrome.storage.sync`（随 Chrome 账号同步），**不会出现在网页上下文**（只有 background.js 读取）
- 翻译请求只发往你选的服务商（`translate.googleapis.com` 或 `api.cognitive.microsofttranslator.com`），扩展不收集、不上传任何额外数据
- 如担心 `storage.sync` 跨设备同步 Key，可改用 `storage.local`（需要改一行 `popup.js` / `background.js`）

## 注意事项

- Google 走的是 `translate.googleapis.com` 的**非官方免费接口**，可能限流或随时失效，仅适合个人学习使用。
- 接入其他翻译服务（DeepL / OpenAI 兼容端点 / Ollama 等）只需在 `providers/` 下新增一个文件，实现 `translate(text, targetLang, config) -> {text, alignment?}`，并在 `providers/index.js` 注册。
