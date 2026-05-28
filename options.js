// options.js —— 设置页交互
// 与 popup.js 共用同一份 chrome.storage.sync；改动自动保存。

const DEFAULTS = {
  msKey: "",
  msRegion: "eastasia",
  ydAppKey: "",
  ydAppSecret: "",
};

const $ = (id) => document.getElementById(id);

const fields = {
  msKey: $("ms-key"),
  msRegion: $("ms-region"),
  ydAppKey: $("yd-app-key"),
  ydAppSecret: $("yd-app-secret"),
};
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

chrome.storage.sync.get(Object.keys(DEFAULTS), (res) => {
  const merged = { ...DEFAULTS, ...res };
  for (const [k, el] of Object.entries(fields)) {
    el.value = merged[k] || "";
  }
});

function readAll() {
  return {
    msKey: fields.msKey.value.trim(),
    msRegion: fields.msRegion.value.trim() || DEFAULTS.msRegion,
    ydAppKey: fields.ydAppKey.value.trim(),
    ydAppSecret: fields.ydAppSecret.value.trim(),
  };
}

function persist() {
  chrome.storage.sync.set(readAll(), flashSaved);
}

for (const el of Object.values(fields)) {
  el.addEventListener("input", persist);
  el.addEventListener("change", persist);
}

// 通用测试连接：先确保最新输入已落盘，再让 background 走一次真翻译
function bindTest(btnId, statusId, provider) {
  const btn = $(btnId);
  const status = $(statusId);
  btn.addEventListener("click", () => {
    status.textContent = "测试中…";
    status.className = "test-status";
    chrome.storage.sync.set(readAll(), () => {
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
