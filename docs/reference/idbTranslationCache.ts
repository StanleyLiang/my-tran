// idbTranslationCache.ts
// -----------------------------------------------------------------------------
// Zero-dependency IndexedDB store for message translation. Two concerns kept
// deliberately SEPARATE:
//
//   1) intent  (`intent` store)        — AUTHORITATIVE "display as translated"
//      state the backend does not reconstruct. Tiny (no markdown). NEVER pruned.
//   2) content (`translations` store)  — REBUILDABLE cache of translated markdown,
//      under a ~50 MB oldest-first LRU cap. MAY be evicted; a miss just re-translates.
//
// Separated so LRU eviction can never silently un-translate a message the user
// marked. Persistence is local, survives logout/login, NOT cross-device.
//
// Use `createTranslationCache(config)` for an isolated/configurable/testable
// instance, or the default `translationCache` singleton for app-wide use.
//
// Design notes:
//   - Every operation degrades to a miss/no-op on failure and reports via onError.
//   - Reads return trimmed PUBLIC shapes (no internal size/updatedAt).
//   - One `tx()` helper wraps all transaction boilerplate.
//   - Resilience: QuotaExceededError → prune+retry; corruption self-heal
//     (deleteDatabase once + reopen); onblocked hook; onversionchange closes.
//   - Migration: bump DB_VERSION; onupgradeneeded keys off oldVersion. Prefer
//     additive + read-tolerant; breaking may drop & rebuild (also drops intent).
// -----------------------------------------------------------------------------

export type TranslateMode = 'manual' | 'auto';

/** AUTHORITATIVE per-message display state (public shape). */
export interface Intent {
  messageId: string;
  mode: TranslateMode;
  targetLang: string;
  srcVersion: string | number;
}

/** Cached translated content (public shape — no internal bookkeeping fields). */
export interface TranslationContent {
  messageId: string;
  targetLang: string;
  translatedMarkdown: string;
  srcVersion: string | number;
}

export interface TranslationCacheConfig {
  dbName?: string;
  capBytes?: number;
  pruneBatch?: number;
  onBlocked?: () => void;
  onError?: (op: string, err: unknown) => void;
}

export interface TranslationCache {
  intent: {
    get(messageId: string): Promise<Intent | undefined>;
    getMany(ids: string[]): Promise<Map<string, Intent>>;
    set(entry: Intent): Promise<void>;
    remove(messageId: string): Promise<void>;
  };
  content: {
    get(messageId: string): Promise<TranslationContent | undefined>;
    getMany(ids: string[]): Promise<Map<string, TranslationContent>>;
    set(entry: TranslationContent): Promise<void>;
    remove(messageId: string): Promise<void>;
    touch(messageId: string): Promise<void>;
    totalBytes(): Promise<number>;
  };
  maintenance: {
    prune(): Promise<number>;
    clearAll(): Promise<void>;
    recover(): Promise<void>;
    requestPersistentStorage(): Promise<boolean>;
  };
}

// ---- fixed schema + tuning constants ----------------------------------------

const DB_VERSION = 1;
const STORE = 'translations';
const INTENT = 'intent';
const META = 'meta';
const LRU_INDEX = 'byUpdatedAt';
const TOTAL_KEY = 'totalBytes';

const MB = 1024 * 1024;
const DEFAULT_DB_NAME = 'msg-translations';
const DEFAULT_CAP_BYTES = 50 * MB;
const DEFAULT_PRUNE_BATCH = 10_000;

const BYTES_PER_CHAR = 2; // conservative (CJK)
const RECORD_OVERHEAD_BYTES = 120; // field names + key + index entry + numbers

// ---- internal record shapes (superset of the public shapes) -----------------

interface ContentRecord extends TranslationContent {
  updatedAt: number; // ORDERING KEY for oldest-first prune
  size: number; // estimated bytes for the LRU cap
}
interface IntentRecord extends Intent {
  updatedAt: number;
}

// ---- pure helpers (no instance state) ---------------------------------------

function available(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function estimateSize(r: TranslationContent): number {
  const chars =
    r.messageId.length + r.targetLang.length + r.translatedMarkdown.length + String(r.srcVersion).length;
  return chars * BYTES_PER_CHAR + RECORD_OVERHEAD_BYTES;
}

function createStores(db: IDBDatabase): void {
  const store = db.createObjectStore(STORE, { keyPath: 'messageId' });
  store.createIndex(LRU_INDEX, 'updatedAt', { unique: false });
  db.createObjectStore(INTENT, { keyPath: 'messageId' }); // no LRU index — never pruned
  db.createObjectStore(META); // out-of-line keys; we use TOTAL_KEY
}

const toContent = (r: ContentRecord): TranslationContent => ({
  messageId: r.messageId,
  targetLang: r.targetLang,
  translatedMarkdown: r.translatedMarkdown,
  srcVersion: r.srcVersion,
});
const toIntent = (r: IntentRecord): Intent => ({
  messageId: r.messageId,
  mode: r.mode,
  targetLang: r.targetLang,
  srcVersion: r.srcVersion,
});

// -----------------------------------------------------------------------------

export function createTranslationCache(config: TranslationCacheConfig = {}): TranslationCache {
  const dbName = config.dbName ?? DEFAULT_DB_NAME;
  const capBytes = config.capBytes ?? DEFAULT_CAP_BYTES;
  const pruneBatch = config.pruneBatch ?? DEFAULT_PRUNE_BATCH;
  const onBlocked = config.onBlocked ?? (() => {});
  const onError = config.onError ?? (() => {});

  let dbPromise: Promise<IDBDatabase> | null = null;

  // ---- open / recover -------------------------------------------------------

  function rawOpen(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const oldV = (event as IDBVersionChangeEvent).oldVersion;
        if (oldV < 1) createStores(db);
        // Future migrations keyed by oldV. Additive: create new store/index.
        // Breaking (drop & rebuild — ⚠ also drops intent, reverting manual msgs):
        //   for (const n of Array.from(db.objectStoreNames)) db.deleteObjectStore(n);
        //   createStores(db);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => onBlocked();
    });
  }

  function deleteDatabaseRaw(): Promise<void> {
    return new Promise<void>((resolve) => {
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.deleteDatabase(dbName);
      } catch {
        resolve();
        return;
      }
      req.onsuccess = () => resolve();
      req.onerror = () => resolve(); // best-effort
      req.onblocked = () => onBlocked();
    });
  }

  function openDB(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    const p = rawOpen().catch(async (err: unknown) => {
      // VersionError: a newer schema owns the data (another tab / newer bundle). Never delete.
      if ((err as DOMException)?.name === 'VersionError') throw err;
      // Possible corruption → delete once, reopen once. dbPromise stays === p,
      // so the healed connection is cached (do NOT null dbPromise here).
      await deleteDatabaseRaw();
      return rawOpen();
    });
    dbPromise = p;
    p.catch((err) => {
      onError('open', err);
      if (dbPromise === p) dbPromise = null; // let a later call retry from scratch
    });
    return p;
  }

  // ---- transaction plumbing (all IDB boilerplate lives here) ----------------

  /** Run `fn` in one transaction; resolves on commit, rejects on error/abort.
   *  `fn` must only enqueue IDB requests synchronously (no awaiting inside). */
  function tx(stores: string | string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => void): Promise<void> {
    return openDB().then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          let t: IDBTransaction;
          try {
            t = db.transaction(stores, mode);
            fn(t);
          } catch (e) {
            reject(e);
            return;
          }
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        }),
    );
  }

  /** Wrap an op: degrade to `fallback` and report on any failure. */
  async function safe<T>(op: string, fallback: T, run: () => Promise<T>): Promise<T> {
    if (!available()) return fallback;
    try {
      return await run();
    } catch (err) {
      onError(op, err);
      return fallback;
    }
  }

  function readOne<T>(store: string, key: IDBValidKey, op: string): Promise<T | undefined> {
    return safe<T | undefined>(op, undefined, async () => {
      let result: T | undefined;
      await tx(store, 'readonly', (t) => {
        const r = t.objectStore(store).get(key);
        r.onsuccess = () => {
          result = r.result as T | undefined;
        };
      });
      return result;
    });
  }

  function readMany<T>(store: string, ids: string[], op: string): Promise<Map<string, T>> {
    return safe(op, new Map<string, T>(), async () => {
      const out = new Map<string, T>();
      if (ids.length === 0) return out;
      await tx(store, 'readonly', (t) => {
        const os = t.objectStore(store);
        for (const id of ids) {
          const r = os.get(id);
          r.onsuccess = () => {
            if (r.result) out.set(id, r.result as T);
          };
        }
      });
      return out;
    });
  }

  /** Adjust the running byte total by `delta` (within an existing tx). */
  function adjustTotal(ms: IDBObjectStore, delta: number): void {
    const g = ms.get(TOTAL_KEY);
    g.onsuccess = () => ms.put(Math.max(0, ((g.result as number) ?? 0) + delta), TOTAL_KEY);
  }

  /** Upsert content + update the byte total; returns the new total. */
  async function putContent(rec: ContentRecord): Promise<number> {
    let newTotal = 0;
    await tx([STORE, META], 'readwrite', (t) => {
      const ts = t.objectStore(STORE);
      const ms = t.objectStore(META);
      const getOld = ts.get(rec.messageId);
      getOld.onsuccess = () => {
        const oldSize = (getOld.result as ContentRecord | undefined)?.size ?? 0;
        ts.put(rec);
        const gt = ms.get(TOTAL_KEY);
        gt.onsuccess = () => {
          newTotal = Math.max(0, ((gt.result as number) ?? 0) + rec.size - oldSize);
          ms.put(newTotal, TOTAL_KEY);
        };
      };
    });
    return newTotal;
  }

  // ---- maintenance ----------------------------------------------------------

  function prune(): Promise<number> {
    return safe('prune', 0, async () => {
      let deleted = 0;
      let freed = 0;
      await tx([STORE, META], 'readwrite', (t) => {
        const ts = t.objectStore(STORE);
        const ms = t.objectStore(META);
        const cursorReq = ts.index(LRU_INDEX).openCursor(null, 'next'); // oldest first
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && deleted < pruneBatch) {
            const rec = cursor.value as ContentRecord;
            freed += rec.size ?? estimateSize(rec);
            cursor.delete();
            deleted++;
            cursor.continue();
          } else {
            adjustTotal(ms, -freed);
          }
        };
      });
      return deleted;
    });
  }

  async function recover(): Promise<void> {
    try {
      if (dbPromise) (await dbPromise).close();
    } catch {
      /* ignore */
    }
    dbPromise = null;
    await deleteDatabaseRaw();
  }

  async function requestPersistentStorage(): Promise<boolean> {
    try {
      if (navigator.storage?.persist) return await navigator.storage.persist();
    } catch {
      /* ignore */
    }
    return false;
  }

  // ---- content writes -------------------------------------------------------

  async function setContent(entry: TranslationContent): Promise<void> {
    if (!available()) return;
    const rec: ContentRecord = { ...entry, updatedAt: Date.now(), size: estimateSize(entry) };
    try {
      const total = await putContent(rec);
      if (total > capBytes) void prune();
    } catch (err) {
      // QuotaExceededError / transient → free space and retry once.
      onError('content.set', err);
      try {
        await prune();
        await putContent(rec);
      } catch (retryErr) {
        onError('content.set.retry', retryErr);
      }
    }
  }

  function removeContent(messageId: string): Promise<void> {
    return safe('content.remove', undefined, () =>
      tx([STORE, META], 'readwrite', (t) => {
        const ts = t.objectStore(STORE);
        const ms = t.objectStore(META);
        const getOld = ts.get(messageId);
        getOld.onsuccess = () => {
          const old = getOld.result as ContentRecord | undefined;
          if (!old) return;
          ts.delete(messageId);
          adjustTotal(ms, -(old.size ?? 0));
        };
      }),
    );
  }

  function touch(messageId: string): Promise<void> {
    return safe('content.touch', undefined, () =>
      tx(STORE, 'readwrite', (t) => {
        const ts = t.objectStore(STORE);
        const g = ts.get(messageId);
        g.onsuccess = () => {
          const r = g.result as ContentRecord | undefined;
          if (r) {
            r.updatedAt = Date.now();
            ts.put(r);
          }
        };
      }),
    );
  }

  function totalBytes(): Promise<number> {
    return safe('content.totalBytes', 0, async () => {
      let n = 0;
      await tx(META, 'readonly', (t) => {
        const r = t.objectStore(META).get(TOTAL_KEY);
        r.onsuccess = () => {
          n = (r.result as number) ?? 0;
        };
      });
      return n;
    });
  }

  // ---- intent writes --------------------------------------------------------

  function setIntent(entry: Intent): Promise<void> {
    const rec: IntentRecord = { ...entry, updatedAt: Date.now() };
    return safe('intent.set', undefined, () =>
      tx(INTENT, 'readwrite', (t) => {
        t.objectStore(INTENT).put(rec);
      }),
    );
  }

  function removeIntent(messageId: string): Promise<void> {
    return safe('intent.remove', undefined, () =>
      tx(INTENT, 'readwrite', (t) => {
        t.objectStore(INTENT).delete(messageId);
      }),
    );
  }

  function clearAll(): Promise<void> {
    return safe('clearAll', undefined, () =>
      tx([STORE, INTENT, META], 'readwrite', (t) => {
        t.objectStore(STORE).clear();
        t.objectStore(INTENT).clear();
        t.objectStore(META).put(0, TOTAL_KEY);
      }),
    );
  }

  // ---- public surface -------------------------------------------------------

  return {
    intent: {
      async get(messageId) {
        const rec = await readOne<IntentRecord>(INTENT, messageId, 'intent.get');
        return rec ? toIntent(rec) : undefined;
      },
      async getMany(ids) {
        const raw = await readMany<IntentRecord>(INTENT, ids, 'intent.getMany');
        const out = new Map<string, Intent>();
        raw.forEach((rec, id) => out.set(id, toIntent(rec)));
        return out;
      },
      set: setIntent,
      remove: removeIntent,
    },
    content: {
      async get(messageId) {
        const rec = await readOne<ContentRecord>(STORE, messageId, 'content.get');
        return rec ? toContent(rec) : undefined;
      },
      async getMany(ids) {
        const raw = await readMany<ContentRecord>(STORE, ids, 'content.getMany');
        const out = new Map<string, TranslationContent>();
        raw.forEach((rec, id) => out.set(id, toContent(rec)));
        return out;
      },
      set: setContent,
      remove: removeContent,
      touch,
      totalBytes,
    },
    maintenance: { prune, clearAll, recover, requestPersistentStorage },
  };
}

/** Default app-wide singleton. Configure via createTranslationCache() when you
 *  need a custom db name / cap / handlers, or an isolated instance for tests. */
export const translationCache = createTranslationCache();
