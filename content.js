// content.js —— 注入到网页中的核心逻辑
(function () {
  const DEFAULT_TARGET = "zh-CN";
  const PROCESSED = "data-itl-done"; // 标记已处理的元素，避免重复翻译
  const CONCURRENCY = 4; // 同时发起的翻译请求数（太高容易被接口限流）

  let isOn = false; // 当前页面是否已开启翻译

  // 作为“翻译单元”的块级元素。选叶子节点，避免父子重复翻译。
  const BLOCK_SELECTOR =
    "p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption, td, caption";

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== "BODY") {
      // 粗略判断：不可见或脱离文档流的跳过
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
    }
    return true;
  }

  // 收集需要翻译的元素
  function collect() {
    const all = Array.from(document.querySelectorAll(BLOCK_SELECTOR));
    return all.filter((el) => {
      if (el.hasAttribute(PROCESSED)) return false;
      if (el.closest(".itl-translation")) return false; // 不翻译译文本身
      // 若内部还含有别的块级候选，则只翻译更内层的，避免重复
      if (el.querySelector(BLOCK_SELECTOR)) return false;
      if (!isVisible(el)) return false;
      const text = (el.innerText || "").trim();
      if (text.length < 2) return false;
      return true;
    });
  }

  // 通过后台 Service Worker 翻译
  function translate(text, targetLang) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "translate", text, targetLang },
        (resp) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          if (resp && resp.ok) resolve(resp.translated);
          else reject(new Error((resp && resp.error) || "translate failed"));
        }
      );
    });
  }

  // 把译文作为子节点插到原文下方
  function appendTranslation(el, text) {
    const node = document.createElement("div");
    node.className = "itl-translation";
    node.textContent = text;
    el.appendChild(node);
  }

  // 简单的并发工作线程
  async function worker(queue, targetLang) {
    while (queue.length) {
      const el = queue.shift();
      if (!el) break;
      el.setAttribute(PROCESSED, "1");
      const text = el.innerText.trim();
      try {
        const out = await translate(text, targetLang);
        if (out && out.trim() && out.trim() !== text) {
          appendTranslation(el, out);
        }
      } catch (e) {
        console.warn("[ITL] 翻译失败：", e);
      }
    }
  }

  async function run(targetLang) {
    const elements = collect();
    const queue = [...elements];
    const workers = Array.from({ length: CONCURRENCY }, () =>
      worker(queue, targetLang)
    );
    await Promise.all(workers);
  }

  // 关闭翻译：移除所有译文，清除标记
  function removeAll() {
    document.querySelectorAll(".itl-translation").forEach((n) => n.remove());
    document
      .querySelectorAll("[" + PROCESSED + "]")
      .forEach((n) => n.removeAttribute(PROCESSED));
  }

  // 监听来自弹窗的开关指令
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "toggle") {
      if (isOn) {
        removeAll();
        isOn = false;
        sendResponse({ state: "off" });
      } else {
        isOn = true;
        run(msg.targetLang || DEFAULT_TARGET);
        sendResponse({ state: "on" });
      }
    }
  });
})();
