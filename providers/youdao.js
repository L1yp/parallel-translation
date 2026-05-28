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
  const dict = parseYoudaoDict(data);
  if (dict) out.dict = dict;
  return out;
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
  // 发音：即使 basic 缺失（有道判 isWord=false），speakUrl/tSpeakUrl 仍可能存在
  const audio = {};
  if (typeof data.speakUrl === "string" && data.speakUrl) audio.src = data.speakUrl;
  if (typeof data.tSpeakUrl === "string" && data.tSpeakUrl) audio.tgt = data.tSpeakUrl;
  if (Object.keys(audio).length) dict.audio = audio;

  return Object.keys(dict).length ? dict : null;
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
