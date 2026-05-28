// vocab.js —— 生词本数据层（IndexedDB）。
// 在 background.js 的消息路由中被调用；content.js / options.js 不直接 import，全部走 message。
//
// 不变量：
// - id = crypto.randomUUID()
// - 去重键 = (normalized, targetLang)，索引 byNormalized 标 unique
// - 重复 add：保留 id / note / dict / translation，更新 sourceUrl / sourceTitle / context / createdAt
// - word 空 / 长度 > 200 拒绝写入
// - 任何 IDB 错误吞掉返回安全默认值，缓存层永远不能阻断翻译主流程
// - 容量上限 5000，超出按 createdAt 升序删最旧

const DB_NAME = "itl-vocab";
const DB_VERSION = 1;
const STORE = "entries";
const IDX_NORMALIZED = "byNormalized";
const IDX_CREATED = "byCreatedAt";
const MAX_ENTRIES = 5000;
const MAX_WORD_LEN = 200;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex(IDX_NORMALIZED, ["normalized", "targetLang"], { unique: true });
        store.createIndex(IDX_CREATED, "createdAt");
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

export function normalizeWord(word) {
  return String(word || "").toLowerCase().trim();
}

function genId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

// 查 (normalized, targetLang) 命中的 record（含 id），用于 add 时检测重复
async function findByNormalized(db, normalized, targetLang) {
  const tx = db.transaction(STORE, "readonly");
  const idx = tx.objectStore(STORE).index(IDX_NORMALIZED);
  return await reqPromise(idx.get([normalized, targetLang]));
}

export async function vocabAdd(payload) {
  try {
    const word = String(payload && payload.word || "").trim();
    if (!word) return { added: false, id: null, item: null };
    if (word.length > MAX_WORD_LEN) {
      console.warn("[ITL vocab] word too long, rejected:", word.length);
      return { added: false, id: null, item: null };
    }
    const normalized = normalizeWord(word);
    const targetLang = String(payload.targetLang || "");
    const db = await openDb();

    // 1. 去重：存在则更新部分字段
    const existing = await findByNormalized(db, normalized, targetLang);
    if (existing) {
      const merged = {
        ...existing,
        // 来源信息以最近一次为准（便于回看上下文）
        sourceUrl: payload.sourceUrl || existing.sourceUrl || "",
        sourceTitle: payload.sourceTitle || existing.sourceTitle || "",
        context: payload.context || existing.context || "",
        createdAt: Date.now(),
      };
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(merged);
      await txPromise(tx);
      return { added: false, id: merged.id, item: merged };
    }

    // 2. 新增
    const item = {
      id: genId(),
      word,
      normalized,
      sourceLang: String(payload.sourceLang || "auto"),
      targetLang,
      translation: String(payload.translation || ""),
      dict: payload.dict || null,
      note: "",
      sourceUrl: String(payload.sourceUrl || ""),
      sourceTitle: String(payload.sourceTitle || ""),
      context: String(payload.context || ""),
      createdAt: Date.now(),
    };
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add(item);
    await txPromise(tx);

    // 异步收缩到上限，不阻塞返回
    shrinkToMax().catch(() => {});

    return { added: true, id: item.id, item };
  } catch (e) {
    console.warn("[ITL vocab] add failed:", e);
    return { added: false, id: null, item: null };
  }
}

export async function vocabRemove(id) {
  try {
    if (!id) return;
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    await txPromise(tx);
  } catch (e) {
    console.warn("[ITL vocab] remove failed:", e);
  }
}

export async function vocabRemoveByWord(normalized, targetLang) {
  try {
    if (!normalized || !targetLang) return;
    const db = await openDb();
    const rec = await findByNormalized(db, normalized, targetLang);
    if (!rec) return;
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(rec.id);
    await txPromise(tx);
  } catch (e) {
    console.warn("[ITL vocab] removeByWord failed:", e);
  }
}

export async function vocabCheck(normalized, targetLang) {
  try {
    if (!normalized || !targetLang) return { exists: false };
    const db = await openDb();
    const rec = await findByNormalized(db, normalized, targetLang);
    if (!rec) return { exists: false };
    return { exists: true, id: rec.id };
  } catch (e) {
    return { exists: false };
  }
}

export async function vocabGet(id) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const rec = await reqPromise(tx.objectStore(STORE).get(id));
    return rec || null;
  } catch (e) {
    return null;
  }
}

export async function vocabList(filter) {
  try {
    const f = filter || {};
    const search = f.search ? String(f.search).toLowerCase().trim() : "";
    const targetLang = f.targetLang ? String(f.targetLang) : "";
    const sortBy = f.sortBy || "createdDesc";
    const limit = typeof f.limit === "number" && f.limit > 0 ? f.limit : null;
    const offset = typeof f.offset === "number" && f.offset > 0 ? f.offset : 0;

    const db = await openDb();
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    let items = all;
    if (targetLang) items = items.filter((x) => x.targetLang === targetLang);
    if (search) {
      items = items.filter((x) => {
        const w = String(x.word || "").toLowerCase();
        const t = String(x.translation || "").toLowerCase();
        const n = String(x.note || "").toLowerCase();
        return w.includes(search) || t.includes(search) || n.includes(search);
      });
    }

    // 排序
    items.sort((a, b) => {
      switch (sortBy) {
        case "createdAsc": return (a.createdAt || 0) - (b.createdAt || 0);
        case "wordAsc": return String(a.word).localeCompare(String(b.word));
        case "wordDesc": return String(b.word).localeCompare(String(a.word));
        case "createdDesc":
        default:
          return (b.createdAt || 0) - (a.createdAt || 0);
      }
    });

    const total = items.length;
    if (offset) items = items.slice(offset);
    if (limit) items = items.slice(0, limit);
    return { items, total };
  } catch (e) {
    return { items: [], total: 0 };
  }
}

export async function vocabUpdateNote(id, note) {
  try {
    if (!id) return;
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const rec = await reqPromise(store.get(id));
    if (!rec) {
      tx.abort();
      return;
    }
    rec.note = String(note || "");
    store.put(rec);
    await txPromise(tx);
  } catch (e) {
    console.warn("[ITL vocab] updateNote failed:", e);
  }
}

export async function vocabClearAll() {
  try {
    const db = await openDb();
    const count = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await txPromise(tx);
    return count;
  } catch (e) {
    return 0;
  }
}

export async function vocabExportAll() {
  try {
    const db = await openDb();
    const items = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return { version: 1, exportedAt: Date.now(), items };
  } catch (e) {
    return { version: 1, exportedAt: Date.now(), items: [] };
  }
}

export async function vocabImport(data, mode) {
  try {
    if (!data || !Array.isArray(data.items)) return { added: 0, skipped: 0 };
    const items = data.items;
    const db = await openDb();

    if (mode === "replace") {
      const txClear = db.transaction(STORE, "readwrite");
      txClear.objectStore(STORE).clear();
      await txPromise(txClear);
    }

    let added = 0;
    let skipped = 0;
    for (const raw of items) {
      const word = String(raw && raw.word || "").trim();
      if (!word) { skipped++; continue; }
      if (word.length > MAX_WORD_LEN) { skipped++; continue; }
      const normalized = normalizeWord(word);
      const targetLang = String(raw.targetLang || "");
      const existing = await findByNormalized(db, normalized, targetLang);
      if (existing) { skipped++; continue; }

      const item = {
        id: raw.id && typeof raw.id === "string" ? raw.id : genId(),
        word,
        normalized,
        sourceLang: String(raw.sourceLang || "auto"),
        targetLang,
        translation: String(raw.translation || ""),
        dict: raw.dict || null,
        note: String(raw.note || ""),
        sourceUrl: String(raw.sourceUrl || ""),
        sourceTitle: String(raw.sourceTitle || ""),
        context: String(raw.context || ""),
        createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
      };
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).add(item);
        await txPromise(tx);
        added++;
      } catch (_) {
        // 唯一索引冲突 / id 冲突等都视为跳过
        skipped++;
      }
    }
    shrinkToMax().catch(() => {});
    return { added, skipped };
  } catch (e) {
    console.warn("[ITL vocab] import failed:", e);
    return { added: 0, skipped: 0 };
  }
}

export async function vocabStats() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const idx = store.index(IDX_CREATED);
      const result = { count: 0, oldestAt: null, newestAt: null };
      const countReq = store.count();
      countReq.onsuccess = () => { result.count = countReq.result; };
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

// 写入后异步收缩到上限。不阻塞 add / import 主路径。
async function shrinkToMax() {
  try {
    const db = await openDb();
    const count = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => reject(req.error);
    });
    if (count <= MAX_ENTRIES) return;
    const toRemove = count - MAX_ENTRIES;
    let removed = 0;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const idx = tx.objectStore(STORE).index(IDX_CREATED);
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
  } catch (e) {
    // 忽略
  }
}
