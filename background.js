// background.js —— 后台 Service Worker
// 内容脚本不直接请求翻译接口，而是把文本发到这里，由后台 fetch，
// 这样可以避开部分网页的 CORS 限制，也更容易统一处理。

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "translate") {
    translateText(msg.text, msg.targetLang)
      .then((translated) => sendResponse({ ok: true, translated }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // 异步响应，必须返回 true
  }
});

async function translateText(text, targetLang) {
  // Google 免费翻译接口（非官方）。client=gtx, sl=auto 自动识别源语言, dt=t 取译文
  const url =
    "https://translate.googleapis.com/translate_a/single" +
    "?client=gtx&sl=auto" +
    "&tl=" + encodeURIComponent(targetLang) +
    "&dt=t&q=" + encodeURIComponent(text);

  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);

  // 返回结构：data[0] 是一个数组，每个元素形如 [译文片段, 原文片段, ...]
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) return "";
  return data[0].map((seg) => (seg && seg[0]) || "").join("");
}
