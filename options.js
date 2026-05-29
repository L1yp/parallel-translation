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
const VALID_PAGES = new Set(["general", "hover", "selection", "input", "providers", "site-rules", "vocab", "cache"]);

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

// ===== 生词本 =====
// 数据走 background → vocab.js（IndexedDB）。本页只发消息、渲染列表。

const vocabState = {
  search: "",
  targetLang: "",
  sortBy: "createdDesc",
  items: [],
  total: 0,
  // 全库统计（不随筛选变化），由 vocab-stats 维护
  stats: { count: 0, oldestAt: null, newestAt: null },
  expanded: new Set(),
  editingNote: null, // id 或 null
};

function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const vocabSearchEl = $("vocab-search");
const vocabLangEl = $("vocab-lang");
const vocabSortEl = $("vocab-sort");
const vocabListEl = $("vocab-list");
const vocabSummaryEl = $("vocab-summary");
const vocabStatusEl = $("vocab-status");
const vocabImportFile = $("vocab-import-file");

function setVocabStatus(text, kind) {
  vocabStatusEl.textContent = text || "";
  vocabStatusEl.className = "cache-status" + (kind ? " " + kind : "");
}

function loadVocabStats() {
  chrome.runtime.sendMessage({ type: "vocab-stats" }, (resp) => {
    // stats 是辅助显示，失败不弹错（与 cache 行为一致），保持上次值
    void chrome.runtime.lastError;
    if (resp && resp.ok) {
      vocabState.stats = {
        count: resp.count || 0,
        oldestAt: resp.oldestAt || null,
        newestAt: resp.newestAt || null,
      };
      renderVocabSummary();
    }
  });
}

function loadVocab() {
  chrome.runtime.sendMessage(
    {
      type: "vocab-list",
      filter: {
        search: vocabState.search,
        targetLang: vocabState.targetLang,
        sortBy: vocabState.sortBy,
      },
    },
    (resp) => {
      if (chrome.runtime.lastError) {
        setVocabStatus("加载失败：" + chrome.runtime.lastError.message, "err");
        return;
      }
      if (resp && resp.ok) {
        vocabState.items = resp.items || [];
        vocabState.total = resp.total || 0;
        renderVocabList();
      } else {
        setVocabStatus("加载失败：" + ((resp && resp.error) || "未知错误"), "err");
      }
    }
  );
  loadVocabStats();
}

function renderVocabSummary() {
  const showing = vocabState.items.length;
  const { count: total, oldestAt } = vocabState.stats;
  const filtered = !!(vocabState.search || vocabState.targetLang);

  if (!total) {
    vocabSummaryEl.textContent = "暂无收藏。在划词翻译气泡上点击 ☆ 或按 S 键即可添加。";
    return;
  }

  const oldestPart = oldestAt ? `，最早 ${fmtDate(oldestAt)}` : "";
  if (filtered) {
    vocabSummaryEl.textContent = `共 ${total} 条${oldestPart}（当前筛选显示 ${showing} 条）`;
  } else {
    vocabSummaryEl.textContent = `共 ${total} 条${oldestPart}`;
  }
}

function renderVocabList() {
  vocabListEl.innerHTML = "";
  renderVocabSummary();
  const showing = vocabState.items.length;

  if (!showing) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = vocabState.search || vocabState.targetLang
      ? "没有匹配的生词。"
      : "暂无生词收藏。";
    vocabListEl.appendChild(empty);
    return;
  }

  for (const item of vocabState.items) {
    vocabListEl.appendChild(renderVocabItem(item));
  }
}

function renderVocabItem(item) {
  const wrap = document.createElement("div");
  wrap.className = "vocab-item";
  if (vocabState.expanded.has(item.id)) wrap.classList.add("expanded");

  const row = document.createElement("div");
  row.className = "vocab-row";

  const word = document.createElement("div");
  word.className = "vocab-word";
  word.textContent = item.word;
  row.appendChild(word);

  const arrow = document.createElement("div");
  arrow.className = "vocab-arrow";
  arrow.textContent = "→";
  row.appendChild(arrow);

  const trans = document.createElement("div");
  trans.className = "vocab-translation";
  trans.textContent = item.translation || "（无译文）";
  row.appendChild(trans);

  const actions = document.createElement("div");
  actions.className = "vocab-actions-cell";

  if (hasDictPayload(item.dict)) {
    const detailBtn = document.createElement("button");
    detailBtn.className = "subtle";
    detailBtn.textContent = wrap.classList.contains("expanded") ? "收起" : "详情";
    detailBtn.addEventListener("click", () => {
      if (vocabState.expanded.has(item.id)) vocabState.expanded.delete(item.id);
      else vocabState.expanded.add(item.id);
      renderVocabList();
    });
    actions.appendChild(detailBtn);
  }

  const noteBtn = document.createElement("button");
  noteBtn.className = "subtle";
  noteBtn.textContent = "备注";
  noteBtn.addEventListener("click", () => {
    vocabState.editingNote = vocabState.editingNote === item.id ? null : item.id;
    renderVocabList();
  });
  actions.appendChild(noteBtn);

  const delBtn = document.createElement("button");
  delBtn.className = "subtle";
  delBtn.style.color = "#b91c1c";
  delBtn.textContent = "删除";
  delBtn.addEventListener("click", () => {
    if (!confirm(`确定删除 "${item.word}"？`)) return;
    chrome.runtime.sendMessage({ type: "vocab-remove", id: item.id }, () => {
      void chrome.runtime.lastError;
      loadVocab();
    });
  });
  actions.appendChild(delBtn);

  row.appendChild(actions);
  wrap.appendChild(row);

  const meta = document.createElement("div");
  meta.className = "vocab-meta";
  const langPill = document.createElement("span");
  langPill.className = "vocab-pill";
  langPill.textContent = (item.sourceLang || "auto") + " → " + (item.targetLang || "");
  meta.appendChild(langPill);
  const time = document.createElement("span");
  time.textContent = fmtTime(item.createdAt);
  meta.appendChild(time);
  if (item.sourceUrl) {
    const link = document.createElement("a");
    link.className = "vocab-source-link";
    link.href = item.sourceUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = item.sourceTitle || item.sourceUrl;
    meta.appendChild(link);
  }
  wrap.appendChild(meta);

  if (item.context) {
    const ctx = document.createElement("div");
    ctx.className = "vocab-context";
    ctx.textContent = item.context;
    wrap.appendChild(ctx);
  }

  const noteRow = document.createElement("div");
  noteRow.className = "vocab-note-row";
  if (vocabState.editingNote === item.id) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "vocab-note-input";
    input.placeholder = "备注…（Enter 保存，Esc 取消）";
    input.value = item.note || "";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveVocabNote(item.id, input.value);
      } else if (e.key === "Escape") {
        vocabState.editingNote = null;
        renderVocabList();
      }
    });
    input.addEventListener("blur", () => {
      // blur 也保存（用户点别处）
      if (vocabState.editingNote === item.id) {
        saveVocabNote(item.id, input.value);
      }
    });
    noteRow.appendChild(input);
    setTimeout(() => input.focus(), 0);
  } else if (item.note) {
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "备注：";
    noteRow.appendChild(label);
    const txt = document.createElement("span");
    txt.textContent = item.note;
    noteRow.appendChild(txt);
  }
  if (noteRow.childNodes.length) wrap.appendChild(noteRow);

  if (vocabState.expanded.has(item.id) && hasDictPayload(item.dict)) {
    wrap.appendChild(renderVocabDictDetail(item));
  }

  return wrap;
}

function saveVocabNote(id, note) {
  vocabState.editingNote = null;
  chrome.runtime.sendMessage(
    { type: "vocab-update-note", id, note: String(note || "") },
    () => {
      void chrome.runtime.lastError;
      // 本地直接改一下避免再发一次 list
      const it = vocabState.items.find((x) => x.id === id);
      if (it) it.note = String(note || "");
      renderVocabList();
    }
  );
}

function hasDictPayload(dict) {
  if (!dict) return false;
  return !!(
    (dict.phonetics && dict.phonetics.length) ||
    (dict.explains && dict.explains.length) ||
    (dict.definitions && dict.definitions.length) ||
    (dict.examples && dict.examples.length) ||
    (dict.webExplains && dict.webExplains.length) ||
    (dict.wordforms && dict.wordforms.length)
  );
}

function renderVocabDictDetail(item) {
  const wrap = document.createElement("div");
  wrap.className = "vocab-detail";
  const dict = item.dict || {};

  const addLine = (cls, text) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    wrap.appendChild(d);
  };

  if (Array.isArray(dict.phonetics) && dict.phonetics.length) {
    const ph = dict.phonetics
      .map((p) => (p.region ? p.region + " " : "") + "/" + p.ipa + "/")
      .join("   ");
    addLine("dict-line dict-phonetic", ph);
  }

  if (Array.isArray(dict.explains) && dict.explains.length) {
    addLine("dict-section", "释义");
    for (const e of dict.explains) addLine("dict-line", e);
  }

  if (Array.isArray(dict.definitions) && dict.definitions.length) {
    addLine("dict-section", "释义");
    for (const d of dict.definitions) addLine("dict-line", d);
  }

  if (Array.isArray(dict.wordforms) && dict.wordforms.length) {
    addLine("dict-section", "词形");
    for (const wf of dict.wordforms) addLine("dict-line", wf);
  }

  if (Array.isArray(dict.webExplains) && dict.webExplains.length) {
    addLine("dict-section", "网络");
    for (const w of dict.webExplains) {
      addLine("dict-line", w.key + " — " + (w.values || []).join("；"));
    }
  }

  if (Array.isArray(dict.examples) && dict.examples.length) {
    addLine("dict-section", "例句");
    for (const ex of dict.examples) {
      const exWrap = document.createElement("div");
      exWrap.className = "dict-example";
      const src = document.createElement("div");
      src.textContent = ex.src;
      exWrap.appendChild(src);
      if (ex.tgt) {
        const tgt = document.createElement("div");
        tgt.style.color = "#6b7280";
        tgt.textContent = ex.tgt;
        exWrap.appendChild(tgt);
      }
      wrap.appendChild(exWrap);
    }
  }

  return wrap;
}

// 搜索框 200ms 去抖
let vocabSearchTimer = null;
vocabSearchEl.addEventListener("input", () => {
  if (vocabSearchTimer) clearTimeout(vocabSearchTimer);
  vocabSearchTimer = setTimeout(() => {
    vocabState.search = vocabSearchEl.value.trim();
    loadVocab();
  }, 200);
});
vocabLangEl.addEventListener("change", () => {
  vocabState.targetLang = vocabLangEl.value;
  loadVocab();
});
vocabSortEl.addEventListener("change", () => {
  vocabState.sortBy = vocabSortEl.value;
  loadVocab();
});

// 导出工具
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

function csvEscape(s) {
  s = String(s == null ? "" : s);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function exportFilename(ext) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `vocabulary-${y}${m}${day}.${ext}`;
}

function fetchAllVocab(cb) {
  chrome.runtime.sendMessage({ type: "vocab-export" }, (resp) => {
    if (chrome.runtime.lastError) {
      setVocabStatus("导出失败：" + chrome.runtime.lastError.message, "err");
      return;
    }
    if (resp && resp.ok) cb(resp.data || { items: [] });
    else setVocabStatus("导出失败：" + ((resp && resp.error) || "未知错误"), "err");
  });
}

$("vocab-export-json").addEventListener("click", () => {
  fetchAllVocab((data) => {
    if (!data.items || !data.items.length) {
      setVocabStatus("生词本为空，无可导出内容", "err");
      return;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    downloadBlob(blob, exportFilename("json"));
    setVocabStatus(`已导出 ${data.items.length} 条 (JSON)`, "ok");
  });
});

$("vocab-export-csv").addEventListener("click", () => {
  fetchAllVocab((data) => {
    if (!data.items || !data.items.length) {
      setVocabStatus("生词本为空，无可导出内容", "err");
      return;
    }
    const header = ["word", "translation", "phonetic", "sourceLang", "targetLang", "note", "sourceUrl", "createdAt"];
    const lines = [header.join(",")];
    for (const it of data.items) {
      const phon =
        (it.dict && Array.isArray(it.dict.phonetics) && it.dict.phonetics[0] && it.dict.phonetics[0].ipa) || "";
      const iso = it.createdAt ? new Date(it.createdAt).toISOString() : "";
      lines.push([
        csvEscape(it.word),
        csvEscape(it.translation),
        csvEscape(phon),
        csvEscape(it.sourceLang),
        csvEscape(it.targetLang),
        csvEscape(it.note),
        csvEscape(it.sourceUrl),
        csvEscape(iso),
      ].join(","));
    }
    // BOM 让 Excel 正确识别 UTF-8
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, exportFilename("csv"));
    setVocabStatus(`已导出 ${data.items.length} 条 (CSV)`, "ok");
  });
});

$("vocab-export-anki").addEventListener("click", () => {
  fetchAllVocab((data) => {
    if (!data.items || !data.items.length) {
      setVocabStatus("生词本为空，无可导出内容", "err");
      return;
    }
    const lines = [];
    for (const it of data.items) {
      const front = it.word;
      const parts = [];
      const phon =
        (it.dict && Array.isArray(it.dict.phonetics) && it.dict.phonetics[0] && it.dict.phonetics[0].ipa) || "";
      if (phon) parts.push("/" + phon + "/");
      if (it.translation) parts.push(it.translation);
      const explains = (it.dict && Array.isArray(it.dict.explains)) ? it.dict.explains : [];
      for (const e of explains) parts.push("· " + e);
      const defs = (it.dict && Array.isArray(it.dict.definitions)) ? it.dict.definitions : [];
      for (const d of defs) parts.push("· " + d);
      if (it.note) parts.push("📝 " + it.note);
      const back = parts.join("<br>").replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
      lines.push(front.replace(/\t/g, " ") + "\t" + back);
    }
    const blob = new Blob([lines.join("\r\n")], { type: "text/tab-separated-values;charset=utf-8" });
    downloadBlob(blob, exportFilename("tsv"));
    setVocabStatus(`已导出 ${data.items.length} 条 (Anki TSV)`, "ok");
  });
});

$("vocab-import-btn").addEventListener("click", () => {
  vocabImportFile.value = "";
  vocabImportFile.click();
});

// 两步 confirm 选择导入模式：先 merge / 取消，取消后再问是否走 replace（破坏性）。
// 这样 OK = 安全默认（合并），需要破坏性操作的用户得明确再确认一次。
function pickImportMode(count) {
  const mergeChoice = confirm(
    `将导入 ${count} 条生词。\n\n` +
    `[确定] 合并模式：已存在的（相同词 + 目标语言）跳过，仅追加新增\n` +
    `[取消] 选择其他模式（覆盖）或放弃导入`
  );
  if (mergeChoice) return "merge";
  const replaceChoice = confirm(
    `选择「覆盖模式」？\n\n` +
    `⚠️ 会先清空当前所有生词，再导入文件中的 ${count} 条。\n` +
    `建议先导出 JSON 备份。\n\n` +
    `[确定] 覆盖\n[取消] 放弃导入`
  );
  return replaceChoice ? "replace" : null;
}

vocabImportFile.addEventListener("change", () => {
  const f = vocabImportFile.files && vocabImportFile.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try { parsed = JSON.parse(reader.result); }
    catch (e) {
      setVocabStatus("导入失败：JSON 解析错误", "err");
      return;
    }
    if (!parsed || !Array.isArray(parsed.items)) {
      setVocabStatus("导入失败：文件结构不合法（需要 {version, items: []}）", "err");
      return;
    }
    const count = parsed.items.length;
    const mode = pickImportMode(count);
    if (!mode) return;
    setVocabStatus(mode === "replace" ? "覆盖导入中…" : "合并导入中…");
    chrome.runtime.sendMessage(
      { type: "vocab-import", data: parsed, mode },
      (resp) => {
        if (chrome.runtime.lastError) {
          setVocabStatus("导入失败：" + chrome.runtime.lastError.message, "err");
          return;
        }
        if (resp && resp.ok) {
          const modeLabel = mode === "replace" ? "覆盖" : "合并";
          setVocabStatus(
            `${modeLabel}导入完成：新增 ${resp.added} 条，跳过 ${resp.skipped} 条`,
            "ok"
          );
          loadVocab();
        } else {
          setVocabStatus("导入失败：" + ((resp && resp.error) || "未知错误"), "err");
        }
      }
    );
  };
  reader.onerror = () => setVocabStatus("读取文件失败", "err");
  reader.readAsText(f);
});

$("vocab-clear-btn").addEventListener("click", () => {
  if (!confirm("确定清空全部生词收藏？此操作不可撤销，建议先导出 JSON 备份。")) return;
  chrome.runtime.sendMessage({ type: "vocab-clear-all" }, (resp) => {
    if (chrome.runtime.lastError) {
      setVocabStatus("失败：" + chrome.runtime.lastError.message, "err");
      return;
    }
    if (resp && resp.ok) {
      setVocabStatus(`已清空 ${resp.cleared} 条`, "ok");
      loadVocab();
    } else {
      setVocabStatus("失败：" + ((resp && resp.error) || "未知错误"), "err");
    }
  });
});

// ===== 启动 =====
loadPrefsToUI();
loadRules();
loadCacheStats();
loadVocab();
applyRoute();
