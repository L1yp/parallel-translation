// providers/index.js —— 翻译服务路由
// 接口约定：translate(text, targetLang, config?) -> { text: string }

import { translate as googleTranslate } from "./google.js";
import { translate as microsoftTranslate } from "./microsoft.js";

const PROVIDERS = {
  google: googleTranslate,
  microsoft: microsoftTranslate,
};

export const DEFAULT_PROVIDER = "google";

export function translate(name, text, targetLang, config) {
  const fn = PROVIDERS[name] || PROVIDERS[DEFAULT_PROVIDER];
  return fn(text, targetLang, config);
}
