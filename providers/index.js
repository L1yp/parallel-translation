// providers/index.js —— 翻译服务路由
// 新增 provider 时：实现 translate(text, targetLang) 并在 PROVIDERS 注册。
// 当前只有 Google，留出后续接 OpenAI 兼容端点 / DeepL 等的扩展口。

import { translate as googleTranslate } from "./google.js";

const PROVIDERS = {
  google: googleTranslate,
};

export const DEFAULT_PROVIDER = "google";

export function translate(name, text, targetLang) {
  const fn = PROVIDERS[name] || PROVIDERS[DEFAULT_PROVIDER];
  return fn(text, targetLang);
}
