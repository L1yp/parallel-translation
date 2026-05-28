// content.js —— 注入到网页中的核心逻辑
// 职责：DOM 遍历 / 可见性过滤 / 并发调度 / 译文插入 / 动态内容监听 / 悬停翻译 / 词对齐高亮。
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

  // 保存原文被切 span 之前的 childNodes，供 turnOff() 还原
  const originalChildren = new WeakMap();

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
          if (resp && resp.ok) resolve({ text: resp.translated, alignment: resp.alignment });
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

  // —— 词对齐 span 构建 ————————————————————————————————————————

  // 把字符串按 alignment 切成 [textNode | span] 序列，挂 data-itl-group。
  // side: "src" 或 "tgt"，决定取 srcStart/srcEnd 还是 tgtStart/tgtEnd。
  // 微软返回的索引为 inclusive 端点；统一转为 [start, endExclusive) 处理。
  function buildAlignedFragment(text, alignment, side, groupPrefix) {
    const keyStart = side === "src" ? "srcStart" : "tgtStart";
    const keyEnd = side === "src" ? "srcEnd" : "tgtEnd";
    const len = text.length;

    // 收集切片边界点
    const points = new Set([0, len]);
    alignment.forEach((a) => {
      const s = Math.max(0, Math.min(len, a[keyStart]));
      const e = Math.max(0, Math.min(len, a[keyEnd] + 1)); // inclusive -> exclusive
      points.add(s);
      points.add(e);
    });
    const sorted = [...points].sort((a, b) => a - b);

    const frag = document.createDocumentFragment();
    for (let i = 0; i < sorted.length - 1; i++) {
      const s = sorted[i];
      const e = sorted[i + 1];
      if (s >= e) continue;
      const slice = text.slice(s, e);
      if (!slice) continue;

      // 找出覆盖 [s, e) 的所有 alignment id
      const groups = [];
      alignment.forEach((a, idx) => {
        const as = a[keyStart];
        const ae = a[keyEnd] + 1; // exclusive
        if (as <= s && ae >= e) groups.push(groupPrefix + idx);
      });

      if (groups.length) {
        const span = document.createElement("span");
        span.className = "itl-tok";
        // 用空格分隔多 group，方便 CSS attribute selector ~= 命中
        span.setAttribute("data-itl-group", groups.join(" "));
        span.setAttribute("data-itl-side", side);
        span.textContent = slice;
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(slice));
      }
    }
    return frag;
  }

  // 判断 el 是否纯文本（不含 element 子节点）——只有这种 el 才能安全地拆 span 重建。
  function isPureTextElement(el) {
    return el.children.length === 0;
  }

  // —— 译文插入 ——————————————————————————————————————————————

  // 一组全局递增的 group id 前缀，避免不同段之间互相误命中
  let groupSeq = 0;

  function appendTranslation(el, srcTextNormalized, result) {
    const tgtText = result.text || "";
    const alignment = result.alignment;

    const node = document.createElement("div");
    node.className = "itl-translation";
    const cls = currentStyleClass();
    if (cls) node.classList.add(cls);

    const useAlignment = !!(alignment && alignment.length);
    if (useAlignment) {
      const prefix = "g" + (groupSeq++) + "-";
      node.appendChild(buildAlignedFragment(tgtText, alignment, "tgt", prefix));

      // 原文也尝试切 span（仅当 el 是纯文本，不破坏内嵌格式）
      if (isPureTextElement(el)) {
        // 保存原始 childNodes 以便 turnOff 还原
        originalChildren.set(el, Array.from(el.childNodes).map((n) => n.cloneNode(true)));
        while (el.firstChild) el.removeChild(el.firstChild);
        el.appendChild(buildAlignedFragment(srcTextNormalized, alignment, "src", prefix));
      }
    } else {
      node.textContent = tgtText;
    }

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
        const result = await translateRemote(text);
        const out = (result.text || "").trim();
        if (out && out !== text) {
          appendTranslation(el, text, result);
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

    // 1) 移除所有译文节点
    document.querySelectorAll(".itl-translation").forEach((n) => n.remove());

    // 2) 还原被切过 span 的原文节点
    document.querySelectorAll("[" + PROCESSED + "]").forEach((el) => {
      const orig = originalChildren.get(el);
      if (orig) {
        while (el.firstChild) el.removeChild(el.firstChild);
        orig.forEach((n) => el.appendChild(n));
        originalChildren.delete(el);
      }
      el.removeAttribute(PROCESSED);
    });
  }

  // —— 词对齐高亮联动 ————————————————————————————————————————

  function clearActive() {
    document.querySelectorAll(".itl-tok-active").forEach((s) =>
      s.classList.remove("itl-tok-active")
    );
  }

  function activateGroup(tok) {
    const groups = (tok.getAttribute("data-itl-group") || "").split(/\s+/).filter(Boolean);
    if (!groups.length) return;
    // group id 是全局唯一的（带 segment 前缀），整页查询即可
    groups.forEach((g) => {
      // CSS.escape 防止特殊字符干扰；这里 id 简单（g\d+-\d+）实际不需要
      const safe = (window.CSS && CSS.escape) ? CSS.escape(g) : g;
      document
        .querySelectorAll('.itl-tok[data-itl-group~="' + safe + '"]')
        .forEach((s) => s.classList.add("itl-tok-active"));
    });
  }

  function onTokOver(e) {
    const tok = e.target && e.target.closest && e.target.closest(".itl-tok");
    clearActive();
    if (tok) activateGroup(tok);
  }
  document.addEventListener("mouseover", onTokOver, true);

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
    translateRemote(text)
      .then((result) => {
        const out = (result.text || "").trim();
        if (out && out !== text) {
          appendTranslation(block, text, result);
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
