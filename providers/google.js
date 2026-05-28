// providers/google.js —— Google 免费翻译接口（非官方）
// 该接口随时可能失效或限流，调用方应捕获异常并降级。

export async function translate(text, targetLang /*, config */) {
  // client=gtx, sl=auto 自动识别源语言, dt=t 取译文
  const url =
    "https://translate.googleapis.com/translate_a/single" +
    "?client=gtx&sl=auto" +
    "&tl=" + encodeURIComponent(targetLang) +
    "&dt=t&q=" + encodeURIComponent(text);

  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);

  // 返回结构：data[0] 是一个数组，每个元素形如 [译文片段, 原文片段, ...]
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) return { text: "" };
  const text_ = data[0].map((seg) => (seg && seg[0]) || "").join("");
  return { text: text_ };
}
