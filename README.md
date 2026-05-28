# 沉浸式翻译 Lite

一个双语对照的 Chrome 翻译插件：原文在上，译文在下，使用 Google 免费翻译接口。

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
- **译文样式** —— 默认（蓝色虚线）/ 下划线 / 模糊（悬停显示）/ 加粗 / 卡片
- **悬停翻译** —— 选 `Alt` / `Ctrl` / `Shift`，按住对应键 + 鼠标悬停在段落上即可单段翻译，无需开启整页翻译。选「关闭」彻底拆除监听。
- **自动翻译动态加载的内容** —— 默认开启，监听 SPA / 无限滚动新增的段落自动翻译。Twitter/Reddit 等高频更新页面如果触发限流可在此关闭。

## 文件说明

- `manifest.json` —— 扩展配置（Manifest V3）
- `background.js` —— 后台 Service Worker，唯一的翻译 fetch 入口，转发快捷键
- `providers/` —— 翻译服务实现（当前只有 `google.js`，预留多源扩展口）
- `content.js` —— 注入网页：遍历段落 / 并发调度 / 译文插入 / MutationObserver / 悬停翻译
- `content.css` —— 译文块样式与样式预设
- `popup.html` / `popup.js` —— 弹窗界面与交互

## 注意事项

- 用的是 `translate.googleapis.com` 的**非官方免费接口**，可能限流或随时失效，仅适合个人学习使用。
- 正式 / 商用建议改成 Google Cloud Translation API（需 API Key 和计费），新增 `providers/google-official.js` 并在 `providers/index.js` 注册即可。
- 接入其他翻译服务（DeepL / OpenAI 兼容端点 / Ollama 等）只需在 `providers/` 下新增一个文件，实现同名 `translate(text, targetLang)`，不必改 `background.js`。
