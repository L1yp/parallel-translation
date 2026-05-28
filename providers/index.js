// providers/index.js —— 翻译服务路由
// 接口约定：translate(text, targetLang, config?, options?) -> { text: string, dict?: object }
// options.wantDict 为 true 时 provider 尝试返回单词词典数据（音标/词性/例句等），不支持就不带。

import { translate as googleTranslate } from "./google.js";
import { translate as microsoftTranslate } from "./microsoft.js";
import { translate as youdaoTranslate } from "./youdao.js";

const PROVIDERS = {
  google: googleTranslate,
  microsoft: microsoftTranslate,
  youdao: youdaoTranslate,
};

export const DEFAULT_PROVIDER = "google";

export function translate(name, text, targetLang, config, options) {
  const fn = PROVIDERS[name] || PROVIDERS[DEFAULT_PROVIDER];
  return fn(text, targetLang, config, options);
}
