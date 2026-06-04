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
  // 最终生效偏好（= 全局基线 ⊕ 命中的站点规则）。下方代码统一读这些变量。
  let targetLang = DEFAULT_TARGET;
  let provider = "google";
  let style = "default";
  let observerEnabled = true;
  let hoverKey = "alt"; // alt | ctrl | shift | off
  let inputTranslate = "off"; // off | space3
  let inputSourceLang = "auto"; // 输入框翻译的源语言；auto 让 provider 自动识别
  let inputTargetLang = "en"; // 输入框翻译的目标语言（默认 en：用户写中文 → 英文）
  let selectionTranslate = "off"; // off | button | auto

  // 全局基线偏好（来自 popup / 设置页 / toggle 消息）。站点规则按 hostname 命中后覆盖到上面的 let 变量。
  const basePrefs = {
    targetLang: DEFAULT_TARGET,
    provider: "google",
    style: "default",
    observerEnabled: true,
    hoverKey: "alt",
    inputTranslate: "off",
    inputSourceLang: "auto",
    inputTargetLang: "en",
    selectionTranslate: "off",
  };
  const PREF_KEYS = Object.keys(basePrefs);
  let siteRules = [];

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

  // 返回 { text, dict }。dict 仅在 opts.wantDict 且 provider 返回时存在（例如选区命中单词）。
  // opts: { targetLang?, sourceLang?, wantDict? }
  // targetLang/sourceLang 不传则用全局 targetLang / "auto"。
  function translateRemote(text, opts) {
    const o = opts || {};
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "translate",
          text,
          targetLang: o.targetLang || targetLang,
          sourceLang: o.sourceLang || "auto",
          provider,
          wantDict: !!o.wantDict,
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

    translateRemote(text, { targetLang: inputTargetLang, sourceLang: inputSourceLang })
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

  // —— 生词本（收藏星标）————————————————————————————————————
  // 划词气泡显示后挂一个 ☆/★ 按钮，点击或按 S 键收藏 / 取消收藏。
  // 数据走 background → vocab.js（IndexedDB），content.js 不直接持久化。

  const VOCAB_MAX_WORD_LEN = 200;

  function vocabCheckRemote(word, tgtLang) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "vocab-check", word, targetLang: tgtLang },
        (resp) => {
          if (chrome.runtime.lastError) return resolve({ exists: false });
          resolve(resp && resp.ok ? { exists: !!resp.exists, id: resp.id || null } : { exists: false });
        }
      );
    });
  }

  function vocabAddRemote(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "vocab-add", payload }, (resp) => {
        if (chrome.runtime.lastError) return resolve({ ok: false });
        resolve(resp || { ok: false });
      });
    });
  }

  function vocabRemoveRemote(word, tgtLang) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "vocab-remove-by-word", word, targetLang: tgtLang },
        (resp) => {
          if (chrome.runtime.lastError) return resolve({ ok: false });
          resolve(resp || { ok: false });
        }
      );
    });
  }

  function isVocabEligible(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < 1) return false;
    if (t.length > VOCAB_MAX_WORD_LEN) return false;
    return true;
  }

  // 选区上下文：取选区所在块 textContent，向两侧扩到最近的句末标点（含中英）/ 换行，截出整句。
  // 兜底：句子过长（> CTX_MAX 字符，如代码块 / 无标点长段落）退化为选区前后等额窗口。
  // 跨节点 / Shadow Root / 富文本失败时回退空字符串，不让收藏功能崩。
  // 用户可在设置页生词本面板里事后改写。
  const SENT_END_RE = /[.!?。！？；;]/;
  const CTX_MAX = 800;

  function extractSelectionContext(text) {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return "";
      const range = sel.getRangeAt(0);
      let anchor = range.startContainer;
      if (anchor && anchor.nodeType === 3) anchor = anchor.parentElement;
      if (!anchor || typeof anchor.closest !== "function") return "";
      const block = anchor.closest(BLOCK_SELECTOR) || anchor.closest("body") || anchor;
      const full = (block && block.textContent) || "";
      const idx = full.indexOf(text);
      if (idx < 0) return "";
      const selEnd = idx + text.length;

      // 向左找句首：扫选区前一个字符往回走，遇到句末标点 / 换行就停
      let left = idx;
      while (left > 0) {
        const ch = full[left - 1];
        if (ch === "\n" || SENT_END_RE.test(ch)) break;
        left--;
      }
      // 跳过句首前的空白（例如 "...end. <space>Word"）
      while (left < idx && /\s/.test(full[left])) left++;

      // 向右找句末：扫选区末，找到句末标点就停（含标点本身）
      let right = selEnd;
      while (right < full.length) {
        const ch = full[right];
        if (ch === "\n") break;
        right++;
        if (SENT_END_RE.test(ch)) break;
      }

      // 长度兜底：长段落 / 代码块没有标点时不要吞掉整块
      if (right - left > CTX_MAX) {
        const halfBudget = Math.max(40, Math.floor((CTX_MAX - text.length) / 2));
        left = Math.max(0, idx - halfBudget);
        right = Math.min(full.length, selEnd + halfBudget);
      }

      let snip = full.slice(left, right).replace(/\s+/g, " ").trim();
      if (left > 0) snip = "…" + snip;
      if (right < full.length) snip = snip + "…";
      return snip;
    } catch (_) {
      return "";
    }
  }

  function makeStarButton(bubble, floating) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "itl-sel-star" + (floating ? " itl-sel-star-floating" : "");
    btn.title = "收藏到生词本（按 S）";
    btn.textContent = "☆";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleVocabStar(bubble);
    });
    btn.addEventListener("mousedown", (e) => {
      // 防止冒泡到 document mousedown 触发 hideSelectionBubble
      e.stopPropagation();
    });
    return btn;
  }

  function setStarVisual(btn, starred) {
    if (!btn) return;
    btn.classList.toggle("starred", !!starred);
    btn.textContent = starred ? "★" : "☆";
    btn.title = starred ? "已收藏（点击移除，或按 S）" : "收藏到生词本（按 S）";
  }

  // 调用时机：translateRemote 成功后，气泡内容已渲染完。
  function attachStarToBubble(bubble) {
    const meta = bubble.__itlVocab;
    if (!meta || !meta.eligible) return;
    let btn;
    const headRow = bubble.querySelector(".itl-sel-headword-row");
    if (headRow) {
      // 词典模式：插到 headRow 末尾（与发音按钮同行）
      btn = makeStarButton(bubble, false);
      headRow.appendChild(btn);
    } else {
      // 普通模式：浮在气泡右上角
      btn = makeStarButton(bubble, true);
      bubble.appendChild(btn);
    }
    meta.starBtn = btn;
    setStarVisual(btn, false);
    vocabCheckRemote(meta.word, meta.targetLang).then((r) => {
      if (!bubble.isConnected || meta !== bubble.__itlVocab) return;
      // 用户已经点过就不再被后端检查回填覆盖
      if (meta.userTouched) return;
      meta.starred = !!r.exists;
      setStarVisual(btn, meta.starred);
    });
  }

  function toggleVocabStar(bubble) {
    const meta = bubble && bubble.__itlVocab;
    if (!meta || !meta.eligible) return;
    const btn = meta.starBtn;
    const next = !meta.starred;
    meta.userTouched = true;
    meta.starred = next;
    setStarVisual(btn, next);
    if (next) {
      vocabAddRemote({
        word: meta.word,
        translation: meta.translation,
        sourceLang: meta.sourceLang,
        targetLang: meta.targetLang,
        dict: meta.dict,
        sourceUrl: location.href,
        sourceTitle: document.title,
        context: meta.context,
      }).then((resp) => {
        if (!bubble.isConnected || meta !== bubble.__itlVocab) return;
        if (!resp || !resp.ok) {
          // 回滚视觉
          meta.starred = false;
          setStarVisual(btn, false);
        }
      });
    } else {
      vocabRemoveRemote(meta.word, meta.targetLang).then((resp) => {
        if (!bubble.isConnected || meta !== bubble.__itlVocab) return;
        if (!resp || !resp.ok) {
          meta.starred = true;
          setStarVisual(btn, true);
        }
      });
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

  // 选区是否已经是目标语言：同语种翻译没意义，不必弹气泡。
  // 目前只处理中文目标——目标为 zh 时，若选区里汉字占全部字母的多数则跳过。
  function isSelectionSameAsTarget(text) {
    if (!/^zh/i.test(targetLang)) return false;
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (letters === 0) return false;
    const han = (text.match(/\p{Script=Han}/gu) || []).length;
    return han / letters >= 0.5;
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
    // 上下文要在 selection 还在的时候抓；用户点 "翻译" 按钮后才进这里时 selection 可能已经丢
    const context = extractSelectionContext(text);
    translateRemote(text, { wantDict })
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
        // 生词本元数据 + 星标按钮（仅在词长度合规时挂）
        bubble.__itlVocab = {
          eligible: isVocabEligible(text),
          word: text,
          translation: out,
          dict: (wantDict && result.dict) || null,
          sourceLang: "auto",
          targetLang: targetLang,
          context,
          starred: false,
          starBtn: null,
          userTouched: false,
        };
        attachStarToBubble(bubble);
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

    // headword 行：词 + 可选的「原文 / 译文」发音按钮
    const headRow = document.createElement("div");
    headRow.className = "itl-sel-headword-row";
    const headSpan = document.createElement("span");
    headSpan.className = "itl-sel-headword";
    headSpan.textContent = headword;
    headRow.appendChild(headSpan);
    if (dict.audio && dict.audio.src) {
      headRow.appendChild(makeAudioButton(dict.audio.src, "🔊", "播放原文发音"));
    }
    if (dict.audio && dict.audio.tgt) {
      headRow.appendChild(makeAudioButton(dict.audio.tgt, "🔉", "播放译文发音"));
    }
    bubble.appendChild(headRow);

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

    if (Array.isArray(dict.wordforms) && dict.wordforms.length) {
      append("itl-sel-section-title", "词形");
      for (const wf of dict.wordforms) append("itl-sel-wordform", wf);
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

  function makeAudioButton(url, icon, title) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "itl-sel-audio";
    btn.textContent = icon;
    btn.title = title;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      playAudio(url);
    });
    return btn;
  }

  // 走 background 代理：Google translate_tts 会拒绝带第三方页面 Referer 的 <audio> 请求，
  // 把音频 fetch 放到 SW，转 base64 data URL 后本地解码，绕过所有 origin / Referer / 页面 CSP 限制。
  function playAudio(url) {
    chrome.runtime.sendMessage({ type: "audio", url }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn("[ITL] audio msg err:", chrome.runtime.lastError.message);
        playDirect(url);
        return;
      }
      if (resp && resp.ok && resp.dataUrl) {
        new Audio(resp.dataUrl).play().catch((err) => console.warn("[ITL] audio play failed:", err));
      } else {
        console.warn("[ITL] audio proxy failed:", resp && resp.error);
        playDirect(url);
      }
    });
  }

  // fallback：极端情况下 background 代理失败时直接试一下，受页面 CSP 限制可能也会失败
  function playDirect(url) {
    try {
      new Audio(url).play().catch((err) => console.warn("[ITL] direct audio play failed:", err));
    } catch (e) {
      console.warn("[ITL] direct audio init failed:", e);
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
      // 选区已是目标语言（如目标中文、选的也是中文）就别弹气泡
      if (isSelectionSameAsTarget(info.text)) return;
      showSelectionBubble(info, e);
    }, 0);
  }

  function onSelectionKeyDown(e) {
    if (e.key === "Escape" && selectionBubble) {
      hideSelectionBubble();
      return;
    }
    // S 键：气泡可见时切换收藏。要躲开 IME / 输入框 / 系统快捷键
    if ((e.key === "s" || e.key === "S") && selectionBubble) {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && editableKind(t)) return;
      const meta = selectionBubble.__itlVocab;
      if (!meta || !meta.eligible) return;
      e.preventDefault();
      e.stopPropagation();
      toggleVocabStar(selectionBubble);
    }
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

  // —— 站点规则 ————————————————————————————————————————————————

  // 单条规则形如 { id, pattern, enabled, [overridable pref keys] }。
  // 仅当某偏好 key 存在于规则对象时才视为覆盖；不存在 / 空串视为"继承全局"。
  function matchesHost(host, pattern) {
    if (!host || !pattern) return false;
    host = host.toLowerCase();
    pattern = String(pattern).toLowerCase().trim();
    if (!pattern) return false;
    if (pattern.startsWith("*.")) {
      const tail = pattern.slice(2);
      return host === tail || host.endsWith("." + tail);
    }
    return host === pattern || host.endsWith("." + pattern);
  }

  // 最长 pattern 优先（intuition: 更精确的规则胜过宽泛的）
  function pickRule(rules, host) {
    if (!Array.isArray(rules) || !host) return null;
    let best = null;
    let bestLen = -1;
    for (const r of rules) {
      if (!r || r.enabled === false || !r.pattern) continue;
      if (!matchesHost(host, r.pattern)) continue;
      const len = String(r.pattern).length;
      if (len > bestLen) { best = r; bestLen = len; }
    }
    return best;
  }

  function computeEffective() {
    const rule = pickRule(siteRules, location.hostname);
    const out = { ...basePrefs };
    if (rule) {
      for (const k of PREF_KEYS) {
        if (!(k in rule)) continue;
        const v = rule[k];
        if (v === undefined || v === null || v === "") continue;
        out[k] = v;
      }
    }
    return out;
  }

  // 站点规则或基线偏好变化时调用：写回模块顶部的生效变量 + 必要时刷新监听器 / 样式 / observer。
  function recomputeEffective() {
    const eff = computeEffective();
    const prevStyle = style;
    const prevObserver = observerEnabled;

    targetLang = eff.targetLang;
    provider = eff.provider;
    style = eff.style;
    observerEnabled = !!eff.observerEnabled;
    hoverKey = eff.hoverKey;
    inputTranslate = eff.inputTranslate;
    inputSourceLang = eff.inputSourceLang;
    inputTargetLang = eff.inputTargetLang;
    selectionTranslate = eff.selectionTranslate;

    if (prevStyle !== style) refreshExistingStyles();
    refreshHoverListener();
    refreshSelectionListener();
    refreshInputListener();
    if (isOn && prevObserver !== observerEnabled) {
      if (observerEnabled) startObserver();
      else stopObserver();
    }
  }

  // —— 偏好读取 / 变更同步 ————————————————————————————————————

  // 把 popup / 设置页 / toggle 消息里的字段写进基线（带类型校验），不直接动生效变量。
  function applyPrefs(p) {
    if (!p) return;
    for (const k of PREF_KEYS) {
      if (!(k in p)) continue;
      const v = p[k];
      if (k === "observerEnabled") {
        if (typeof v === "boolean") basePrefs[k] = v;
      } else if (typeof v === "string") {
        basePrefs[k] = v;
      }
    }
  }

  chrome.storage.sync.get([...PREF_KEYS, "siteRules"], (res) => {
    applyPrefs(res);
    if (Array.isArray(res.siteRules)) siteRules = res.siteRules;
    recomputeEffective();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let touched = false;
    const patch = {};
    for (const k of PREF_KEYS) {
      if (k in changes) { patch[k] = changes[k].newValue; touched = true; }
    }
    if (touched) applyPrefs(patch);
    if ("siteRules" in changes) {
      siteRules = Array.isArray(changes.siteRules.newValue) ? changes.siteRules.newValue : [];
      touched = true;
    }
    if (touched) recomputeEffective();
  });

  // —— 来自 popup / 快捷键的消息 ————————————————————————————

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "toggle") {
      applyPrefs(msg);
      recomputeEffective();
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
