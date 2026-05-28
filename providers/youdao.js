// providers/youdao.js —— 有道智云翻译 API（v3 签名）
// 文档：https://ai.youdao.com/DOCSIRMA/html/trans/api/wbfy/index.html
// 签名：sha256(appKey + truncate(q) + salt + curtime + appSecret)
// 免费额度：新用户注册赠送 50 元，约 500 万字符。

// 有道使用自有语言代码，与 BCP-47 略有差异。
const LANG_MAP = {
  "zh-CN": "zh-CHS",
  "zh-TW": "zh-CHT",
};

function mapLang(lang) {
  return LANG_MAP[lang] || lang;
}

// 官方 truncate 规则：长度 ≤ 20 直接用原文；否则取前 10 + 总长 + 后 10。
// 这里以 JS string.length（UTF-16 code units）作为长度，与有道大部分 SDK 一致。
function truncate(q) {
  const len = q.length;
  if (len <= 20) return q;
  return q.substring(0, 10) + len + q.substring(len - 10, len);
}

async function sha256Hex(input) {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randSalt() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  );
}

/**
 * @param {string} text
 * @param {string} targetLang  例如 "zh-CN"
 * @param {{appKey:string, appSecret:string}} config
 * @returns {Promise<{text:string, dict?:object}>}
 */
export async function translate(text, targetLang, config, options) {
  if (!config || !config.appKey || !config.appSecret) {
    throw new Error("有道智云未配置 App Key/App Secret，请在设置中填写");
  }
  const appKey = config.appKey;
  const appSecret = config.appSecret;
  const salt = randSalt();
  const curtime = Math.floor(Date.now() / 1000).toString();
  const sign = await sha256Hex(appKey + truncate(text) + salt + curtime + appSecret);
  const sourceLang = (options && options.sourceLang) || "auto";
  const wantDict = !!(options && options.wantDict);

  // 有道 API 在 from=auto 时通常只返回 translation，不带 basic/web 词典字段。
  // 想拿单词词典必须显式 from。这里按文本内容做轻量启发，仅在 wantDict 时启用。
  let from;
  if (sourceLang === "auto") {
    from = (wantDict && guessYoudaoDictLang(text)) || "auto";
  } else {
    from = mapLang(sourceLang);
  }

  const body = new URLSearchParams({
    q: text,
    from,
    to: mapLang(targetLang),
    appKey,
    salt,
    sign,
    signType: "v3",
    curtime,
  });

  const res = await fetch("https://openapi.youdao.com/api", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: body.toString(),
  });

  if (!res.ok) {
    let detail = "";
    try { detail = " " + (await res.text()).slice(0, 200); } catch {}
    throw new Error("有道 HTTP " + res.status + detail);
  }

  const data = await res.json();
  if (data.errorCode && data.errorCode !== "0") {
    throw new Error("有道 errorCode " + data.errorCode + describeYoudaoError(data.errorCode));
  }

  const translations = Array.isArray(data.translation) ? data.translation : [];
  const out = { text: translations.join("\n") };
  let dict = parseYoudaoDict(data);

  // v3 API 在 isWord=false 时不返 basic（'become' 也会被判 false）。
  // 这时去 webdict.url 的网页 #ec / #ce 抓一遍，能补全音标、释义、词形变化。
  // 有 basic 的快路径不动，避免每次都多一次 HTTP。
  if (wantDict && !data.basic && data.webdict && data.webdict.url) {
    const fb = await fetchYoudaoWebdict(data.webdict.url);
    if (fb) {
      dict = dict || {};
      if (!dict.phonetics && fb.phonetics) dict.phonetics = fb.phonetics;
      if (!dict.explains && fb.explains) dict.explains = fb.explains;
      if (fb.wordforms) dict.wordforms = fb.wordforms;
    }
  }

  if (wantDict) {
    const audio = {};
    if (from !== "auto") audio.src = ttsUrl(text, youdaoToBcp47(from));
    if (out.text) audio.tgt = ttsUrl(out.text, targetLang);
    if (Object.keys(audio).length) {
      dict = dict || {};
      dict.audio = audio;
    }
  }

  if (dict) out.dict = dict;
  return out;
}

async function fetchYoudaoWebdict(url) {
  try {
    // webdict.url 用 http，host_permissions 里我们要求 https，转一下
    const httpsUrl = url.replace(/^http:\/\//, "https://");
    const res = await fetch(httpsUrl);
    if (!res.ok) return null;
    return parseEcOrCeBlock(await res.text());
  } catch (_) {
    return null;
  }
}

// 从有道移动版网页里切出 #ec（英→中）或 #ce（中→英）这一段，正则提字段。
// SW 没 DOMParser，先按字符串切块缩范围，再小范围正则，避免页面里其它 div 干扰。
function parseEcOrCeBlock(html) {
  let i = html.indexOf('<div id="ec"');
  let mode = "ec";
  if (i < 0) {
    i = html.indexOf('<div id="ce"');
    mode = "ce";
  }
  if (i < 0) return null;
  // 切到下一个 trans-container 容器边界
  const next = html.indexOf("_contentWrp\"", i + 12);
  const block = next > i ? html.slice(i, next) : html.slice(i, i + 8000);

  const dict = {};
  const phonetics = [];
  if (mode === "ec") {
    const ph = /(英|美)\s*<span class="phonetic">\[([^\]]+)\]<\/span>/g;
    let m;
    while ((m = ph.exec(block)) !== null) phonetics.push({ region: m[1], ipa: m[2].trim() });
  } else {
    const m = block.match(/<span class="phonetic">\[([^\]]+)\]<\/span>/);
    if (m) phonetics.push({ ipa: m[1].trim() });
  }
  if (phonetics.length) dict.phonetics = phonetics;

  const explains = [];
  if (mode === "ec") {
    const li = /<li>([\s\S]+?)<\/li>/g;
    let m;
    while ((m = li.exec(block)) !== null) {
      const txt = stripTags(m[1]).replace(/\s+/g, " ").trim();
      if (txt) explains.push(txt);
    }
  } else {
    // 中→英：<a class="clickable">英译</a>; ... 收集成一行
    const a = /<a class="clickable"[^>]*>([^<]+)<\/a>/g;
    const items = [];
    let m;
    while ((m = a.exec(block)) !== null) {
      const t = m[1].trim();
      if (t) items.push(t);
    }
    if (items.length) explains.push(items.join("；"));
  }
  if (explains.length) dict.explains = explains.slice(0, 6);

  // 词形变化仅 #ec 有
  if (mode === "ec") {
    const wf = [];
    const p = /<p class="grey">\s*([\s\S]+?)\s*<\/p>/g;
    let m;
    while ((m = p.exec(block)) !== null) {
      const txt = stripTags(m[1]).replace(/\s+/g, " ").trim();
      if (txt) wf.push(txt);
    }
    if (wf.length) dict.wordforms = wf;
  }

  return Object.keys(dict).length ? dict : null;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "");
}

// from=auto 时基本只识别长句；对单字/单词，需要按字符内容自己判断锁 from，
// 否则有道服务端不走词典通路，返回里也就没有 basic/web。
function guessYoudaoDictLang(text) {
  if (/\p{Script=Han}/u.test(text)) return "zh-CHS";
  if (/^[A-Za-z][A-Za-z'\-]{0,30}$/.test(text)) return "en";
  return null;
}

// 有道对单词查询会额外返回 basic（音标+词性释义）和 web（网络释义）。
// 句子查询时这两个字段为 null，此处返回 null 让上层降级为纯译文。
function parseYoudaoDict(data) {
  const dict = {};
  if (data.basic && typeof data.basic === "object") {
    const b = data.basic;
    const phonetics = [];
    if (b["uk-phonetic"]) phonetics.push({ region: "英", ipa: b["uk-phonetic"] });
    if (b["us-phonetic"]) phonetics.push({ region: "美", ipa: b["us-phonetic"] });
    if (!phonetics.length && b.phonetic) phonetics.push({ ipa: b.phonetic });
    if (phonetics.length) dict.phonetics = phonetics;
    if (Array.isArray(b.explains) && b.explains.length) {
      dict.explains = b.explains.slice(0, 6);
    }
  }
  if (Array.isArray(data.web) && data.web.length) {
    const webExplains = data.web.slice(0, 4)
      .map((w) => ({
        key: w && w.key,
        values: w && Array.isArray(w.value) ? w.value.slice(0, 4) : [],
      }))
      .filter((w) => w.key && w.values.length);
    if (webExplains.length) dict.webExplains = webExplains;
  }
  return Object.keys(dict).length ? dict : null;
}

// 有道自带的 speakUrl/tSpeakUrl 在 <audio> 里常播不出（mime / 鉴权 / 跨域），
// 改用 Google 非官方 TTS。源/目标语言要从 youdao 的内部代码映射回 BCP-47。
function ttsUrl(text, lang) {
  return "https://translate.googleapis.com/translate_tts" +
    "?ie=UTF-8&client=tw-ob" +
    "&q=" + encodeURIComponent(text) +
    "&tl=" + encodeURIComponent(lang);
}

function youdaoToBcp47(code) {
  if (code === "zh-CHS") return "zh-CN";
  if (code === "zh-CHT") return "zh-TW";
  return code;
}

// 常见错误码 → 中文说明，方便用户在 options 测试连接时定位问题
function describeYoudaoError(code) {
  const M = {
    "101": " 缺少必填的参数",
    "102": " 不支持的语言类型",
    "103": " 翻译文本过长",
    "108": " appKey 无效",
    "110": " 无相关服务的有效实例",
    "111": " 开发者账号无效",
    "112": " 请求服务无效",
    "113": " q 不能为空",
    "202": " 签名检验失败，请检查 App Secret",
    "401": " 账户已欠费",
    "411": " 访问频率受限",
    "412": " 长 query 请求频率过快",
  };
  return M[code] || "";
}
