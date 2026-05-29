// background.js —— 后台 Service Worker（ES module）
// 职责：唯一的翻译 fetch 入口 + 快捷键转发 + 敏感配置（API Key）注入。
// content.js 只传 provider 名 + 文本 + 目标语言；Key 等敏感信息由 background 从 storage 读取，
// 永远不进入页面上下文，避免被网页脚本嗅探。

import { translate, DEFAULT_PROVIDER } from "./providers/index.js";
import {
  makeCacheKey,
  cacheGet,
  cacheSet,
  maybeCleanupCache,
  cleanupCache,
  cacheStats,
  cacheClearAll,
} from "./cache.js";
import {
  normalizeWord,
  vocabAdd,
  vocabRemove,
  vocabRemoveByWord,
  vocabCheck,
  vocabList,
  vocabUpdateNote,
  vocabUpdateContext,
  vocabClearAll,
  vocabExportAll,
  vocabImport,
  vocabStats,
} from "./vocab.js";

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
  if (msg.type === "cache-stats") {
    cacheStats()
      .then((s) => sendResponse({ ok: true, ...s }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === "cache-cleanup") {
    cleanupCache()
      .then(() => cacheStats())
      .then((s) => sendResponse({ ok: true, ...s }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === "cache-clear") {
    cacheClearAll()
      .then(() => sendResponse({ ok: true, count: 0, oldestAt: null, newestAt: null }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  // —— 生词本（vocab.js）————————————————————————————————
  if (msg.type === "vocab-add") {
    vocabAdd(msg.payload || {})
      .then((r) => sendResponse({ ok: true, added: r.added, id: r.id, item: r.item }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === "vocab-remove") {
    vocabRemove(msg.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === "vocab-remove-by-word") {
    vocabRemoveByWord(normalizeWord(msg.normalized || msg.word || ""), msg.targetLang || "")
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === "vocab-check") {
    vocabCheck(normalizeWord(msg.normalized || msg.word || ""), msg.targetLang || "")
      .then((r) => sendResponse({ ok: true, exists: r.exists, id: r.id || null }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === "vocab-list") {
    vocabList(msg.filter || {})
      .then((r) => sendResponse({ ok: true, items: r.items, total: r.total }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === "vocab-update-note") {
    vocabUpdateNote(msg.id, msg.note || "")
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === "vocab-update-context") {
    vocabUpdateContext(msg.id, msg.context || "")
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === "vocab-clear-all") {
    vocabClearAll()
      .then((cleared) => sendResponse({ ok: true, cleared }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === "vocab-export") {
    vocabExportAll()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === "vocab-import") {
    vocabImport(msg.data || {}, msg.mode || "merge")
      .then((r) => sendResponse({ ok: true, added: r.added, skipped: r.skipped }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === "vocab-stats") {
    vocabStats()
      .then((s) => sendResponse({ ok: true, ...s }))
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
  const text = msg.text || "";
  const targetLang = msg.targetLang || "";
  const sourceLang = msg.sourceLang || "auto";
  const wantDict = !!msg.wantDict;

  // SW 每次冷启动顺手清理一次过期/超容缓存（标志位防重）
  maybeCleanupCache();

  // 仅对非空文本走缓存；空文本直接交给 provider 自然失败
  let cacheKey = null;
  if (text) {
    cacheKey = await makeCacheKey({ provider, text, targetLang, sourceLang, wantDict });
    const hit = await cacheGet(cacheKey);
    if (hit) return { translated: hit.text, dict: hit.dict || null, cached: true };
  }

  const config = await loadProviderConfig(provider);
  const options = { wantDict, sourceLang };
  const result = await translate(provider, text, targetLang, config, options);
  const translated = result.text || "";
  const dict = result.dict || null;
  if (cacheKey && translated) {
    // 不 await：写缓存失败不能阻塞返回；cache.js 内部已经吞错
    cacheSet(cacheKey, { text: translated, dict });
  }
  return { translated, dict };
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
