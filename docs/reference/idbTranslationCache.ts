// idbTranslationCache.ts
// -----------------------------------------------------------------------------
// Zero-dependency IndexedDB store for message translation. Two concerns, kept
// deliberately SEPARATE:
//
//   1) intent  (object store `intent`)  — AUTHORITATIVE "display as translated"
//      state the backend does not reconstruct. Tiny (no markdown). NEVER pruned.
//      Presence means: show this message translated, in `targetLang`.
//
//   2) content (object store `translations`) — REBUILDABLE cache of the translated
//      markdown. Under a ~50 MB LRU cap (oldest-first). MAY be evicted; on a miss
//      the caller just re-translates.
//
// Why separate: if a single record were both the flag and the content, LRU
// eviction would silently un-translate messages the user expects to stay
// translated (violates PRD §4.2.2 "維持該狀態"). Intent is never evicted; content is.
//
// Persistence semantics match PRD: local, survives logout/login, NOT cross-device.
//
// Pure module — no React / zustand imports. Values must be structured-cloneable.
//
// Resilience: feature-detect + try/catch everywhere → any failure degrades to a
// cache/intent miss; QuotaExceededError → prune+retry; corruption self-heal
// (deleteDatabase once + reopen); onblocked via setBlockedHandler; onversionchange
// closes so other tabs can upgrade.
//
// Migration: schema changes bump DB_VERSION; onupgradeneeded keys off oldVersion.
// Prefer additive + read-tolerant; breaking changes may drop & rebuild (a lost
// cache just re-translates — but note: dropping also loses intent, reverting
// manually-translated messages to original, so avoid unless necessary).
// -----------------------------------------------------------------------------

export type TranslateMode = 'manual' | 'auto';

/** AUTHORITATIVE per-message display state (never pruned). */
export interface DisplayIntent {
  messageId: string;            // primary key
  mode: TranslateMode;          // 'manual' now; 'auto' reserved for §3.2 reconciliation
  targetLang: string;
  srcVersion: string | number;  // message version when marked → edit invalidation
  updatedAt: number;
}

/** REBUILDABLE cached translation content (under the 50 MB LRU cap). */
export interface CachedTranslation {
  messageId: string;            // primary key (keyPath)
  targetLang: string;
  translatedMarkdown: string;
  srcVersion: string | number;
  updatedAt: number;            // ORDERING KEY for oldest-first prune
  size: number;                 // estimated bytes (for the 50 MB cap)
}

const DB_NAME = 'msg-translations';
const DB_VERSION = 1;                    // bump + migrate in onupgradeneeded on schema change
const STORE = 'translations';           // content cache
const INTENT = 'intent';                // authoritative display flags
const META = 'meta';
const LRU_INDEX = 'byUpdatedAt';
const TOTAL_KEY = 'totalBytes';

const CAP_BYTES = 50 * 1024 * 1024;      // 50 MB soft cap (content only)
const PRUNE_BATCH = 10_000;

let dbPromise: Promise<IDBDatabase> | null = null;

let onBlocked: () => void = () => {};
export function setBlockedHandler(fn: () => void): void {
  onBlocked = fn;
}

function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function estimateSize(r: Omit<CachedTranslation, 'size'>): number {
  const chars =
    r.messageId.length + r.targetLang.length + r.translatedMarkdown.length + String(r.srcVersion).length;
  return chars * 2 + 120;
}

// ---- schema helpers ---------------------------------------------------------

function createStores(db: IDBDatabase): void {
  const store = db.createObjectStore(STORE, { keyPath: 'messageId' });
  store.createIndex(LRU_INDEX, 'updatedAt', { unique: false });
  db.createObjectStore(INTENT, { keyPath: 'messageId' }); // no LRU index — never pruned
  db.createObjectStore(META); // out-of-line keys; we use TOTAL_KEY
}

function dropStores(db: IDBDatabase): void {
  for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
}

// ---- open / recover ---------------------------------------------------------

function rawOpen(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldV = (event as IDBVersionChangeEvent).oldVersion;

      if (oldV < 1) {
        createStores(db); // fresh install → v1 schema (content + intent + meta)
      }

      // --- Future migrations keyed by oldVersion --------------------------
      // ADDITIVE (keep data): create a new index/store without touching the rest.
      // BREAKING (drop & rebuild): dropStores(db); createStores(db);
      //   ⚠ dropping loses INTENT too → manually-translated msgs revert to original.
      //   Avoid unless the intent schema itself must change.
      // --------------------------------------------------------------------
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
  dbPromise = null;
  return new Promise<void>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.deleteDatabase(DB_NAME);
    } catch {
      resolve();
      return;
    }
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => onBlocked();
  });
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = rawOpen().catch(async (err: unknown) => {
    if ((err as DOMException)?.name === 'VersionError') throw err; // newer schema owns it
    await deleteDatabaseRaw(); // possible corruption → delete once, reopen once
    return rawOpen();
  });
  dbPromise = p;
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return p;
}

/** Manually drop the whole database and reset (e.g. detected corruption). */
export async function recoverDatabase(): Promise<void> {
  if (dbPromise) {
    try {
      (await dbPromise).close();
    } catch {
      /* ignore */
    }
  }
  await deleteDatabaseRaw();
}

// ---- intent (authoritative display flag; never pruned) ----------------------

export async function getIntent(messageId: string): Promise<DisplayIntent | undefined> {
  if (!idbAvailable()) return undefined;
  try {
    const db = await openDB();
    return await new Promise<DisplayIntent | undefined>((resolve, reject) => {
      const tx = db.transaction(INTENT, 'readonly');
      const req = tx.objectStore(INTENT).get(messageId);
      tx.oncomplete = () => resolve(req.result as DisplayIntent | undefined);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return undefined;
  }
}

/** Batch read intents for a viewport in ONE transaction. */
export async function getManyIntents(ids: string[]): Promise<Map<string, DisplayIntent>> {
  const out = new Map<string, DisplayIntent>();
  if (!idbAvailable() || ids.length === 0) return out;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(INTENT, 'readonly');
      const store = tx.objectStore(INTENT);
      for (const id of ids) {
        const r = store.get(id);
        r.onsuccess = () => {
          if (r.result) out.set(id, r.result as DisplayIntent);
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* degrade */
  }
  return out;
}

export async function setIntent(
  entry: Omit<DisplayIntent, 'updatedAt'> & { updatedAt?: number },
): Promise<void> {
  if (!idbAvailable()) return;
  const record: DisplayIntent = { ...entry, updatedAt: entry.updatedAt ?? Date.now() };
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(INTENT, 'readwrite');
      tx.objectStore(INTENT).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore — degrade */
  }
}

export async function deleteIntent(messageId: string): Promise<void> {
  if (!idbAvailable()) return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(INTENT, 'readwrite');
      tx.objectStore(INTENT).delete(messageId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

// ---- content reads ----------------------------------------------------------

export async function getTranslation(messageId: string): Promise<CachedTranslation | undefined> {
  if (!idbAvailable()) return undefined;
  try {
    const db = await openDB();
    return await new Promise<CachedTranslation | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(messageId);
      tx.oncomplete = () => resolve(req.result as CachedTranslation | undefined);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return undefined;
  }
}

export async function getManyTranslations(ids: string[]): Promise<Map<string, CachedTranslation>> {
  const out = new Map<string, CachedTranslation>();
  if (!idbAvailable() || ids.length === 0) return out;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      for (const id of ids) {
        const r = store.get(id);
        r.onsuccess = () => {
          if (r.result) out.set(id, r.result as CachedTranslation);
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* degrade */
  }
  return out;
}

export async function getTotalBytes(): Promise<number> {
  if (!idbAvailable()) return 0;
  try {
    const db = await openDB();
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(META, 'readonly');
      const req = tx.objectStore(META).get(TOTAL_KEY);
      tx.oncomplete = () => resolve((req.result as number) ?? 0);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return 0;
  }
}

// ---- content writes (byte-tracked, LRU-pruned) ------------------------------

function putRecordTx(record: CachedTranslation): Promise<number> {
  return openDB().then(
    (db) =>
      new Promise<number>((resolve, reject) => {
        let newTotal = 0;
        const tx = db.transaction([STORE, META], 'readwrite');
        const ts = tx.objectStore(STORE);
        const ms = tx.objectStore(META);
        const getOld = ts.get(record.messageId);
        getOld.onsuccess = () => {
          const oldSize = (getOld.result as CachedTranslation | undefined)?.size ?? 0;
          ts.put(record);
          const getTotal = ms.get(TOTAL_KEY);
          getTotal.onsuccess = () => {
            newTotal = Math.max(0, ((getTotal.result as number) ?? 0) + record.size - oldSize);
            ms.put(newTotal, TOTAL_KEY);
          };
        };
        tx.oncomplete = () => resolve(newTotal);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export async function setTranslation(
  entry: Omit<CachedTranslation, 'updatedAt' | 'size'> & { updatedAt?: number },
): Promise<void> {
  if (!idbAvailable()) return;
  const base = {
    messageId: entry.messageId,
    targetLang: entry.targetLang,
    translatedMarkdown: entry.translatedMarkdown,
    srcVersion: entry.srcVersion,
    updatedAt: entry.updatedAt ?? Date.now(),
  };
  const record: CachedTranslation = { ...base, size: estimateSize(base) };
  try {
    const total = await putRecordTx(record);
    if (total > CAP_BYTES) void prune();
  } catch {
    try {
      await prune();
      await putRecordTx(record);
    } catch {
      /* give up silently; in-memory store still holds it this session */
    }
  }
}

export async function deleteTranslation(messageId: string): Promise<void> {
  if (!idbAvailable()) return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, META], 'readwrite');
      const ts = tx.objectStore(STORE);
      const ms = tx.objectStore(META);
      const getOld = ts.get(messageId);
      getOld.onsuccess = () => {
        const old = getOld.result as CachedTranslation | undefined;
        if (!old) return;
        ts.delete(messageId);
        const getTotal = ms.get(TOTAL_KEY);
        getTotal.onsuccess = () =>
          ms.put(Math.max(0, ((getTotal.result as number) ?? 0) - (old.size ?? 0)), TOTAL_KEY);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

/**
 * Prune CONTENT oldest-first by updatedAt, up to PRUNE_BATCH per pass. Intent is
 * NEVER touched here. For a hard guarantee under cap:
 *   while ((await getTotalBytes()) > CAP_BYTES && (await prune()) > 0) {}
 */
export async function prune(): Promise<number> {
  if (!idbAvailable()) return 0;
  try {
    const db = await openDB();
    return await new Promise<number>((resolve, reject) => {
      let deleted = 0;
      let freed = 0;
      const tx = db.transaction([STORE, META], 'readwrite'); // NOTE: no INTENT here
      const ts = tx.objectStore(STORE);
      const ms = tx.objectStore(META);
      const cursorReq = ts.index(LRU_INDEX).openCursor(null, 'next');
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor && deleted < PRUNE_BATCH) {
          const rec = cursor.value as CachedTranslation;
          freed += rec.size ?? estimateSize(rec);
          cursor.delete();
          deleted++;
          cursor.continue();
        } else {
          const getTotal = ms.get(TOTAL_KEY);
          getTotal.onsuccess = () =>
            ms.put(Math.max(0, ((getTotal.result as number) ?? 0) - freed), TOTAL_KEY);
        }
      };
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return 0;
  }
}

/** Bump content updatedAt → least-recently-VIEWED eviction. Optional on cache hit. */
export async function touch(messageId: string): Promise<void> {
  if (!idbAvailable()) return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const ts = tx.objectStore(STORE);
      const g = ts.get(messageId);
      g.onsuccess = () => {
        const r = g.result as CachedTranslation | undefined;
        if (r) {
          r.updatedAt = Date.now();
          ts.put(r);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

/** Wipe everything (content + intent + total). Do NOT call on logout. */
export async function clearAll(): Promise<void> {
  if (!idbAvailable()) return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, INTENT, META], 'readwrite');
      tx.objectStore(STORE).clear();
      tx.objectStore(INTENT).clear();
      tx.objectStore(META).put(0, TOTAL_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* ignore */
  }
  return false;
}

// -----------------------------------------------------------------------------
// Integration sketch (in your translation store / bubble, NOT here):
//
//   import {
//     getIntent, setIntent, deleteIntent,
//     getTranslation, setTranslation, deleteTranslation, setBlockedHandler,
//   } from './idbTranslationCache';
//
//   setBlockedHandler(() => showToast('Please close other tabs to update translation cache.'));
//
//   // MANUAL translate success (inside the store's run()):
//   setIntent({ messageId, mode: 'manual', targetLang, srcVersion });   // authoritative
//   setTranslation({ messageId, targetLang, translatedMarkdown: out, srcVersion }); // cache
//
//   // Revert ("See original message"):
//   deleteIntent(messageId);            // stop showing translated
//   // deleteTranslation(messageId);    // optional: keep content for instant re-show
//
//   // Edit (srcVersion changed) / message removed (PRD §3.3 manual → original):
//   deleteIntent(messageId);
//   deleteTranslation(messageId);
//
//   // Read-through on view — INTENT decides display; content is just the fast path.
//   // Invalidate ONLY on srcVersion (edit). Do NOT compare targetLang to the global
//   // setting — switching language must not re-translate already-translated messages.
//   async function hydrateOnView(messageId: string, currentSrcVersion: string | number) {
//     if (store.getState().byId[messageId]) return;
//     const intent = await getIntent(messageId);
//     if (!intent) return;                                   // no intent → show original
//     if (intent.srcVersion !== currentSrcVersion) {          // edited since → revert
//       await deleteIntent(messageId);
//       await deleteTranslation(messageId);
//       return;                                               // show original
//     }
//     const c = await getTranslation(messageId);
//     if (c && c.srcVersion === currentSrcVersion && c.targetLang === intent.targetLang) {
//       store.getState().setEntry(messageId, {
//         status: 'translated', targetLang: c.targetLang,
//         translatedMarkdown: c.translatedMarkdown, srcVersion: c.srcVersion,
//       });
//     } else {
//       // content evicted/missing but intent says translated → re-translate (gated via #20).
//       store.getState().translate(messageId, intent.targetLang); // repopulates content on success
//     }
//   }
//
// AUTO mode (future): display is global (the auto setting), not per-message intent.
// Reconcile via §3.2 — auto applies only to messages WITHOUT a manual intent.
// The auto on/off + target-language SETTING persists AND syncs cross-device (§4.1.3),
// unlike these per-message manual intents (local, not cross-device).
//
// Multi-tab coherence (optional): broadcast messageId on BroadcastChannel after
// set/delete of intent or content so other tabs update their in-memory store.
// -----------------------------------------------------------------------------
