# 沉浸式翻译 Lite

一个双语对照的 Chrome 翻译插件：原文在上，译文在下。支持 Google（免费）、Microsoft Translator 和有道智云。

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
  - **Google**（默认）：免费、无需配置
  - **Microsoft**：注册 Azure Translator 免费层（F0，每月 2M 字符），填 Key + Region 即可使用
  - **有道智云**：注册有道智云开发者账号，新用户赠送约 500 万字符额度，填 App Key + App Secret 即可使用

> Microsoft / 有道的 Key 等敏感配置在独立的设置页填写：popup 右下角点 `⚙ 设置`，或右键扩展图标 → 选项。
- **译文样式** —— 默认（蓝色虚线）/ 下划线 / 模糊（悬停显示）/ 加粗 / 卡片
- **悬停翻译** —— 选 `Alt` / `Ctrl` / `Shift`，按住对应键 + 鼠标悬停在段落上即可单段翻译。选「关闭」彻底拆除监听。
- **输入框翻译** —— 选「连按 3 次空格触发」后，在 `input` / `textarea` / `contenteditable`（如 ChatGPT 输入框）里连按 3 个空格即可把当前内容翻译成目标语言并回填。中文/日文 IME 拼音选词的空格不会被拦截。默认关闭（避免改变原生输入行为）。
- **划词翻译** —— 选「选中后显示翻译按钮」时，鼠标选中文本松开后会出现一个小按钮，点击展开译文；选「选中即自动翻译」则直接弹出译文气泡。点击空白处或按 `Esc` 关闭。默认关闭。
- **自动翻译动态加载的内容** —— 默认开启，监听 SPA / 无限滚动新增的段落。Twitter/Reddit 触发限流可关。

### 注册 Microsoft Translator（可选）

1. 去 https://portal.azure.com 注册 Azure 账号（需信用卡验证，免费层不扣费）
2. 直接打开 https://portal.azure.com/#create/Microsoft.CognitiveServicesTextTranslation
3. 区域选 **East Asia**（国内访问最快），定价层选 **Free F0**
4. 创建完成后进资源页 → 左侧"密钥和终结点" → 复制 Key 和 Region
5. 在扩展设置页选择「Microsoft」对应的卡片，填入 Key 和 Region，点"测试连接"验证

### 注册有道智云（可选）

1. 去 https://ai.youdao.com/ 注册账号并完成实名认证
2. 进入控制台 → 「自然语言翻译」→「文本翻译」→「创建应用」
3. 应用接入方式选 **API**，授权服务勾选「文本翻译服务」
4. 创建后在应用详情里复制 **应用 ID（App Key）** 和 **应用密钥（App Secret）**
5. 在扩展设置页找到「有道智云翻译」卡片，填入并点"测试连接"验证

## 文件说明

- `manifest.json` —— 扩展配置（Manifest V3）
- `background.js` —— 后台 Service Worker，唯一的翻译 fetch 入口，转发快捷键，注入敏感配置
- `providers/` —— 翻译服务实现（`google.js` / `microsoft.js` / `youdao.js`）+ 路由
- `options.html` / `options.js` —— 独立设置页（API Key 等敏感配置）
- `content.js` —— 注入网页：遍历段落 / 并发调度 / 译文插入 / MutationObserver / 悬停翻译 / 输入框三击空格翻译 / 划词翻译气泡
- `content.css` —— 译文块样式与样式预设
- `popup.html` / `popup.js` —— 弹窗界面与交互

## 隐私 / 安全

- Microsoft / 有道的 API Key 与密钥存在 `chrome.storage.sync`（随 Chrome 账号同步），**不会出现在网页上下文**（只有 background.js 读取）
- 翻译请求只发往你选的服务商（`translate.googleapis.com` / `api.cognitive.microsofttranslator.com` / `openapi.youdao.com`），扩展不收集、不上传任何额外数据
- 如担心 `storage.sync` 跨设备同步 Key，可改用 `storage.local`（需要改一行 `popup.js` / `background.js`）

## 注意事项

- Google 走的是 `translate.googleapis.com` 的**非官方免费接口**，可能限流或随时失效，仅适合个人学习使用。
- 接入其他翻译服务（DeepL / OpenAI 兼容端点 / Ollama 等）只需在 `providers/` 下新增一个文件，实现 `translate(text, targetLang, config) -> {text}`，并在 `providers/index.js` 注册。
