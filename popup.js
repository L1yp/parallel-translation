// popup.js —— 弹窗交互
// 偏好统一存 chrome.storage.sync；content.js 通过 storage.onChanged 实时拿到变更。
// 微软 Key 也存 storage.sync（同步到登录的 Chrome；如担心同步，可改 storage.local）。

const DEFAULTS = {
  targetLang: "zh-CN",
  provider: "google",
  style: "default",
  hoverKey: "alt",
  observerEnabled: true,
  msKey: "",
  msRegion: "eastasia",
};

const $ = (id) => document.getElementById(id);
const langSel = $("lang");
const providerSel = $("provider");
const styleSel = $("style");
const hoverSel = $("hover");
const observerChk = $("observer");
const goBtn = $("go");
const msConfig = $("ms-config");
const msKeyInput = $("ms-key");
const msRegionInput = $("ms-region");
const msTestBtn = $("ms-test");
const msTestStatus = $("ms-test-status");

function refreshMsConfigVisibility() {
  msConfig.classList.toggle("hidden", providerSel.value !== "microsoft");
}

function readPrefs() {
  return {
    targetLang: langSel.value,
    provider: providerSel.value,
    style: styleSel.value,
    hoverKey: hoverSel.value,
    observerEnabled: observerChk.checked,
    msKey: msKeyInput.value.trim(),
    msRegion: msRegionInput.value.trim() || DEFAULTS.msRegion,
  };
}

function applyPrefsToUI(prefs) {
  langSel.value = prefs.targetLang;
  providerSel.value = prefs.provider;
  styleSel.value = prefs.style;
  hoverSel.value = prefs.hoverKey;
  observerChk.checked = !!prefs.observerEnabled;
  msKeyInput.value = prefs.msKey || "";
  msRegionInput.value = prefs.msRegion || DEFAULTS.msRegion;
  refreshMsConfigVisibility();
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
[langSel, providerSel, styleSel, hoverSel, observerChk].forEach((el) =>
  el.addEventListener("change", persistOnChange)
);
// 文本输入用 input/change 都触发（避免 password 输入完没失焦就关 popup 丢值）
msKeyInput.addEventListener("change", persistOnChange);
msRegionInput.addEventListener("change", persistOnChange);
providerSel.addEventListener("change", refreshMsConfigVisibility);

// 测试 Microsoft 连接
msTestBtn.addEventListener("click", async () => {
  msTestStatus.textContent = "测试中…";
  msTestStatus.className = "test-status";
  // 先持久化当前输入，让 background 读到
  chrome.storage.sync.set(readPrefs(), () => {
    chrome.runtime.sendMessage(
      {
        type: "translate",
        provider: "microsoft",
        text: "Hello, world.",
        targetLang: langSel.value || "zh-CN",
      },
      (resp) => {
        if (chrome.runtime.lastError) {
          msTestStatus.textContent = "失败：" + chrome.runtime.lastError.message;
          msTestStatus.className = "test-status err";
          return;
        }
        if (resp && resp.ok) {
          const alignNote = resp.alignment && resp.alignment.length
            ? `（含 ${resp.alignment.length} 个对齐段）`
            : "（未返回 alignment）";
          msTestStatus.textContent = `✓ ${resp.translated} ${alignNote}`;
          msTestStatus.className = "test-status ok";
        } else {
          msTestStatus.textContent = "失败：" + (resp && resp.error || "未知错误");
          msTestStatus.className = "test-status err";
        }
      }
    );
  });
});

goBtn.addEventListener("click", async () => {
  const prefs = readPrefs();
  chrome.storage.sync.set(prefs);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  // 不把 msKey 传给 content.js —— 让 background 从 storage 读，避免 Key 进页面上下文
  const { msKey, msRegion, ...passable } = prefs;

  chrome.tabs.sendMessage(tab.id, { type: "toggle", ...passable }, (resp) => {
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
