// providers/index.js —— 翻译服务路由
// 接口约定：translate(text, targetLang, config?) -> { text: string, alignment?: Array<...> }
// alignment 仅由能返回对齐信息的 provider（如 Microsoft）填入；其它 provider 不要伪造。

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
