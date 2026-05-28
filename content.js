// content.js —— 注入到网页中的核心逻辑
// 职责：DOM 遍历 / 可见性过滤 / 并发调度 / 译文插入 / 动态内容监听 / 悬停翻译 / 输入框三击空格翻译 / 划词翻译气泡。
// 所有 DOM 操作集中在此，背景脚本只负责 fetch 与敏感配置注入。

(function () {
  const DEFAULT_TARGET = "zh-CN";
  const PROCESSED = "data-itl-done";
  const CONCURRENCY = 4;            // 共享同一个队列；提高会触发 Google 限流
  const OBSERVER_DEBOUNCE = 300;    // 动态内容去抖，避免 Twitter/Reddit 之类高频 mutate 打爆接口
  const HOVER_THROTTLE = 80;        // 悬停 hit-test 节流
  const SPACE_TRIPLE_WINDOW = 700;  // 输入框三击空格的最大间隔（毫秒）
  const STYLE_CLASSES = ["itl-style-underline", "itl-style-blur", "itl-style-bold", "itl-style-card"];
  const INPUT_TYPES = new Set(["text", "search", "email", "url", "tel"]);

  let isOn = false;
  let targetLang = DEFAULT_TARGET;
  let provider = "google";
  let style = "default";
  let observerEnabled = true;
  let hoverKey = "alt"; // alt | ctrl | shift | off
  let inputTranslate = "off"; // off | space3
  let inputTargetLang = "en"; // 输入框翻译的目标语言（默认 en：用户写中文 → 英文）
  let selectionTranslate = "off"; // off | button | auto

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

  // 返回 { text, dict }。dict 仅在 wantDict 且 provider 返回时存在（例如选区命中单词）。
  function translateRemote(text, overrideTargetLang, wantDict) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "translate",
          text,
          targetLang: overrideTargetLang || targetLang,
          provider,
          wantDict: !!wantDict,
        },
        (resp) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          if (resp && resp.ok) resolve({ text: resp.translated || "", dict: resp.dict || null });
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

  // 悬停翻译的中间态：先插占位 + spinner，请求回来再替换内容
  function appendLoading(el) {
    const node = document.createElement("div");
    node.className = "itl-translation itl-loading";
    const cls = currentStyleClass();
    if (cls) node.classList.add(cls);
    node.textContent = "翻译中";
    const dot = document.createElement("span");
    dot.className = "itl-spinner";
    node.appendChild(dot);
    el.appendChild(node);
    return node;
  }

  function finalizeLoading(node, tgtText) {
    node.classList.remove("itl-loading");
    node.textContent = tgtText;
  }

  function showLoadingError(node, err) {
    node.classList.remove("itl-loading");
    node.classList.add("itl-error");
    const msg = (err && err.message) ? err.message : "未知错误";
    node.textContent = "翻译失败：" + msg;
    setTimeout(() => {
      if (node.isConnected) node.remove();
    }, 3000);
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
          appendTranslation(el, result.text);
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

    const placeholder = appendLoading(block);

    translateRemote(text)
      .then((result) => {
        const out = (result.text || "").trim();
        if (out && out !== text) {
          finalizeLoading(placeholder, result.text);
        } else {
          placeholder.remove();
        }
      })
      .catch((err) => {
        console.warn("[ITL hover] 翻译失败：", err);
        showLoadingError(placeholder, err);
        // 失败后允许用户再次悬停重试
        block.removeAttribute(PROCESSED);
        if (lastHoverEl === block) lastHoverEl = null;
      });
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

  // —— 输入框翻译（三击空格）——————————————————————————————

  // 用 WeakMap 按元素维护计数，避免在 detached 元素上泄漏
  const tripleSpaceMap = new WeakMap();

  function editableKind(el) {
    if (!el) return null;
    if (el.tagName === "TEXTAREA") return "textarea";
    if (el.tagName === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      return INPUT_TYPES.has(t) ? "input" : null;
    }
    if (el.isContentEditable) return "contenteditable";
    return null;
  }

  function onInputKeyDown(e) {
    if (inputTranslate !== "space3") return;
    // 中文/日文等 IME 合成中（拼音的空格选词），不能拦截
    if (e.isComposing || e.keyCode === 229) return;
    const target = e.target;
    const kind = editableKind(target);
    if (!kind) return;

    if (e.key !== " ") {
      tripleSpaceMap.delete(target);
      return;
    }

    const now = Date.now();
    const state = tripleSpaceMap.get(target) || { count: 0, lastTime: 0 };
    if (now - state.lastTime > SPACE_TRIPLE_WINDOW) {
      state.count = 1;
    } else {
      state.count += 1;
    }
    state.lastTime = now;
    tripleSpaceMap.set(target, state);

    if (state.count >= 3) {
      // 拦掉第 3 个空格；前两个已经写进 value，需要在取文本时剥掉
      e.preventDefault();
      tripleSpaceMap.delete(target);
      handleInputTranslate(target, kind);
    }
  }

  function readEditableText(target, kind) {
    const raw = kind === "contenteditable"
      ? (target.textContent || "")
      : (target.value || "");
    // 触发时 value/textContent 末尾刚好挂着 2 个空格，剥掉
    return raw.replace(/ {1,2}$/, "");
  }

  // input/textarea 用原生 setter，绕过 React/Vue 的"值未变"短路
  function writeInputValue(target, value) {
    const proto = target.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    if (typeof target.setSelectionRange === "function") {
      try { target.setSelectionRange(value.length, value.length); } catch (_) {}
    }
  }

  function writeContentEditable(target, value) {
    target.textContent = value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    try {
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
  }

  function applyTranslatedToInput(target, kind, value) {
    if (kind === "contenteditable") writeContentEditable(target, value);
    else writeInputValue(target, value);
  }

  function makeInputTip(target, text, variant) {
    const tip = document.createElement("div");
    tip.className = "itl-input-tip itl-input-" + variant;
    tip.textContent = text;
    document.body.appendChild(tip);
    positionInputTip(tip, target);
    return tip;
  }

  function positionInputTip(tip, target) {
    if (!target.isConnected) return;
    const rect = target.getBoundingClientRect();
    tip.style.left = Math.round(rect.left) + "px";
    tip.style.top = Math.round(rect.bottom + 4) + "px";
  }

  function updateInputTip(tip, text, variant) {
    tip.textContent = text;
    tip.classList.remove("itl-input-loading", "itl-input-success", "itl-input-error");
    tip.classList.add("itl-input-" + variant);
  }

  function dismissInputTip(tip, delay) {
    setTimeout(() => {
      if (!tip.isConnected) return;
      tip.classList.add("itl-input-tip-fade");
      setTimeout(() => { if (tip.isConnected) tip.remove(); }, 300);
    }, delay);
  }

  function handleInputTranslate(target, kind) {
    const text = readEditableText(target, kind).trim();
    if (text.length < 2) return;

    const tip = makeInputTip(target, "翻译中…", "loading");

    translateRemote(text, inputTargetLang)
      .then((result) => {
        const out = (result.text || "").trim();
        if (!out || out === text) {
          updateInputTip(tip, "无变化", "success");
          dismissInputTip(tip, 1200);
          return;
        }
        applyTranslatedToInput(target, kind, out);
        positionInputTip(tip, target); // 文本变化后高度可能变，重新定位
        updateInputTip(tip, "已替换", "success");
        dismissInputTip(tip, 1200);
      })
      .catch((err) => {
        console.warn("[ITL input] 翻译失败：", err);
        const msg = (err && err.message) ? err.message : "未知错误";
        updateInputTip(tip, "失败：" + msg, "error");
        dismissInputTip(tip, 2500);
      });
  }

  let inputListenerAttached = false;
  function refreshInputListener() {
    const want = inputTranslate === "space3";
    if (want && !inputListenerAttached) {
      document.addEventListener("keydown", onInputKeyDown, true);
      inputListenerAttached = true;
    } else if (!want && inputListenerAttached) {
      document.removeEventListener("keydown", onInputKeyDown, true);
      inputListenerAttached = false;
    }
  }

  // —— 划词翻译气泡 ——————————————————————————————————————————

  let selectionBubble = null;

  // 从事件路径里找有效 selection：先 Shadow Root（GitHub 评论框等），再顶层 document
  function readSelection(e) {
    const trySel = (sel) => {
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const text = (sel.toString() || "").trim();
      if (!text) return null;
      let rect = null;
      try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (_) {}
      return { text, rect };
    };
    if (e && typeof e.composedPath === "function") {
      for (const node of e.composedPath()) {
        if (node instanceof ShadowRoot && typeof node.getSelection === "function") {
          const r = trySel(node.getSelection());
          if (r) return r;
        }
      }
    }
    return trySel(window.getSelection());
  }

  function inOwnBubble(target) {
    return !!(target && target.closest && target.closest(".itl-selection-bubble"));
  }

  function hideSelectionBubble() {
    if (selectionBubble && selectionBubble.isConnected) selectionBubble.remove();
    selectionBubble = null;
  }

  function positionSelectionBubble(bubble, rect, fallbackXY) {
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      if (!fallbackXY) return;
      rect = { left: fallbackXY.x, top: fallbackXY.y, right: fallbackXY.x, bottom: fallbackXY.y, width: 0, height: 0 };
    }
    const margin = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 让浏览器先按内容宽度量一遍
    bubble.style.left = "0px";
    bubble.style.top = "0px";
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    let left = rect.left + rect.width / 2 - bw / 2;
    let top = rect.top - bh - margin;
    if (top < 4) top = rect.bottom + margin; // 上方放不下就放下方
    left = Math.max(4, Math.min(left, vw - bw - 4));
    top = Math.max(4, Math.min(top, vh - bh - 4));
    bubble.style.left = Math.round(left) + "px";
    bubble.style.top = Math.round(top) + "px";
  }

  // 单词判定：无空格、长度 ≤ 30、至少含一个字母（含 CJK）。命中后请求 wantDict。
  function isSingleWord(text) {
    if (!text || text.length > 30) return false;
    if (/\s/.test(text)) return false;
    if (!/[\p{L}\p{M}]/u.test(text)) return false;
    return true;
  }

  function fetchSelectionTranslation(bubble, text, rect, fallbackXY) {
    const wantDict = isSingleWord(text);
    translateRemote(text, null, wantDict)
      .then((result) => {
        if (!bubble.isConnected) return;
        bubble.classList.remove("itl-selection-loading");
        bubble.classList.add("itl-selection-done");
        const out = (result.text || "").trim();
        if (wantDict && result.dict) {
          renderDictBubble(bubble, text, out, result.dict);
        } else {
          bubble.textContent = out || "（无内容）";
        }
        positionSelectionBubble(bubble, rect, fallbackXY);
      })
      .catch((err) => {
        if (!bubble.isConnected) return;
        bubble.classList.remove("itl-selection-loading");
        bubble.classList.add("itl-selection-error");
        const msg = (err && err.message) ? err.message : "未知错误";
        bubble.textContent = "翻译失败：" + msg;
        positionSelectionBubble(bubble, rect, fallbackXY);
      });
  }

  // 用 textContent 逐节点构建词典视图，避免 innerHTML 在第三方页面引入 XSS 风险
  function renderDictBubble(bubble, headword, translation, dict) {
    bubble.classList.add("itl-selection-dict");
    bubble.textContent = "";

    const append = (cls, txt) => {
      const n = document.createElement("div");
      n.className = cls;
      n.textContent = txt;
      bubble.appendChild(n);
      return n;
    };

    append("itl-sel-headword", headword);

    if (Array.isArray(dict.phonetics) && dict.phonetics.length) {
      const ph = dict.phonetics
        .map((p) => (p.region ? p.region + " " : "") + "/" + p.ipa + "/")
        .join("   ");
      append("itl-sel-phonetic", ph);
    }

    // 没有 explains 时，把主译文作为一行显示
    const hasExplains = Array.isArray(dict.explains) && dict.explains.length;
    if (!hasExplains && translation) {
      append("itl-sel-translation", translation);
    }
    if (hasExplains) {
      for (const e of dict.explains) append("itl-sel-explain", e);
    }

    if (Array.isArray(dict.definitions) && dict.definitions.length) {
      append("itl-sel-section-title", "释义");
      for (const d of dict.definitions) append("itl-sel-definition", d);
    }

    if (Array.isArray(dict.webExplains) && dict.webExplains.length) {
      append("itl-sel-section-title", "网络");
      for (const w of dict.webExplains) {
        append("itl-sel-web", w.key + " — " + w.values.join("；"));
      }
    }

    if (Array.isArray(dict.examples) && dict.examples.length) {
      append("itl-sel-section-title", "例句");
      for (const ex of dict.examples) {
        const wrap = document.createElement("div");
        wrap.className = "itl-sel-example";
        const src = document.createElement("div");
        src.className = "itl-sel-example-src";
        src.textContent = ex.src;
        wrap.appendChild(src);
        if (ex.tgt) {
          const tgt = document.createElement("div");
          tgt.className = "itl-sel-example-tgt";
          tgt.textContent = ex.tgt;
          wrap.appendChild(tgt);
        }
        bubble.appendChild(wrap);
      }
    }
  }

  function showSelectionBubble(info, e) {
    hideSelectionBubble();
    const bubble = document.createElement("div");
    bubble.className = "itl-selection-bubble";
    document.body.appendChild(bubble);
    selectionBubble = bubble;

    const fallbackXY = e ? { x: e.clientX, y: e.clientY } : null;

    if (selectionTranslate === "button") {
      bubble.classList.add("itl-selection-button");
      bubble.textContent = "翻译";
      positionSelectionBubble(bubble, info.rect, fallbackXY);
      bubble.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        bubble.classList.remove("itl-selection-button");
        bubble.classList.add("itl-selection-loading");
        bubble.textContent = "翻译中…";
        positionSelectionBubble(bubble, info.rect, fallbackXY);
        fetchSelectionTranslation(bubble, info.text, info.rect, fallbackXY);
      }, { once: true });
    } else {
      bubble.classList.add("itl-selection-loading");
      bubble.textContent = "翻译中…";
      positionSelectionBubble(bubble, info.rect, fallbackXY);
      fetchSelectionTranslation(bubble, info.text, info.rect, fallbackXY);
    }
  }

  function onSelectionMouseDown(e) {
    if (inOwnBubble(e.target)) return;
    hideSelectionBubble();
  }

  function onSelectionMouseUp(e) {
    if (selectionTranslate === "off") return;
    if (inOwnBubble(e.target)) return;
    // 让浏览器把 selection 落定后再读
    setTimeout(() => {
      const info = readSelection(e);
      if (!info || info.text.length < 2) return;
      showSelectionBubble(info, e);
    }, 0);
  }

  function onSelectionKeyDown(e) {
    if (e.key === "Escape" && selectionBubble) hideSelectionBubble();
  }

  let selectionListenerAttached = false;
  function refreshSelectionListener() {
    const want = selectionTranslate !== "off";
    if (want && !selectionListenerAttached) {
      document.addEventListener("mousedown", onSelectionMouseDown, true);
      document.addEventListener("mouseup", onSelectionMouseUp, true);
      document.addEventListener("keydown", onSelectionKeyDown, true);
      selectionListenerAttached = true;
    } else if (!want && selectionListenerAttached) {
      document.removeEventListener("mousedown", onSelectionMouseDown, true);
      document.removeEventListener("mouseup", onSelectionMouseUp, true);
      document.removeEventListener("keydown", onSelectionKeyDown, true);
      selectionListenerAttached = false;
      hideSelectionBubble();
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
    if (typeof p.inputTranslate === "string") inputTranslate = p.inputTranslate;
    if (typeof p.inputTargetLang === "string") inputTargetLang = p.inputTargetLang;
    if (typeof p.selectionTranslate === "string") selectionTranslate = p.selectionTranslate;
  }

  chrome.storage.sync.get(
    ["targetLang", "provider", "style", "observerEnabled", "hoverKey", "inputTranslate", "inputTargetLang", "selectionTranslate"],
    (res) => {
      applyPrefs(res);
      refreshHoverListener();
      refreshInputListener();
      refreshSelectionListener();
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
    if (changes.inputTranslate) {
      inputTranslate = changes.inputTranslate.newValue;
      refreshInputListener();
    }
    if (changes.inputTargetLang) inputTargetLang = changes.inputTargetLang.newValue;
    if (changes.selectionTranslate) {
      selectionTranslate = changes.selectionTranslate.newValue;
      refreshSelectionListener();
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
      refreshInputListener();
      refreshSelectionListener();
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
