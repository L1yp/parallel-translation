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
  if (msg.type === "audio") {
    fetchAudioAsDataUrl(msg.url)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
});

// 由 content.js 委托 fetch 发音 URL：
// - Google translate_tts 拒绝带 Referer 的第三方页面请求（用户从 github.com 触发时 referer=github）
// - 转成 data URL 让浏览器本地解码，绕开所有 origin / Referer / 页面 CSP media-src 限制
async function fetchAudioAsDataUrl(url) {
  const res = await fetch(url, { referrerPolicy: "no-referrer", credentials: "omit" });
  if (!res.ok) throw new Error("audio HTTP " + res.status);
  const buf = await res.arrayBuffer();
  if (!buf.byteLength) throw new Error("audio empty body");
  // ArrayBuffer → base64（分块避免 String.fromCharCode 参数过多）
  const u8 = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  const mime = res.headers.get("Content-Type") || "audio/mpeg";
  return "data:" + mime + ";base64," + btoa(bin);
}

async function handleTranslate(msg) {
  const provider = msg.provider || DEFAULT_PROVIDER;
  const config = await loadProviderConfig(provider);
  const options = {
    wantDict: !!msg.wantDict,
    // "auto" 让 provider 自行检测；其它值会显式传给底层 API
    sourceLang: msg.sourceLang || "auto",
  };
  const result = await translate(provider, msg.text, msg.targetLang, config, options);
  return { translated: result.text || "", dict: result.dict || null };
}

async function loadProviderConfig(provider) {
  if (provider === "microsoft") {
    const s = await chrome.storage.sync.get(["msKey", "msRegion", "msEndpoint"]);
    return { key: s.msKey || "", region: s.msRegion || "eastasia", endpoint: s.msEndpoint || "" };
  }
  if (provider === "youdao") {
    const s = await chrome.storage.sync.get(["ydAppKey", "ydAppSecret"]);
    return { appKey: s.ydAppKey || "", appSecret: s.ydAppSecret || "" };
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
    "inputTranslate",
    "inputSourceLang",
    "inputTargetLang",
    "selectionTranslate",
    "provider",
  ]);
  chrome.tabs.sendMessage(tab.id, { type: "toggle", ...prefs }, () => {
    // 内容脚本未注入（例如安装前已打开的页面）—— 静默忽略
    void chrome.runtime.lastError;
  });
});
