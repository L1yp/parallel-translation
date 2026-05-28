// background.js —— 后台 Service Worker（ES module）
// 职责：唯一的翻译 fetch 入口 + 快捷键转发。
// 内容脚本通过 chrome.runtime.sendMessage({type:"translate"}) 委托翻译，
// 这样能绕过部分页面 CSP/CORS 限制，并集中处理网络请求。

import { translate, DEFAULT_PROVIDER } from "./providers/index.js";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "translate") {
    translate(msg.provider || DEFAULT_PROVIDER, msg.text, msg.targetLang)
      .then((translated) => sendResponse({ ok: true, translated }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // 异步响应，必须返回 true
  }
});

// 快捷键：转发给当前 tab 的 content.js 切换翻译。
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-translate") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  const prefs = await chrome.storage.sync.get([
    "targetLang",
    "style",
    "observerEnabled",
    "hoverKey",
    "provider",
  ]);
  chrome.tabs.sendMessage(tab.id, { type: "toggle", ...prefs }, () => {
    // 内容脚本未注入（例如安装前已打开的页面）—— 静默忽略
    void chrome.runtime.lastError;
  });
});
