// content.js —— 注入到网页中的核心逻辑
// 职责：DOM 遍历 / 可见性过滤 / 并发调度 / 译文插入 / 动态内容监听 / 悬停翻译。
// 所有 DOM 操作集中在此，背景脚本只负责 fetch 与敏感配置注入。

(function () {
  const DEFAULT_TARGET = "zh-CN";
  const PROCESSED = "data-itl-done";
  const CONCURRENCY = 4;            // 共享同一个队列；提高会触发 Google 限流
  const OBSERVER_DEBOUNCE = 300;    // 动态内容去抖，避免 Twitter/Reddit 之类高频 mutate 打爆接口
  const HOVER_THROTTLE = 80;        // 悬停 hit-test 节流
  const STYLE_CLASSES = ["itl-style-underline", "itl-style-blur", "itl-style-bold", "itl-style-card"];

  let isOn = false;
  let targetLang = DEFAULT_TARGET;
  let provider = "google";
  let style = "default";
  let observerEnabled = true;
  let hoverKey = "alt"; // alt | ctrl | shift | off

  // 作为"翻译单元"的块级元素。选叶子节点，避免父子重复翻译。
  const BLOCK_SELECTOR =
    "p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption, td, caption";

  // —— 工具函数 ——————————————————————————————————————————————

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== "BODY") {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
    }
    return true;
  }

  function isLeafBlock(el) {
    if (!el || !el.isConnected) return false;
    if (el.hasAttribute(PROCESSED)) return false;
    if (el.closest(".itl-translation")) return false;
    if (el.querySelector(BLOCK_SELECTOR)) return false;
    if (!isVisible(el)) return false;
    const text = (el.innerText || "").trim();
    if (text.length < 2) return false;
    return true;
  }

  function collect(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const all = Array.from(scope.querySelectorAll(BLOCK_SELECTOR));
    return all.filter(isLeafBlock);
  }

  function translateRemote(text) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "translate", text, targetLang, provider },
        (resp) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          if (resp && resp.ok) resolve(resp.translated);
          else reject(new Error((resp && resp.error) || "translate failed"));
        }
      );
    });
  }

  function currentStyleClass() {
    return style && style !== "default" ? "itl-style-" + style : "";
  }

  function refreshExistingStyles() {
    const desired = currentStyleClass();
    document.querySelectorAll(".itl-translation").forEach((n) => {
      STYLE_CLASSES.forEach((c) => n.classList.remove(c));
      if (desired) n.classList.add(desired);
    });
  }

  // —— 译文插入 ——————————————————————————————————————————————

  function appendTranslation(el, tgtText) {
    const node = document.createElement("div");
    node.className = "itl-translation";
    const cls = currentStyleClass();
    if (cls) node.classList.add(cls);
    node.textContent = tgtText;
    el.appendChild(node);
  }

  // —— 并发队列 ——————————————————————————————————————————————

  const queue = [];
  let activeWorkers = 0;

  async function workerLoop() {
    while (queue.length) {
      const el = queue.shift();
      if (!el || !el.isConnected) continue;
      if (el.hasAttribute(PROCESSED)) continue;
      // 立刻标记，防止 observer 在 await 期间把同一节点重新入队
      el.setAttribute(PROCESSED, "1");
      const text = (el.innerText || "").trim();
      if (text.length < 2) continue;
      try {
        const translated = await translateRemote(text);
        const out = (translated || "").trim();
        if (out && out !== text) {
          appendTranslation(el, translated);
        }
      } catch (e) {
        // 单段失败不打断队列（Google 免费接口经常限流；Microsoft 配置错也只是这段失败）
        console.warn("[ITL] 翻译失败：", e);
      }
    }
    activeWorkers--;
  }

  function enqueue(elements) {
    if (!elements.length) return;
    queue.push(...elements);
    while (activeWorkers < CONCURRENCY && queue.length) {
      activeWorkers++;
      workerLoop();
    }
  }

  // —— MutationObserver ——————————————————————————————————————

  let observer = null;
  let observerTimer = null;

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(() => {
      if (observerTimer) return;
      observerTimer = setTimeout(() => {
        observerTimer = null;
        if (!isOn) return;
        enqueue(collect(document));
      }, OBSERVER_DEBOUNCE);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (observerTimer) {
      clearTimeout(observerTimer);
      observerTimer = null;
    }
  }

  // —— 整页翻译 / 还原 ————————————————————————————————————————

  function turnOn() {
    isOn = true;
    enqueue(collect(document));
    if (observerEnabled) startObserver();
  }

  function turnOff() {
    isOn = false;
    stopObserver();
    queue.length = 0;
    document.querySelectorAll(".itl-translation").forEach((n) => n.remove());
    document.querySelectorAll("[" + PROCESSED + "]").forEach((el) => {
      el.removeAttribute(PROCESSED);
    });
  }

  // —— 悬停翻译 ——————————————————————————————————————————————

  let hoverThrottled = false;
  let lastHoverEl = null;

  function onMouseMove(e) {
    if (hoverKey === "off") return;
    const pressed =
      (hoverKey === "alt" && e.altKey) ||
      (hoverKey === "ctrl" && e.ctrlKey) ||
      (hoverKey === "shift" && e.shiftKey);
    if (!pressed) {
      lastHoverEl = null;
      return;
    }
    if (hoverThrottled) return;
    hoverThrottled = true;
    setTimeout(() => { hoverThrottled = false; }, HOVER_THROTTLE);

    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (!hit) return;
    const block = hit.closest(BLOCK_SELECTOR);
    if (!block || block === lastHoverEl) return;
    lastHoverEl = block;
    if (!isLeafBlock(block)) return;

    block.setAttribute(PROCESSED, "1");
    const text = (block.innerText || "").trim();
    if (text.length < 2) return;
    translateRemote(text)
      .then((translated) => {
        const out = (translated || "").trim();
        if (out && out !== text) {
          appendTranslation(block, translated);
        }
      })
      .catch((err) => console.warn("[ITL hover] 翻译失败：", err));
  }

  let hoverListenerAttached = false;
  function refreshHoverListener() {
    const wantListener = hoverKey !== "off";
    if (wantListener && !hoverListenerAttached) {
      document.addEventListener("mousemove", onMouseMove, true);
      hoverListenerAttached = true;
    } else if (!wantListener && hoverListenerAttached) {
      document.removeEventListener("mousemove", onMouseMove, true);
      hoverListenerAttached = false;
    }
  }

  // —— 偏好读取 / 变更同步 ————————————————————————————————————

  function applyPrefs(p) {
    if (!p) return;
    if (typeof p.targetLang === "string") targetLang = p.targetLang;
    if (typeof p.provider === "string") provider = p.provider;
    if (typeof p.style === "string") style = p.style;
    if (typeof p.observerEnabled === "boolean") observerEnabled = p.observerEnabled;
    if (typeof p.hoverKey === "string") hoverKey = p.hoverKey;
  }

  chrome.storage.sync.get(
    ["targetLang", "provider", "style", "observerEnabled", "hoverKey"],
    (res) => {
      applyPrefs(res);
      refreshHoverListener();
    }
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.targetLang) targetLang = changes.targetLang.newValue;
    if (changes.provider) provider = changes.provider.newValue;
    if (changes.hoverKey) {
      hoverKey = changes.hoverKey.newValue;
      refreshHoverListener();
    }
    if (changes.style) {
      style = changes.style.newValue;
      refreshExistingStyles();
    }
    if (changes.observerEnabled) {
      observerEnabled = changes.observerEnabled.newValue;
      if (isOn) {
        if (observerEnabled) startObserver();
        else stopObserver();
      }
    }
  });

  // —— 来自 popup / 快捷键的消息 ————————————————————————————

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "toggle") {
      applyPrefs(msg);
      refreshHoverListener();
      if (isOn) {
        turnOff();
        sendResponse({ state: "off" });
      } else {
        turnOn();
        sendResponse({ state: "on" });
      }
    } else if (msg.type === "ping") {
      sendResponse({ state: isOn ? "on" : "off" });
    }
  });
})();
