// popup.js —— 弹窗交互
// 偏好统一存 chrome.storage.sync；content.js 通过 storage.onChanged 实时拿到变更。
// 各 provider 的凭证（msKey / ydAppKey / ydAppSecret 等）改在独立的 options.html 配置。

const DEFAULTS = {
  targetLang: "zh-CN",
  provider: "google",
  style: "default",
  hoverKey: "alt",
  inputTranslate: "off",
  inputSourceLang: "auto",
  inputTargetLang: "en",
  selectionTranslate: "off",
  observerEnabled: true,
};

// provider → 凭证字段名（用于检测是否已配置）
const CRED_FIELDS = {
  microsoft: { fields: ["msKey"], label: "Microsoft API Key" },
  youdao: { fields: ["ydAppKey", "ydAppSecret"], label: "有道 App Key / App Secret" },
};
const ALL_CRED_KEYS = [...new Set(Object.values(CRED_FIELDS).flatMap((c) => c.fields))];

const $ = (id) => document.getElementById(id);
const langSel = $("lang");
const providerSel = $("provider");
const styleSel = $("style");
const hoverSel = $("hover");
const inputTranslateSel = $("input-translate");
const inputSourceLangSel = $("input-source-lang");
const inputTargetLangSel = $("input-target-lang");
const selectionTranslateSel = $("selection-translate");
const observerChk = $("observer");
const goBtn = $("go");
const credTip = $("cred-tip");
const credTipWhat = $("cred-tip-what");
const credTipLink = $("cred-tip-link");
const openOptionsLink = $("open-options");

function refreshCredTip(store) {
  const spec = CRED_FIELDS[providerSel.value];
  if (!spec) {
    credTip.classList.remove("show");
    return;
  }
  const missing = spec.fields.some((k) => !((store[k] || "").trim()));
  credTipWhat.textContent = spec.label;
  credTip.classList.toggle("show", missing);
}

function readPrefs() {
  return {
    targetLang: langSel.value,
    provider: providerSel.value,
    style: styleSel.value,
    hoverKey: hoverSel.value,
    inputTranslate: inputTranslateSel.value,
    inputSourceLang: inputSourceLangSel.value,
    inputTargetLang: inputTargetLangSel.value,
    selectionTranslate: selectionTranslateSel.value,
    observerEnabled: observerChk.checked,
  };
}

function applyPrefsToUI(prefs) {
  langSel.value = prefs.targetLang;
  providerSel.value = prefs.provider;
  styleSel.value = prefs.style;
  hoverSel.value = prefs.hoverKey;
  inputTranslateSel.value = prefs.inputTranslate;
  inputSourceLangSel.value = prefs.inputSourceLang;
  inputTargetLangSel.value = prefs.inputTargetLang;
  selectionTranslateSel.value = prefs.selectionTranslate;
  observerChk.checked = !!prefs.observerEnabled;
}

chrome.storage.sync.get([...Object.keys(DEFAULTS), ...ALL_CRED_KEYS], (res) => {
  applyPrefsToUI({ ...DEFAULTS, ...res });
  refreshCredTip(res);
});

function persistOnChange() {
  chrome.storage.sync.set(readPrefs());
}
[langSel, styleSel, hoverSel, inputTranslateSel, inputSourceLangSel, inputTargetLangSel, selectionTranslateSel, observerChk].forEach((el) =>
  el.addEventListener("change", persistOnChange)
);

providerSel.addEventListener("change", () => {
  persistOnChange();
  chrome.storage.sync.get(ALL_CRED_KEYS, (res) => refreshCredTip(res));
});

// 用户在设置页填了凭证后，回 popup 应立刻消失提示
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (!ALL_CRED_KEYS.some((k) => k in changes)) return;
  chrome.storage.sync.get(ALL_CRED_KEYS, (res) => refreshCredTip(res));
});

function openOptions(e) {
  if (e) e.preventDefault();
  chrome.runtime.openOptionsPage();
}
openOptionsLink.addEventListener("click", openOptions);
credTipLink.addEventListener("click", openOptions);

goBtn.addEventListener("click", async () => {
  const prefs = readPrefs();
  chrome.storage.sync.set(prefs);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  chrome.tabs.sendMessage(tab.id, { type: "toggle", ...prefs }, (resp) => {
    if (chrome.runtime.lastError) {
      goBtn.textContent = "请刷新页面后重试";
      setTimeout(() => (goBtn.textContent = "翻译 / 还原"), 1800);
      return;
    }
    goBtn.textContent = resp && resp.state === "on" ? "已开启，再点还原" : "已还原";
    setTimeout(() => (goBtn.textContent = "翻译 / 还原"), 1500);
  });
});
