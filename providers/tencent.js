// providers/tencent.js —— 腾讯交互翻译 TranSmart（transmart.qq.com/api/imt，非官方免费接口）
// 无需凭证，类似 Google：直接 POST 文本拿译文。该接口随时可能失效或限流，调用方应捕获异常并降级。

// TranSmart 使用自有语言代码，与本扩展的 BCP-47 标签略有差异。
const LANG_MAP = {
  "zh-CN": "zh",
  "zh-TW": "zh-TW",
};

function mapLang(lang) {
  return LANG_MAP[lang] || lang;
}

// 模拟 Java 端的 client_key：browser-chrome-<ver>-<os>-<uuid>-<timestamp>
function clientKey() {
  const uuid =
    (crypto.randomUUID && crypto.randomUUID()) ||
    (Date.now().toString(36) + Math.random().toString(36).slice(2));
  return "browser-chrome-134.0.0-Windows_10-" + uuid.toLowerCase() + "-" + Date.now();
}

/**
 * @param {string} text
 * @param {string} targetLang  例如 "zh-CN"
 * @param {object} [config]  无需凭证
 * @param {{sourceLang?:string}} [options]  sourceLang 为 "auto" / 留空时让接口自动检测
 * @returns {Promise<{text:string}>}
 */
export async function translate(text, targetLang, config, options) {
  const sourceLang = (options && options.sourceLang) || "auto";

  const requestBody = {
    header: {
      fn: "auto_translation",
      session: "",
      client_key: clientKey(),
      user: "",
    },
    source: {
      lang: sourceLang === "auto" ? "auto" : mapLang(sourceLang),
      text_list: [text],
    },
    target: {
      lang: mapLang(targetLang),
    },
    model_category: "normal",
    text_domain: "general",
    type: "plain",
  };

  const res = await fetch("https://transmart.qq.com/api/imt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) throw new Error("Tencent HTTP " + res.status);

  const data = await res.json();
  if (!data || !data.header || data.header.ret_code !== "succ") {
    throw new Error("Tencent 翻译失败");
  }

  const list = Array.isArray(data.auto_translation) ? data.auto_translation : [];
  return { text: list.join("") };
}
