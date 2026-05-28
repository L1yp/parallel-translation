// cache.js —— Service Worker 内的翻译缓存（IndexedDB）。
// 在 background.js 的翻译入口集中调用：先查缓存命中直接返回，未命中走 provider，成功后写回。
// content.js / providers 都不感知这一层。
//
// 不变量：
// - key = sha1(provider + text + targetLang + sourceLang + wantDict) hex。wantDict 不同独立缓存，
//   因为命中 dict 模式时 record 多带音标/释义/例句等字段，不能跨模式复用。
// - TTL 7 天：Google 接口偶发改字串、词典更新，超过一周强制刷新。
// - 容量上限 5000 条：超出按 createdAt 升序删最旧的。MV3 Service Worker 没有可靠的 GC 触发器，
//   依赖每次冷启动跑一次 cleanup（懒触发，标志位防重）。
// - 失败 / 空译文不写入：避免污染缓存让用户长期看不到新结果。
// - 任何 IDB 错误都吞掉返回 null/空，缓存层永远不能阻断翻译主流程。

const DB_NAME = "itl-cache";
const DB_VERSION = 1;
const STORE = "translations";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

let dbPromise = null;
let cleanupTriggered = false;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

export async function makeCacheKey({ provider, text, targetLang, sourceLang, wantDict }) {
  //  作分隔符，避免 "ab" + "c" 和 "a" + "bc" 撞 key。
  const raw = [
    provider || "",
    text || "",
    targetLang || "",
    sourceLang || "auto",
    wantDict ? "1" : "0",
  ].join("");
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(raw));
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16);
    hex += h.length === 1 ? "0" + h : h;
  }
  return hex;
}

export async function cacheGet(key) {
  try {
    const db = await openDb();
    const rec = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!rec) return null;
    if (Date.now() - rec.createdAt > TTL_MS) {
      // 顺手清掉过期项，但不阻塞返回；失败也无所谓
      cacheDelete(key).catch(() => {});
      return null;
    }
    return { text: rec.text || "", dict: rec.dict || null };
  } catch (e) {
    return null;
  }
}

export async function cacheSet(key, value) {
  if (!value || !value.text) return; // 空译文不写
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({
        key,
        text: value.text,
        dict: value.dict || null,
        createdAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    // 忽略：缓存层不影响主流程
  }
}

async function cacheDelete(key) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 删过期 + 超容截断。每次 SW 冷启动触发一次（标志位防重，SW 休眠重启会重置）。
export async function cleanupCache() {
  try {
    const db = await openDb();
    const cutoff = Date.now() - TTL_MS;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const idx = tx.objectStore(STORE).index("createdAt");
      const req = idx.openCursor(IDBKeyRange.upperBound(cutoff));
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          cur.delete();
          cur.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const count = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (count > MAX_ENTRIES) {
      const toRemove = count - MAX_ENTRIES;
      let removed = 0;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const idx = tx.objectStore(STORE).index("createdAt");
        const req = idx.openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (cur && removed < toRemove) {
            cur.delete();
            removed++;
            cur.continue();
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  } catch (e) {
    // 忽略
  }
}

export function maybeCleanupCache() {
  if (cleanupTriggered) return;
  cleanupTriggered = true;
  cleanupCache().catch(() => {});
}

// 给设置页缓存管理面板用：返回 { count, oldestAt, newestAt }（时间戳；空库时为 null）。
export async function cacheStats() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const idx = store.index("createdAt");
      const result = { count: 0, oldestAt: null, newestAt: null };
      const countReq = store.count();
      countReq.onsuccess = () => {
        result.count = countReq.result;
      };
      const firstReq = idx.openCursor();
      firstReq.onsuccess = () => {
        const cur = firstReq.result;
        if (cur) result.oldestAt = cur.value.createdAt;
      };
      const lastReq = idx.openCursor(null, "prev");
      lastReq.onsuccess = () => {
        const cur = lastReq.result;
        if (cur) result.newestAt = cur.value.createdAt;
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    return { count: 0, oldestAt: null, newestAt: null };
  }
}

// 用户主动清空：删全部记录。失败也吞错（不能阻塞 UI）。
export async function cacheClearAll() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    // 忽略
  }
}
