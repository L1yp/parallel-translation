// popup.js —— 弹窗交互
// 偏好统一存 chrome.storage.sync；content.js 通过 storage.onChanged 实时拿到变更。
// Microsoft API Key/Region 改在独立的 options.html 配置（chrome.runtime.openOptionsPage）。

const DEFAULTS = {
  targetLang: "zh-CN",
  provider: "google",
  style: "default",
  hoverKey: "alt",
  observerEnabled: true,
};

const $ = (id) => document.getElementById(id);
const langSel = $("lang");
const providerSel = $("provider");
const styleSel = $("style");
const hoverSel = $("hover");
const observerChk = $("observer");
const goBtn = $("go");
const msTip = $("ms-tip");
const msTipLink = $("ms-tip-link");
const openOptionsLink = $("open-options");

function refreshMsTip(msKey) {
  const need = providerSel.value === "microsoft" && !(msKey && msKey.trim());
  msTip.classList.toggle("show", need);
}

function readPrefs() {
  return {
    targetLang: langSel.value,
    provider: providerSel.value,
    style: styleSel.value,
    hoverKey: hoverSel.value,
    observerEnabled: observerChk.checked,
  };
}

function applyPrefsToUI(prefs) {
  langSel.value = prefs.targetLang;
  providerSel.value = prefs.provider;
  styleSel.value = prefs.style;
  hoverSel.value = prefs.hoverKey;
  observerChk.checked = !!prefs.observerEnabled;
}

// 恢复持久化偏好；msKey 仅用于决定是否提示去设置
chrome.storage.sync.get([...Object.keys(DEFAULTS), "msKey"], (res) => {
  const merged = { ...DEFAULTS, ...res };
  applyPrefsToUI(merged);
  refreshMsTip(res.msKey);
});

function persistOnChange() {
  chrome.storage.sync.set(readPrefs());
}
[langSel, providerSel, styleSel, hoverSel, observerChk].forEach((el) =>
  el.addEventListener("change", persistOnChange)
);

providerSel.addEventListener("change", () => {
  chrome.storage.sync.get("msKey", (res) => refreshMsTip(res.msKey));
});

// 若用户在设置页填了 Key，回到 popup 应该立刻消失提示
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !("msKey" in changes)) return;
  refreshMsTip(changes.msKey.newValue);
});

function openOptions(e) {
  if (e) e.preventDefault();
  chrome.runtime.openOptionsPage();
}
openOptionsLink.addEventListener("click", openOptions);
msTipLink.addEventListener("click", openOptions);

goBtn.addEventListener("click", async () => {
  const prefs = readPrefs();
  chrome.storage.sync.set(prefs);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  chrome.tabs.sendMessage(tab.id, { type: "toggle", ...prefs }, (resp) => {
    if (chrome.runtime.lastError) {
      // 内容脚本未注入（多为安装前已打开的页面）
      goBtn.textContent = "请刷新页面后重试";
      setTimeout(() => (goBtn.textContent = "翻译 / 还原"), 1800);
      return;
    }
    goBtn.textContent = resp && resp.state === "on" ? "已开启，再点还原" : "已还原";
    setTimeout(() => (goBtn.textContent = "翻译 / 还原"), 1500);
  });
});
