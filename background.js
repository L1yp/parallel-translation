// background.js —— 后台 Service Worker（ES module）
// 职责：唯一的翻译 fetch 入口 + 快捷键转发 + 敏感配置（API Key）注入。
// content.js 只传 provider 名 + 文本 + 目标语言；Key 等敏感信息由 background 从 storage 读取，
// 永远不进入页面上下文，避免被网页脚本嗅探。

import { translate, DEFAULT_PROVIDER } from "./providers/index.js";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "translate") {
    handleTranslate(msg)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true; // 异步响应，必须返回 true
  }
});

async function handleTranslate(msg) {
  const provider = msg.provider || DEFAULT_PROVIDER;
  const config = await loadProviderConfig(provider);
  const result = await translate(provider, msg.text, msg.targetLang, config);
  return { translated: result.text || "" };
}

async function loadProviderConfig(provider) {
  if (provider === "microsoft") {
    const s = await chrome.storage.sync.get(["msKey", "msRegion", "msEndpoint"]);
    return { key: s.msKey || "", region: s.msRegion || "eastasia", endpoint: s.msEndpoint || "" };
  }
  return null;
}

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
