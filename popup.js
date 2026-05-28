// popup.js
const langSel = document.getElementById("lang");
const goBtn = document.getElementById("go");

// 恢复上次选择的语言
chrome.storage.sync.get(["targetLang"], (res) => {
  if (res.targetLang) langSel.value = res.targetLang;
});

goBtn.addEventListener("click", async () => {
  const lang = langSel.value;
  chrome.storage.sync.set({ targetLang: lang });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  chrome.tabs.sendMessage(tab.id, { type: "toggle", targetLang: lang }, (resp) => {
    if (chrome.runtime.lastError) {
      // 内容脚本未注入（多为安装前已打开的页面）
      goBtn.textContent = "请刷新页面后重试";
      setTimeout(() => (goBtn.textContent = "翻译 / 还原"), 1800);
      return;
    }
    goBtn.textContent = resp && resp.state === "on" ? "还原原文" : "翻译页面";
    setTimeout(() => (goBtn.textContent = "翻译 / 还原"), 1500);
  });
});
