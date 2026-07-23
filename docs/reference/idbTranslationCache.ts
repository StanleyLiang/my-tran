// idbTranslationCache.ts
// -----------------------------------------------------------------------------
// Zero-dependency IndexedDB cache for message translation results.
// Pure module — no React / zustand imports. Values must be structured-cloneable.
//
// Eviction policy (this build):
//   - Soft cap: ~50 MB (byte-based), tracked via a running total in a `meta` store.
//   - Prune order: OLDEST FIRST by `updatedAt` (uses the byUpdatedAt index).
//   - Prune batch: up to 10,000 entries per prune pass.
//   - Trigger: after a write pushes totalBytes over the cap.
//
// Raw-IDB footguns handled:
//   1. Single shared connection (don't open a DB per call).
//   2. Never await non-IDB work inside a transaction (it auto-commits/closes).
//   3. Multi-tab upgrades: onversionchange (close) + onblocked.
//   4. Feature-detect + try/catch (Safari private mode / disabled storage) →
//      degrade to "cache miss" instead of throwing.
//   5. QuotaExceededError on write → prune then one retry.
//   6. navigator.storage.persist() best-effort against eviction.
// -----------------------------------------------------------------------------

export interface CachedTranslation {
  messageId: string;            // primary key (keyPath)
  targetLang: string;
  translatedMarkdown: string;
  srcVersion: string | number;  // message version at translate time → edit invalidation
  updatedAt: number;            // Date.now(); ORDERING KEY for oldest-first prune
  size: number;                 // estimated bytes of this record (for the 50MB cap)
}

const DB_NAME = 'msg-translations';
const DB_VERSION = 1;                    // bump + migrate in onupgradeneeded on schema change
const STORE = 'translations';
const META = 'meta';
const LRU_INDEX = 'byUpdatedAt';
const TOTAL_KEY = 'totalBytes';

const CAP_BYTES = 50 * 1024 * 1024;      // 50 MB soft cap
const PRUNE_BATCH = 10_000;              // delete up to this many oldest per prune

let dbPromise: Promise<IDBDatabase> | null = null;

function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

// Conservative byte estimate (CJK ~2 bytes/char; + fixed overhead for field
// names, primary key, the updatedAt index entry, and the numeric fields).
function estimateSize(r: Omit<CachedTranslation, 'size'>): number {
  const chars =
    r.messageId.length + r.targetLang.length + r.translatedMarkdown.length + String(r.srcVersion).length;
  return chars * 2 + 120;
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'messageId' });
        store.createIndex(LRU_INDEX, 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META); // out-of-line keys; we use the string TOTAL_KEY
      }
      // NOTE: if you upgrade from a build without `size`/`meta`, do a one-time
      // backfill here (scan STORE, sum estimateSize, write TOTAL_KEY).
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      /* another tab holds an older connection; it should close on versionchange */
    };
  });
  return dbPromise;
}

/** Read one message's cached translation (undefined on miss or any IDB error). */
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
    return undefined; // degrade: every failure is a cache miss
  }
}

/** Batch read (hydrate a whole viewport in ONE transaction). */
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
    /* degrade to whatever we collected */
  }
  return out;
}

// Internal: upsert a record and update the running total in ONE transaction.
// Returns the new totalBytes so the caller can decide whether to prune.
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

/** Upsert a translation. Stamps updatedAt, tracks bytes, prunes if over 50 MB. */
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
    if (total > CAP_BYTES) void prune(); // batch-evict 10k oldest (see note below)
  } catch {
    // Likely QuotaExceededError → free space then retry once.
    try {
      await prune();
      await putRecordTx(record);
    } catch {
      /* give up silently; in-memory store still holds it this session */
    }
  }
}

/** Remove one entry (use on revert / edit invalidation / delete). */
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
        if (!old) return; // nothing to delete; tx completes
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
 * Prune OLDEST-FIRST by updatedAt, up to PRUNE_BATCH (10,000) entries in one
 * pass, and decrement the running total by the freed bytes.
 * Returns how many entries were deleted.
 *
 * NOTE: one pass deletes up to 10k entries — normally far more than enough to
 * drop back under 50 MB. If you want a *hard* guarantee of being under the cap
 * even with pathologically large records, wrap the caller in:
 *   while ((await getTotalBytes()) > CAP_BYTES && (await prune()) > 0) {}
 */
export async function prune(): Promise<number> {
  if (!idbAvailable()) return 0;
  try {
    const db = await openDB();
    return await new Promise<number>((resolve, reject) => {
      let deleted = 0;
      let freed = 0;
      const tx = db.transaction([STORE, META], 'readwrite');
      const ts = tx.objectStore(STORE);
      const ms = tx.objectStore(META);
      const cursorReq = ts.index(LRU_INDEX).openCursor(null, 'next'); // ascending = oldest first
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor && deleted < PRUNE_BATCH) {
          const rec = cursor.value as CachedTranslation;
          freed += rec.size ?? estimateSize(rec);
          cursor.delete();
          deleted++;
          cursor.continue();
        } else {
          // batch done → decrement running total once
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

/** Current tracked cache size in bytes (0 on error). */
export async function getTotalBytes(): Promise<number> {
  if (!idbAvailable()) return 0;
  try {
    const db = await openDB();
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(META, 'readonly');
      const req = tx.objectStore(META).get(TOTAL_KEY);
      tx.oncomplete = () => resolve(((req.result as number) ?? 0));
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return 0;
  }
}

/** Bump updatedAt to now WITHOUT changing size — turns oldest-written eviction
 *  into least-recently-VIEWED eviction. Optional: call on a cache hit. */
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

/** Wipe cache + reset total. Do NOT call on logout (manual translations must
 *  survive logout/login per PRD). Use only for explicit clear / migration. */
export async function clearAll(): Promise<void> {
  if (!idbAvailable()) return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, META], 'readwrite');
      tx.objectStore(STORE).clear();
      tx.objectStore(META).put(0, TOTAL_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

/** Best-effort: ask the browser not to evict our storage under pressure. */
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
//   import { getTranslation, setTranslation, deleteTranslation, touch } from './idbTranslationCache';
//
//   // on translate success (inside the store's run()):
//   setTranslation({ messageId, targetLang, translatedMarkdown: out, srcVersion }); // auto-prunes at 50MB
//
//   // on revert() / onMessageEdited() / onMessageRemoved():
//   deleteTranslation(messageId);
//
//   // read-through when a message enters the viewport and the store has no entry.
//   // INVALIDATION POLICY (PRD §3.2 / §4.2.2.2): manual translations are STICKY per
//   // message. Invalidate ONLY on srcVersion change (message edited). Do NOT compare
//   // c.targetLang against the current global "Translate into" setting and re-translate
//   // — switching the target language must NOT re-translate already-translated messages.
//   // A message keeps whatever language it was translated into until the user explicitly
//   // re-translates it (which overwrites this one-entry-per-message record).
//   async function hydrateFromCache(messageId: string, currentSrcVersion: string | number) {
//     if (store.getState().byId[messageId]) return;
//     const c = await getTranslation(messageId);
//     if (c && c.srcVersion === currentSrcVersion) {
//       store.getState().setEntry(messageId, {
//         status: 'translated', targetLang: c.targetLang,
//         translatedMarkdown: c.translatedMarkdown, srcVersion: c.srcVersion,
//       });
//       // touch(messageId); // optional: make eviction least-recently-VIEWED
//     } else if (c) {
//       deleteTranslation(messageId); // stale (edited) → purge
//     }
//   }
//
// Multi-tab coherence (optional): broadcast messageId on BroadcastChannel('msg-translations')
// after set/delete so other tabs update their in-memory store.
// -----------------------------------------------------------------------------
