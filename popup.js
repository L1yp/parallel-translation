// popup.js —— 弹窗交互
// 偏好统一存 chrome.storage.sync；content.js 通过 storage.onChanged 实时拿到变更。
// 点击按钮时除了写 storage，还会把当前偏好一起塞进 toggle 消息，避免 content.js 初次注入未及读 storage 的竞态。

const DEFAULTS = {
  targetLang: "zh-CN",
  style: "default",
  hoverKey: "alt",
  observerEnabled: true,
  provider: "google",
};

const langSel = document.getElementById("lang");
const styleSel = document.getElementById("style");
const hoverSel = document.getElementById("hover");
const observerChk = document.getElementById("observer");
const goBtn = document.getElementById("go");

function readPrefs() {
  return {
    targetLang: langSel.value,
    style: styleSel.value,
    hoverKey: hoverSel.value,
    observerEnabled: observerChk.checked,
    provider: DEFAULTS.provider,
  };
}

function applyPrefsToUI(prefs) {
  langSel.value = prefs.targetLang;
  styleSel.value = prefs.style;
  hoverSel.value = prefs.hoverKey;
  observerChk.checked = !!prefs.observerEnabled;
}

// 恢复持久化偏好
chrome.storage.sync.get(Object.keys(DEFAULTS), (res) => {
  const merged = { ...DEFAULTS, ...res };
  applyPrefsToUI(merged);
});

// 任一控件变更都立刻写入 storage —— content.js 会通过 onChanged 即时响应
function persistOnChange() {
  chrome.storage.sync.set(readPrefs());
}
langSel.addEventListener("change", persistOnChange);
styleSel.addEventListener("change", persistOnChange);
hoverSel.addEventListener("change", persistOnChange);
observerChk.addEventListener("change", persistOnChange);

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
