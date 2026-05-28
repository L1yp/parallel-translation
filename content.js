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

  // —— 调试开关 ————————————————————————————————————————————
  // 控制台执行 __itlDebug(true) 开启；__itlDebug(false) 关闭。
  // 开启后每段翻译会打印 alignment 期望子串 vs wrap 后实际 span 内容的对照表。
  let DEBUG = false;
  window.__itlDebug = function (v) {
    DEBUG = v !== false;
    console.log("[ITL] debug =", DEBUG);
    return DEBUG;
  };
  // 控制台手动高亮某个 group，例如 __itlHighlight("g3-2")
  window.__itlHighlight = function (groupId) {
    document.querySelectorAll(".itl-tok-active").forEach((s) =>
      s.classList.remove("itl-tok-active")
    );
    if (!groupId) return 0;
    const safe = (window.CSS && CSS.escape) ? CSS.escape(groupId) : groupId;
    const list = document.querySelectorAll('.itl-tok[data-itl-group~="' + safe + '"]');
    list.forEach((s) => s.classList.add("itl-tok-active"));
    return list.length;
  };

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
  // 用于"译文"侧 —— 译文 DOM 是我们从零构建的 div，没有内嵌结构问题。
  // 微软返回的索引为 inclusive 端点；统一转为 [start, endExclusive) 处理。
  function buildAlignedFragmentForTarget(text, alignment, groupPrefix) {
    const len = text.length;
    const points = new Set([0, len]);
    alignment.forEach((a) => {
      points.add(Math.max(0, Math.min(len, a.tgtStart)));
      points.add(Math.max(0, Math.min(len, a.tgtEnd + 1)));
    });
    const sorted = [...points].sort((a, b) => a - b);

    const frag = document.createDocumentFragment();
    for (let i = 0; i < sorted.length - 1; i++) {
      const s = sorted[i];
      const e = sorted[i + 1];
      if (s >= e) continue;
      const slice = text.slice(s, e);
      if (!slice) continue;

      const groups = [];
      alignment.forEach((a, idx) => {
        if (a.tgtStart <= s && a.tgtEnd + 1 >= e) groups.push(groupPrefix + idx);
      });

      if (groups.length) {
        const span = document.createElement("span");
        span.className = "itl-tok";
        span.setAttribute("data-itl-group", groups.join(" "));
        span.setAttribute("data-itl-side", "tgt");
        span.textContent = slice;
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(slice));
      }
    }
    return frag;
  }

  // 把原文 el 内的所有 TEXT_NODE 按 alignment 边界 split，并 wrap 成 .itl-tok span。
  // 不破坏内嵌 element（<a>、<strong> 等）—— 用 TreeWalker 找 textNode、用 splitText 切分、用 insertBefore + appendChild wrap。
  // baseOffset：alignment.srcStart/srcEnd 对应 el.textContent 中的索引偏移
  //             （worker 里发给 API 的是 textContent.trim()，所以 alignment 索引基于 trimmed 字符串，
  //              加上 leading whitespace 长度才是 textContent 全局索引）。
  function wrapAlignedSourceInElement(el, alignment, groupPrefix, baseOffset) {
    function collectTextNodes() {
      const out = [];
      let cursor = 0;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          // 跳过我们自己的译文节点内的 textNode
          if (n.parentElement && n.parentElement.closest(".itl-translation")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let node;
      while ((node = walker.nextNode())) {
        const len = node.nodeValue.length;
        out.push({ node, start: cursor, end: cursor + len });
        cursor += len;
      }
      return out;
    }

    const initial = collectTextNodes();
    if (!initial.length) return;
    const totalLen = initial[initial.length - 1].end;

    // 收集所有切片边界点（已加上 baseOffset，转 textContent 全局索引）
    const points = new Set();
    alignment.forEach((a) => {
      points.add(Math.max(0, Math.min(totalLen, a.srcStart + baseOffset)));
      points.add(Math.max(0, Math.min(totalLen, a.srcEnd + 1 + baseOffset)));
    });

    // 在每个边界点处 split textNode，使得 split 后没有 textNode 跨越任意 alignment 区间端点
    const sortedPts = [...points].sort((a, b) => a - b);
    for (const p of sortedPts) {
      if (p <= 0 || p >= totalLen) continue;
      const list = collectTextNodes();
      const target = list.find((n) => n.start < p && p < n.end);
      if (target) {
        target.node.splitText(p - target.start);
      }
    }

    // 现在每个 textNode 要么完全落在某个 alignment 区间内，要么完全在区间外。
    // 遍历 textNode，对落入区间的 wrap 成 span。
    const finalList = collectTextNodes();
    finalList.forEach(({ node, start, end }) => {
      const groups = [];
      alignment.forEach((a, idx) => {
        const as = a.srcStart + baseOffset;
        const ae = a.srcEnd + 1 + baseOffset;
        if (as <= start && ae >= end) groups.push(groupPrefix + idx);
      });
      if (!groups.length) return;

      const span = document.createElement("span");
      span.className = "itl-tok";
      span.setAttribute("data-itl-group", groups.join(" "));
      span.setAttribute("data-itl-side", "src");
      const parent = node.parentNode;
      if (!parent) return;
      parent.insertBefore(span, node);
      span.appendChild(node);
    });
  }

  // —— 译文插入 ——————————————————————————————————————————————

  // 一组全局递增的 group id 前缀，避免不同段之间互相误命中
  let groupSeq = 0;

  function appendTranslation(el, leadingOffset, result, debugSrcText) {
    const tgtText = result.text || "";
    const alignment = result.alignment;

    const node = document.createElement("div");
    node.className = "itl-translation";
    const cls = currentStyleClass();
    if (cls) node.classList.add(cls);

    const useAlignment = !!(alignment && alignment.length);
    if (useAlignment) {
      const seq = groupSeq++;
      const prefix = "g" + seq + "-";
      node.appendChild(buildAlignedFragmentForTarget(tgtText, alignment, prefix));

      // 原文用 TreeWalker + splitText 原地 wrap span —— 不破坏内嵌 <a>/<strong> 等结构。
      // 先快照 childNodes 以便 turnOff 还原原文 DOM。
      originalChildren.set(el, Array.from(el.childNodes).map((n) => n.cloneNode(true)));
      wrapAlignedSourceInElement(el, alignment, prefix, leadingOffset);

      if (DEBUG) logAlignmentDebug(el, seq, prefix, debugSrcText, tgtText, alignment, leadingOffset);
    } else {
      node.textContent = tgtText;
      if (DEBUG) console.log("[ITL] 段（无 alignment）：", debugSrcText, "→", tgtText);
    }

    el.appendChild(node);
  }

  // 打印 alignment 调试信息：alignment 期望的 src/tgt 子串 vs DOM 中实际 wrap 出来的 span 内容。
  // 两边对不上即为索引偏移问题（端点 inclusive/exclusive、leadingOffset、textContent vs API 字符流不一致等）。
  function logAlignmentDebug(el, seq, prefix, srcText, tgtText, alignment, leadingOffset) {
    console.groupCollapsed(
      "[ITL] 对齐调试 g" + seq + " · " + (srcText.slice(0, 40) + (srcText.length > 40 ? "…" : ""))
    );
    console.log("element:", el);
    console.log("发给 API 的原文（长度 " + srcText.length + "）:", JSON.stringify(srcText));
    console.log("API 返回的译文（长度 " + tgtText.length + "）:", JSON.stringify(tgtText));
    console.log("leadingOffset:", leadingOffset, "（trim 掉的首部空白字符数，会加到 src 索引上）");

    // 1) alignment 期望的子串
    const expected = alignment.map((a, idx) => ({
      group: prefix + idx,
      srcRange: a.srcStart + ":" + a.srcEnd,
      srcExpected: srcText.slice(a.srcStart, a.srcEnd + 1),
      tgtRange: a.tgtStart + ":" + a.tgtEnd,
      tgtExpected: tgtText.slice(a.tgtStart, a.tgtEnd + 1),
    }));
    console.log("alignment（期望子串，按对齐对索引）:");
    console.table(expected);

    // 2) DOM 中实际 wrap 出来的 span 内容（按 group 聚合）
    const srcSpans = Array.from(el.querySelectorAll('.itl-tok[data-itl-side="src"]'));
    const tgtSpans = Array.from(el.querySelectorAll('.itl-tok[data-itl-side="tgt"]'));
    const byGroup = {};
    [...srcSpans, ...tgtSpans].forEach((s) => {
      const text = s.textContent;
      const side = s.getAttribute("data-itl-side");
      (s.getAttribute("data-itl-group") || "").split(/\s+/).filter(Boolean).forEach((g) => {
        if (!byGroup[g]) byGroup[g] = { group: g, srcActual: "", tgtActual: "" };
        if (side === "src") byGroup[g].srcActual += text;
        else byGroup[g].tgtActual += text;
      });
    });
    const actualRows = expected.map((e) => byGroup[e.group] || { group: e.group, srcActual: "(无)", tgtActual: "(无)" });
    console.log("实际 wrap 后 DOM 中的 span 内容（按 group 聚合，应与上表一致）:");
    console.table(actualRows);

    // 3) 不匹配的 group
    const mismatches = expected.filter((e) => {
      const a = byGroup[e.group];
      return !a || a.srcActual !== e.srcExpected || a.tgtActual !== e.tgtExpected;
    });
    if (mismatches.length) {
      console.warn("⚠ 不匹配的 group：", mismatches.map((m) => m.group));
    } else {
      console.log("✓ 全部 group 匹配");
    }
    console.groupEnd();
  }

  // —— 并发队列 ——————————————————————————————————————————————

  const queue = [];
  let activeWorkers = 0;

  // 取 textContent 而不是 innerText —— 切 span 时 TreeWalker 遍历的是 textContent 字符流，
  // 用 innerText 会因为 <br>/空白规范化导致 alignment 索引错位。
  function extractTextForTranslation(el) {
    const raw = el.textContent || "";
    const leading = raw.length - raw.replace(/^\s+/, "").length;
    const trailing = raw.length - raw.replace(/\s+$/, "").length;
    const text = raw.slice(leading, raw.length - trailing);
    return { text, leadingOffset: leading };
  }

  async function workerLoop() {
    while (queue.length) {
      const el = queue.shift();
      if (!el || !el.isConnected) continue;
      if (el.hasAttribute(PROCESSED)) continue;
      // 立刻标记，防止 observer 在 await 期间把同一节点重新入队
      el.setAttribute(PROCESSED, "1");
      const { text, leadingOffset } = extractTextForTranslation(el);
      if (text.length < 2) continue;
      try {
        const result = await translateRemote(text);
        const out = (result.text || "").trim();
        if (out && out !== text) {
          appendTranslation(el, leadingOffset, result, text);
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
    const { text, leadingOffset } = extractTextForTranslation(block);
    if (text.length < 2) return;
    translateRemote(text)
      .then((result) => {
        const out = (result.text || "").trim();
        if (out && out !== text) {
          appendTranslation(block, leadingOffset, result, text);
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
