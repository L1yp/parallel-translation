// providers/microsoft.js —— Microsoft Translator（Azure Cognitive Services）
// 优点：原生返回字符级 alignment（includeAlignment=true），可用于词对齐高亮。
// 免费层 F0：2M 字符/月。需要在 popup 配置 Key + Region。

// Google 用的 BCP-47 标签和微软略有差异，做一层映射。
const LANG_MAP = {
  "zh-CN": "zh-Hans",
  "zh-TW": "zh-Hant",
};

function mapLang(lang) {
  return LANG_MAP[lang] || lang;
}

/**
 * @param {string} text
 * @param {string} targetLang  例如 "zh-CN"
 * @param {{key:string, region:string, endpoint?:string}} config
 * @returns {Promise<{text:string, alignment?:Array<{srcStart:number,srcEnd:number,tgtStart:number,tgtEnd:number}>}>}
 */
export async function translate(text, targetLang, config) {
  if (!config || !config.key) {
    throw new Error("Microsoft Translator 未配置 Key，请在弹窗设置中填写");
  }
  const region = config.region || "eastasia";
  const endpoint = (config.endpoint || "https://api.cognitive.microsofttranslator.com").replace(/\/$/, "");
  const to = mapLang(targetLang);

  const url =
    endpoint + "/translate" +
    "?api-version=3.0" +
    "&to=" + encodeURIComponent(to) +
    "&includeAlignment=true";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": config.key,
      "Ocp-Apim-Subscription-Region": region,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify([{ Text: text }]),
  });

  if (!res.ok) {
    let detail = "";
    try { detail = " " + (await res.text()).slice(0, 200); } catch {}
    throw new Error("Microsoft HTTP " + res.status + detail);
  }

  const data = await res.json();
  const t = data && data[0] && data[0].translations && data[0].translations[0];
  if (!t) return { text: "" };

  const out = { text: t.text || "" };
  if (t.alignment && typeof t.alignment.proj === "string") {
    const parsed = parseAlignment(t.alignment.proj);
    if (parsed.length) out.alignment = parsed;
  }
  return out;
}

// "0:4-0:1 6:10-3:4" -> [{srcStart, srcEnd, tgtStart, tgtEnd}, ...]
// 微软文档中索引为字符级 inclusive 端点（UTF-16 code unit）。
function parseAlignment(proj) {
  const result = [];
  for (const pair of proj.split(" ")) {
    if (!pair) continue;
    const m = /^(\d+):(\d+)-(\d+):(\d+)$/.exec(pair);
    if (!m) continue;
    result.push({
      srcStart: +m[1],
      srcEnd: +m[2],
      tgtStart: +m[3],
      tgtEnd: +m[4],
    });
  }
  return result;
}
