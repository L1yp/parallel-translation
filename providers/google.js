// providers/google.js —— Google 免费翻译接口（非官方）
// 该接口随时可能失效或限流，调用方应捕获异常并降级。
//
// dt 参数控制返回哪些字段：dt=t 译文（必带）；dt=bd 词典分组（按词性）；
// dt=md 定义；dt=ex 例句。仅在 options.wantDict（划词翻译命中单词时）才请求后三者，
// 避免长句翻译响应体翻倍。

export async function translate(text, targetLang, config, options) {
  const wantDict = !!(options && options.wantDict);
  const sourceLang = (options && options.sourceLang) || "auto";
  const dtParts = wantDict
    ? "&dt=t&dt=bd&dt=md&dt=ex"
    : "&dt=t";

  const url =
    "https://translate.googleapis.com/translate_a/single" +
    "?client=gtx&sl=" + encodeURIComponent(sourceLang) +
    "&tl=" + encodeURIComponent(targetLang) +
    dtParts +
    "&q=" + encodeURIComponent(text);

  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);

  // 返回结构：data[0] 是一个数组，每个元素形如 [译文片段, 原文片段, ...]
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) return { text: "" };
  const text_ = data[0].map((seg) => (seg && seg[0]) || "").join("");

  const out = { text: text_ };
  if (wantDict) {
    const dict = parseGoogleDict(data) || {};
    // 发音 URL（response 不带，自己拼）。源语言用 data[2] 检测到的代码。
    const detectedSrc = typeof data[2] === "string" && data[2] ? data[2] : null;
    const audio = {};
    if (detectedSrc) audio.src = ttsUrl(text, detectedSrc);
    if (text_) audio.tgt = ttsUrl(text_, targetLang);
    if (Object.keys(audio).length) dict.audio = audio;
    if (Object.keys(dict).length) out.dict = dict;
  }
  return out;
}

// 非官方 TTS 端点，单词/短句可直接当 <audio> src 用。长文本会被拒。
function ttsUrl(text, lang) {
  return "https://translate.googleapis.com/translate_tts" +
    "?ie=UTF-8&client=tw-ob" +
    "&q=" + encodeURIComponent(text) +
    "&tl=" + encodeURIComponent(lang);
}

// data[1] (dt=bd)：[ [pos, [translations...], [...], baseForm], ... ]
// data[12] (dt=md)：[ [pos, [[def, refs, baseForm], ...]], ... ]
// data[13] (dt=ex)：[ [ [exampleHTML, ...], ... ] ]
function parseGoogleDict(data) {
  const dict = {};

  if (Array.isArray(data[1])) {
    const explains = [];
    for (const group of data[1]) {
      if (!Array.isArray(group)) continue;
      const pos = group[0];
      const meanings = Array.isArray(group[1]) ? group[1] : [];
      if (pos && meanings.length) {
        explains.push(pos + ". " + meanings.slice(0, 5).join("；"));
      }
    }
    if (explains.length) dict.explains = explains;
  }

  if (Array.isArray(data[12])) {
    const definitions = [];
    for (const group of data[12]) {
      if (!Array.isArray(group)) continue;
      const pos = group[0];
      const entries = Array.isArray(group[1]) ? group[1] : [];
      for (const e of entries.slice(0, 2)) {
        const def = Array.isArray(e) ? e[0] : null;
        if (def) definitions.push((pos ? pos + ". " : "") + def);
      }
      if (definitions.length >= 4) break;
    }
    if (definitions.length) dict.definitions = definitions.slice(0, 4);
  }

  if (Array.isArray(data[13]) && Array.isArray(data[13][0])) {
    const examples = data[13][0]
      .slice(0, 3)
      .map((row) => (Array.isArray(row) ? String(row[0] || "") : ""))
      .filter(Boolean)
      .map((s) => ({ src: stripHtml(s) }));
    if (examples.length) dict.examples = examples;
  }

  return Object.keys(dict).length ? dict : null;
}

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, "");
}
