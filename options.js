// options.js —— 设置页交互
// 偏好（与 popup 共享）+ 凭证 + 本地缓存管理。
// - 偏好与凭证统一写 chrome.storage.sync；其它界面通过 storage.onChanged 实时反映。
// - 缓存管理通过 message → background.js 走 IndexedDB（cache.js）。

const PREF_DEFAULTS = {
  targetLang: "zh-CN",
  provider: "google",
  style: "default",
  observerEnabled: true,
  hoverKey: "alt",
  selectionTranslate: "off",
  inputTranslate: "off",
  inputSourceLang: "auto",
  inputTargetLang: "en",
};

const CRED_DEFAULTS = {
  msKey: "",
  msRegion: "eastasia",
  ydAppKey: "",
  ydAppSecret: "",
};

const $ = (id) => document.getElementById(id);

// ----- 偏好双向绑定 -----
// id 与 storage key 的映射（DOM id 用 kebab-case，storage key 用 camelCase）
const PREF_BINDINGS = [
  { id: "target-lang", key: "targetLang", kind: "select" },
  { id: "provider", key: "provider", kind: "select" },
  { id: "style", key: "style", kind: "select" },
  { id: "observer", key: "observerEnabled", kind: "checkbox" },
  { id: "hover-key", key: "hoverKey", kind: "select" },
  { id: "selection-translate", key: "selectionTranslate", kind: "select" },
  { id: "input-translate", key: "inputTranslate", kind: "select" },
  { id: "input-source-lang", key: "inputSourceLang", kind: "select" },
  { id: "input-target-lang", key: "inputTargetLang", kind: "select" },
];

function readPrefControl(b) {
  const el = $(b.id);
  return b.kind === "checkbox" ? el.checked : el.value;
}
function writePrefControl(b, v) {
  const el = $(b.id);
  if (b.kind === "checkbox") el.checked = !!v;
  else el.value = v;
}

function loadPrefsToUI() {
  chrome.storage.sync.get(Object.keys(PREF_DEFAULTS), (res) => {
    const merged = { ...PREF_DEFAULTS, ...res };
    for (const b of PREF_BINDINGS) writePrefControl(b, merged[b.key]);
  });
}

function persistPrefs() {
  const out = {};
  for (const b of PREF_BINDINGS) out[b.key] = readPrefControl(b);
  chrome.storage.sync.set(out, flashSaved);
}

for (const b of PREF_BINDINGS) {
  $(b.id).addEventListener("change", persistPrefs);
}

// 别处（popup / 其它 options 页）改了偏好时，本页面跟着更新，避免显示陈旧值
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  const prefKeys = new Set(Object.keys(PREF_DEFAULTS));
  if (!Object.keys(changes).some((k) => prefKeys.has(k))) return;
  for (const b of PREF_BINDINGS) {
    if (b.key in changes) writePrefControl(b, changes[b.key].newValue);
  }
});

// ----- 凭证 -----
const credFields = {
  msKey: $("ms-key"),
  msRegion: $("ms-region"),
  ydAppKey: $("yd-app-key"),
  ydAppSecret: $("yd-app-secret"),
};

chrome.storage.sync.get(Object.keys(CRED_DEFAULTS), (res) => {
  const merged = { ...CRED_DEFAULTS, ...res };
  for (const [k, el] of Object.entries(credFields)) el.value = merged[k] || "";
});

function readCredentials() {
  return {
    msKey: credFields.msKey.value.trim(),
    msRegion: credFields.msRegion.value.trim() || CRED_DEFAULTS.msRegion,
    ydAppKey: credFields.ydAppKey.value.trim(),
    ydAppSecret: credFields.ydAppSecret.value.trim(),
  };
}

function persistCredentials() {
  chrome.storage.sync.set(readCredentials(), flashSaved);
}

for (const el of Object.values(credFields)) {
  el.addEventListener("input", persistCredentials);
  el.addEventListener("change", persistCredentials);
}

// ----- 保存提示 -----
const savedHint = $("saved-hint");
let savedHintTimer = null;
function flashSaved() {
  savedHint.textContent = "已保存";
  savedHint.classList.add("show");
  clearTimeout(savedHintTimer);
  savedHintTimer = setTimeout(() => {
    savedHint.classList.remove("show");
    savedHint.textContent = "";
  }, 1200);
}

// ----- 通用测试连接 -----
function bindTest(btnId, statusId, provider) {
  const btn = $(btnId);
  const status = $(statusId);
  btn.addEventListener("click", () => {
    status.textContent = "测试中…";
    status.className = "test-status";
    chrome.storage.sync.set(readCredentials(), () => {
      chrome.runtime.sendMessage(
        { type: "translate", provider, text: "Hello, world.", targetLang: "zh-CN" },
        (resp) => {
          if (chrome.runtime.lastError) {
            status.textContent = "失败：" + chrome.runtime.lastError.message;
            status.className = "test-status err";
            return;
          }
          if (resp && resp.ok) {
            status.textContent = `✓ ${resp.translated}`;
            status.className = "test-status ok";
          } else {
            status.textContent = "失败：" + ((resp && resp.error) || "未知错误");
            status.className = "test-status err";
          }
        }
      );
    });
  });
}
bindTest("ms-test", "ms-test-status", "microsoft");
bindTest("yd-test", "yd-test-status", "youdao");

// ----- 缓存管理 -----
const cacheCount = $("cache-count");
const cacheOldest = $("cache-oldest");
const cacheNewest = $("cache-newest");
const cacheStatus = $("cache-status");

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function renderStats(s) {
  cacheCount.textContent = (s.count || 0).toLocaleString();
  cacheOldest.textContent = fmtTime(s.oldestAt);
  cacheNewest.textContent = fmtTime(s.newestAt);
}

function setCacheStatus(text, kind) {
  cacheStatus.textContent = text || "";
  cacheStatus.className = "cache-status" + (kind ? " " + kind : "");
}

function loadCacheStats() {
  setCacheStatus("加载中…");
  chrome.runtime.sendMessage({ type: "cache-stats" }, (resp) => {
    if (chrome.runtime.lastError) {
      setCacheStatus("失败：" + chrome.runtime.lastError.message, "err");
      return;
    }
    if (resp && resp.ok) {
      renderStats(resp);
      setCacheStatus("");
    } else {
      setCacheStatus("失败：" + ((resp && resp.error) || "未知错误"), "err");
    }
  });
}

$("cache-refresh").addEventListener("click", loadCacheStats);

$("cache-cleanup").addEventListener("click", () => {
  setCacheStatus("清理中…");
  chrome.runtime.sendMessage({ type: "cache-cleanup" }, (resp) => {
    if (chrome.runtime.lastError) {
      setCacheStatus("失败：" + chrome.runtime.lastError.message, "err");
      return;
    }
    if (resp && resp.ok) {
      renderStats(resp);
      setCacheStatus("已清理过期条目", "ok");
    } else {
      setCacheStatus("失败：" + ((resp && resp.error) || "未知错误"), "err");
    }
  });
});

$("cache-clear").addEventListener("click", () => {
  if (!confirm("确定清空全部翻译缓存？后续翻译需要重新请求服务端。")) return;
  setCacheStatus("清空中…");
  chrome.runtime.sendMessage({ type: "cache-clear" }, (resp) => {
    if (chrome.runtime.lastError) {
      setCacheStatus("失败：" + chrome.runtime.lastError.message, "err");
      return;
    }
    if (resp && resp.ok) {
      renderStats(resp);
      setCacheStatus("已清空全部缓存", "ok");
    } else {
      setCacheStatus("失败：" + ((resp && resp.error) || "未知错误"), "err");
    }
  });
});

// ----- 启动 -----
loadPrefsToUI();
loadCacheStats();
