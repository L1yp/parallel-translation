// options.js —— 设置页交互
// 多页面侧栏：基础 / 悬停 / 划词 / 输入 / 翻译服务 / 站点规则 / 缓存
// 偏好与凭证统一写 chrome.storage.sync；缓存管理通过 message → background.js 走 IndexedDB。

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

// ===== 多页面路由 =====
// hash 形如 #general、#site-rules、#site-rules?host=github.com
const DEFAULT_PAGE = "general";
const VALID_PAGES = new Set(["general", "hover", "selection", "input", "providers", "site-rules", "cache"]);

function parseHash() {
  const raw = (location.hash || "").replace(/^#/, "");
  const [page, query] = raw.split("?");
  const params = new URLSearchParams(query || "");
  const safePage = VALID_PAGES.has(page) ? page : DEFAULT_PAGE;
  return { page: safePage, params };
}

function activatePage(page) {
  for (const el of document.querySelectorAll(".page")) {
    el.classList.toggle("active", el.dataset.page === page);
  }
  for (const el of document.querySelectorAll(".nav-link")) {
    el.classList.toggle("active", el.dataset.page === page);
  }
  // 滚回顶部，避免长页面切换后停在中间
  window.scrollTo({ top: 0, behavior: "instant" });
}

// popup 的 "为此站点定制" 入口可能在 siteRules 尚未加载完成时触发，
// 暂存 host，等 loadRules 回来再走 tryAutoOpenRule
let pendingRuleOpenHost = null;
let rulesLoaded = false;

function applyRoute() {
  const { page, params } = parseHash();
  activatePage(page);
  if (page === "site-rules" && params.has("host")) {
    pendingRuleOpenHost = params.get("host");
    tryAutoOpenRule();
  }
}

// 与 content.js 的 matchesHost 保持一致：suffix 匹配 + *. 前缀
function hostMatchesPattern(host, pattern) {
  if (!host || !pattern) return false;
  host = String(host).toLowerCase();
  pattern = String(pattern).toLowerCase().trim();
  if (!pattern) return false;
  if (pattern.startsWith("*.")) {
    const tail = pattern.slice(2);
    return host === tail || host.endsWith("." + tail);
  }
  return host === pattern || host.endsWith("." + pattern);
}

function tryAutoOpenRule() {
  if (!rulesLoaded || !pendingRuleOpenHost) return;
  const host = pendingRuleOpenHost;
  pendingRuleOpenHost = null;
  const matching = siteRules.find((r) => r && r.pattern && hostMatchesPattern(host, r.pattern));
  if (matching) openRuleEditor(matching.id);
  else openRuleEditor(null, host);
}

window.addEventListener("hashchange", applyRoute);

// ===== 偏好双向绑定 =====
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  // 偏好热同步（popup 或别处改了）
  const prefKeys = new Set(Object.keys(PREF_DEFAULTS));
  if (Object.keys(changes).some((k) => prefKeys.has(k))) {
    for (const b of PREF_BINDINGS) {
      if (b.key in changes) writePrefControl(b, changes[b.key].newValue);
    }
  }
  // 站点规则热同步（别处也可能写）
  if ("siteRules" in changes) {
    siteRules = Array.isArray(changes.siteRules.newValue) ? changes.siteRules.newValue : [];
    renderRulesList();
  }
});

// ===== 凭证 =====
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

// ===== 保存提示 =====
const savedHint = $("saved-hint");
let savedHintTimer = null;
function flashSaved() {
  savedHint.classList.add("show");
  clearTimeout(savedHintTimer);
  savedHintTimer = setTimeout(() => savedHint.classList.remove("show"), 1200);
}

// ===== 通用测试连接 =====
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

// ===== 站点规则 =====
// 一条规则形如 { id, pattern, enabled, [overridable pref keys...] }
// 仅在某 pref key 存在于规则对象时视为覆盖；空串 / undefined 表示继承全局。
const RULE_BINDINGS = [
  { id: "rule-target-lang", key: "targetLang", kind: "select" },
  { id: "rule-provider", key: "provider", kind: "select" },
  { id: "rule-style", key: "style", kind: "select" },
  { id: "rule-observer", key: "observerEnabled", kind: "tristate" },
  { id: "rule-hover-key", key: "hoverKey", kind: "select" },
  { id: "rule-selection-translate", key: "selectionTranslate", kind: "select" },
  { id: "rule-input-translate", key: "inputTranslate", kind: "select" },
  { id: "rule-input-source-lang", key: "inputSourceLang", kind: "select" },
  { id: "rule-input-target-lang", key: "inputTargetLang", kind: "select" },
];

// 展示规则覆盖时的可读标签
const PREF_LABELS = {
  targetLang: { name: "目标语言", values: { "zh-CN": "中文（简体）", "zh-TW": "中文（繁体）", en: "English", ja: "日本語", ko: "한국어", fr: "Français", de: "Deutsch", es: "Español" } },
  provider: { name: "翻译服务", values: { google: "Google", microsoft: "Microsoft", youdao: "有道" } },
  style: { name: "样式", values: { default: "默认", underline: "下划线", blur: "模糊", bold: "加粗", card: "卡片" } },
  observerEnabled: { name: "动态内容", values: { true: "启用", false: "禁用" } },
  hoverKey: { name: "悬停", values: { off: "关闭", alt: "Alt", ctrl: "Ctrl", shift: "Shift" } },
  selectionTranslate: { name: "划词", values: { off: "关闭", button: "按钮", auto: "自动" } },
  inputTranslate: { name: "输入框", values: { off: "关闭", space3: "三击空格" } },
  inputSourceLang: { name: "输入源", values: { auto: "自动", "zh-CN": "中文（简体）", "zh-TW": "中文（繁体）", en: "English", ja: "日本語", ko: "한국어", fr: "Français", de: "Deutsch", es: "Español" } },
  inputTargetLang: { name: "输入目标", values: { en: "English", "zh-CN": "中文（简体）", "zh-TW": "中文（繁体）", ja: "日本語", ko: "한국어", fr: "Français", de: "Deutsch", es: "Español" } },
};

let siteRules = [];
let editingRuleId = null; // null 表示新建；string 表示编辑现有规则的 id

const rulesList = $("rules-list");
const rulesSummary = $("rules-summary");
const ruleEditor = $("rule-editor");
const ruleEditorTitle = $("rule-editor-title");
const rulePatternInput = $("rule-pattern");

function genId() {
  // crypto.randomUUID 在 chrome-extension:// 上下文可用
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadRules() {
  chrome.storage.sync.get("siteRules", (res) => {
    siteRules = Array.isArray(res.siteRules) ? res.siteRules : [];
    rulesLoaded = true;
    renderRulesList();
    tryAutoOpenRule();
  });
}

function persistRules() {
  chrome.storage.sync.set({ siteRules }, flashSaved);
}

function renderRulesList() {
  rulesList.innerHTML = "";
  if (!siteRules.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "暂无站点规则。点击右上角「添加规则」按钮新建一条。";
    rulesList.appendChild(empty);
    rulesSummary.textContent = "0 条规则";
    return;
  }
  rulesSummary.textContent = `${siteRules.length} 条规则`;
  for (const rule of siteRules) {
    rulesList.appendChild(renderRuleItem(rule));
  }
}

function renderRuleItem(rule) {
  const li = document.createElement("li");
  li.className = "rule-item" + (rule.enabled === false ? " disabled" : "");

  const head = document.createElement("div");
  head.className = "rule-head";

  const pattern = document.createElement("div");
  pattern.className = "rule-pattern";
  pattern.textContent = rule.pattern || "(空 pattern)";
  head.appendChild(pattern);

  const actions = document.createElement("div");
  actions.className = "rule-actions";

  const enabledLabel = document.createElement("label");
  enabledLabel.className = "rule-enabled";
  const enabledChk = document.createElement("input");
  enabledChk.type = "checkbox";
  enabledChk.checked = rule.enabled !== false;
  enabledChk.addEventListener("change", () => {
    rule.enabled = enabledChk.checked;
    li.classList.toggle("disabled", !rule.enabled);
    persistRules();
  });
  enabledLabel.appendChild(enabledChk);
  enabledLabel.appendChild(document.createTextNode("启用"));
  actions.appendChild(enabledLabel);

  const editBtn = document.createElement("button");
  editBtn.className = "subtle";
  editBtn.textContent = "编辑";
  editBtn.addEventListener("click", () => openRuleEditor(rule.id));
  actions.appendChild(editBtn);

  const delBtn = document.createElement("button");
  delBtn.className = "subtle";
  delBtn.style.color = "#b91c1c";
  delBtn.textContent = "删除";
  delBtn.addEventListener("click", () => {
    if (!confirm(`确定删除规则 "${rule.pattern}"？`)) return;
    siteRules = siteRules.filter((r) => r.id !== rule.id);
    persistRules();
    renderRulesList();
  });
  actions.appendChild(delBtn);

  head.appendChild(actions);
  li.appendChild(head);

  const overrides = document.createElement("div");
  overrides.className = "rule-overrides";
  const tags = describeRuleOverrides(rule);
  if (!tags.length) {
    const muted = document.createElement("span");
    muted.className = "rule-tag muted";
    muted.textContent = "未覆盖任何字段（继承全部全局）";
    overrides.appendChild(muted);
  } else {
    for (const t of tags) {
      const tag = document.createElement("span");
      tag.className = "rule-tag";
      tag.textContent = t;
      overrides.appendChild(tag);
    }
  }
  li.appendChild(overrides);
  return li;
}

function describeRuleOverrides(rule) {
  const out = [];
  for (const b of RULE_BINDINGS) {
    if (!(b.key in rule)) continue;
    const v = rule[b.key];
    const spec = PREF_LABELS[b.key];
    if (!spec) continue;
    const label = spec.values[String(v)] || String(v);
    out.push(`${spec.name}: ${label}`);
  }
  return out;
}

function openRuleEditor(ruleId, presetPattern) {
  editingRuleId = ruleId || null;
  const existing = ruleId ? siteRules.find((r) => r.id === ruleId) : null;
  ruleEditorTitle.textContent = existing ? "编辑规则" : "添加规则";
  rulePatternInput.value = existing ? (existing.pattern || "") : (presetPattern || "");

  for (const b of RULE_BINDINGS) {
    const el = $(b.id);
    if (existing && b.key in existing) {
      const v = existing[b.key];
      el.value = b.kind === "tristate" ? String(v) : v;
    } else {
      el.value = "";
    }
  }
  ruleEditor.classList.remove("hidden");
  // 跳过路由 scrollTo 之后，再滚到编辑器
  setTimeout(() => ruleEditor.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
}

function closeRuleEditor() {
  editingRuleId = null;
  ruleEditor.classList.add("hidden");
}

function readRuleFromEditor() {
  const pattern = rulePatternInput.value.trim();
  if (!pattern) {
    alert("请填写域名 pattern");
    return null;
  }
  // 简单 pattern 校验：允许字母数字、点、连字符、可选前缀 *.
  if (!/^(\*\.)?[A-Za-z0-9.-]+$/.test(pattern)) {
    alert("pattern 仅支持字母 / 数字 / 点 / 连字符，可选前缀 *.");
    return null;
  }
  const rule = { pattern, enabled: true };
  for (const b of RULE_BINDINGS) {
    const v = $(b.id).value;
    if (v === "") continue;
    rule[b.key] = b.kind === "tristate" ? v === "true" : v;
  }
  return rule;
}

$("rule-add").addEventListener("click", () => openRuleEditor(null));
$("rule-cancel").addEventListener("click", closeRuleEditor);
$("rule-save").addEventListener("click", () => {
  const data = readRuleFromEditor();
  if (!data) return;
  if (editingRuleId) {
    const idx = siteRules.findIndex((r) => r.id === editingRuleId);
    if (idx >= 0) {
      // 保留 id 与 enabled（用户在列表里独立切的）
      const prev = siteRules[idx];
      siteRules[idx] = { ...data, id: prev.id, enabled: data.enabled };
    }
  } else {
    siteRules.push({ ...data, id: genId() });
  }
  persistRules();
  renderRulesList();
  closeRuleEditor();
});

// ===== 缓存管理 =====
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

// ===== 启动 =====
loadPrefsToUI();
loadRules();
loadCacheStats();
applyRoute();
