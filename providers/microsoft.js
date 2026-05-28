// providers/microsoft.js —— Microsoft Translator（Azure Cognitive Services）
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
 * @param {{sourceLang?:string}} [options]  sourceLang 为 "auto" 或留空时不传 from 参数，让 Azure 自动检测
 * @returns {Promise<{text:string}>}
 */
export async function translate(text, targetLang, config, options) {
  if (!config || !config.key) {
    throw new Error("Microsoft Translator 未配置 Key，请在弹窗设置中填写");
  }
  const region = config.region || "eastasia";
  const endpoint = (config.endpoint || "https://api.cognitive.microsofttranslator.com").replace(/\/$/, "");
  const to = mapLang(targetLang);
  const sourceLang = options && options.sourceLang;

  let url =
    endpoint + "/translate" +
    "?api-version=3.0" +
    "&to=" + encodeURIComponent(to);
  if (sourceLang && sourceLang !== "auto") {
    url += "&from=" + encodeURIComponent(mapLang(sourceLang));
  }

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
  return { text: (t && t.text) || "" };
}
