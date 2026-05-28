# 沉浸式翻译 Lite

一个双语对照的 Chrome 翻译插件：原文在上，译文在下，使用 Google 免费翻译接口。

## 安装（加载未打包扩展）

1. 打开 Chrome，地址栏访问 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本文件夹 `immersive-translate-lite`
4. 安装后，**刷新**你想翻译的网页（安装前已打开的页面不会自动注入脚本）

## 使用

点击工具栏的插件图标 → 选择目标语言 → 点「翻译 / 还原」。
再次点击即可移除译文、还原页面。

## 文件说明

- `manifest.json` —— 扩展配置（Manifest V3）
- `background.js` —— 后台 Service Worker，负责请求翻译接口
- `content.js` —— 注入网页，遍历段落、调用翻译、插入译文
- `content.css` —— 译文块样式
- `popup.html` / `popup.js` —— 弹窗界面与交互

## 注意事项

- 用的是 `translate.googleapis.com` 的**非官方免费接口**，可能限流或随时失效，仅适合个人学习使用。
- 正式 / 商用建议改成 Google Cloud Translation API（需 API Key 和计费），把 `background.js` 里的请求换成官方端点即可。
- 当前按「块级元素」整段翻译。如果想要鼠标悬停才翻译、或翻译动态加载内容（无限滚动），需要再加 `MutationObserver` 监听。
