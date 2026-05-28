// options.js —— 设置页交互
// 与 popup.js 共用同一份 chrome.storage.sync；改动自动保存。

const DEFAULTS = {
  msKey: "",
  msRegion: "eastasia",
};

const $ = (id) => document.getElementById(id);
const msKeyInput = $("ms-key");
const msRegionInput = $("ms-region");
const msTestBtn = $("ms-test");
const msTestStatus = $("ms-test-status");
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
  msKeyInput.value = merged.msKey || "";
  msRegionInput.value = merged.msRegion || DEFAULTS.msRegion;
});

function persist() {
  const data = {
    msKey: msKeyInput.value.trim(),
    msRegion: msRegionInput.value.trim() || DEFAULTS.msRegion,
  };
  chrome.storage.sync.set(data, flashSaved);
}

// input 即时保存；blur 时再补一次（处理 paste 后未触发 input 的边角）
msKeyInput.addEventListener("input", persist);
msKeyInput.addEventListener("change", persist);
msRegionInput.addEventListener("input", persist);
msRegionInput.addEventListener("change", persist);

msTestBtn.addEventListener("click", () => {
  msTestStatus.textContent = "测试中…";
  msTestStatus.className = "test-status";
  // 确保最新输入已落盘
  chrome.storage.sync.set(
    {
      msKey: msKeyInput.value.trim(),
      msRegion: msRegionInput.value.trim() || DEFAULTS.msRegion,
    },
    () => {
      chrome.runtime.sendMessage(
        {
          type: "translate",
          provider: "microsoft",
          text: "Hello, world.",
          targetLang: "zh-CN",
        },
        (resp) => {
          if (chrome.runtime.lastError) {
            msTestStatus.textContent = "失败：" + chrome.runtime.lastError.message;
            msTestStatus.className = "test-status err";
            return;
          }
          if (resp && resp.ok) {
            msTestStatus.textContent = `✓ ${resp.translated}`;
            msTestStatus.className = "test-status ok";
          } else {
            msTestStatus.textContent = "失败：" + ((resp && resp.error) || "未知错误");
            msTestStatus.className = "test-status err";
          }
        }
      );
    }
  );
});
