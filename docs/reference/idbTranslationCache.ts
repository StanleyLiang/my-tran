// idbTranslationCache.ts
// -----------------------------------------------------------------------------
// Zero-dependency IndexedDB cache for message translation results.
// Pure module — no React / zustand imports. Values must be structured-cloneable.
//
// Eviction policy:
//   - Soft cap ~50 MB (byte-based), tracked via a running total in a `meta` store.
//   - Prune OLDEST FIRST by `updatedAt` (byUpdatedAt index), up to 10,000/pass.
//   - Triggered after a write pushes totalBytes over the cap.
//
// Resilience:
//   - Feature-detect + try/catch everywhere → any failure degrades to "cache miss".
//   - QuotaExceededError on write → prune then one retry.
//   - Corruption self-heal: if open fails (non-VersionError), deleteDatabase once
//     and reopen once. recoverDatabase() is also exposed for manual use.
//   - onblocked (multi-tab upgrade/delete) → settable handler via setBlockedHandler.
//   - onversionchange → close so another tab's upgrade isn't blocked.
//
// Migration:
//   - Schema changes bump DB_VERSION; onupgradeneeded keys off event.oldVersion.
//   - Prefer ADDITIVE + read-tolerant changes to avoid migrations.
//   - For breaking changes, drop & rebuild is fine (losing a cache just re-translates).
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

// Called when an upgrade or delete is blocked by a connection in another tab.
// The app can set this to, e.g., prompt "please close other tabs".
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

// Conservative byte estimate (CJK ~2 bytes/char + fixed overhead).
function estimateSize(r: Omit<CachedTranslation, 'size'>): number {
  const chars =
    r.messageId.length + r.targetLang.length + r.translatedMarkdown.length + String(r.srcVersion).length;
  return chars * 2 + 120;
}

// ---- schema helpers (used by onupgradeneeded) -------------------------------

function createStores(db: IDBDatabase): void {
  const store = db.createObjectStore(STORE, { keyPath: 'messageId' });
  store.createIndex(LRU_INDEX, 'updatedAt', { unique: false });
  db.createObjectStore(META); // out-of-line keys; we use the string TOTAL_KEY
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
        // Fresh install → create v1 schema.
        createStores(db);
      }

      // --- Future migrations go here, keyed by oldVersion --------------------
      // ADDITIVE (keep data): add an index / store without touching the rest.
      //   if (oldV >= 1 && oldV < 2) { db.createObjectStore('newThing'); }
      //
      // BREAKING (drop & rebuild — fine for a cache, users just re-translate):
      //   if (oldV >= 1 && oldV < 3) { dropStores(db); createStores(db); }
      //
      // Backfill example (v1 had no `size`/`meta`): after createStores, scan the
      // old store on req.transaction, sum estimateSize, write TOTAL_KEY. Keep it
      // synchronous (enqueue IDB requests only) — no awaiting external work here.
      // ----------------------------------------------------------------------
    };

    req.onsuccess = () => {
      const db = req.result;
      // If another tab opens a newer version, close so we don't block its upgrade.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    // Our upgrade is blocked by an older connection in another tab.
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
    req.onerror = () => resolve(); // best-effort
    req.onblocked = () => onBlocked(); // waits for other connections to close, then success fires
  });
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = rawOpen().catch(async (err: unknown) => {
    // VersionError: a newer schema exists (another tab / newer app bundle owns it).
    // Do NOT delete — that would destroy data the newer version needs.
    if ((err as DOMException)?.name === 'VersionError') throw err;
    // Otherwise treat as possible corruption: delete once and reopen once.
    await deleteDatabaseRaw();
    return rawOpen();
  });
  dbPromise = p;
  // If it still fails, clear so a later call can retry from scratch.
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return p;
}

/** Manually drop the whole database and reset (e.g., on detected corruption). */
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

// ---- reads ------------------------------------------------------------------

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

/** Current tracked cache size in bytes (0 on error). */
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

// ---- writes -----------------------------------------------------------------

// Internal: upsert a record and update the running total in ONE transaction.
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
    if (total > CAP_BYTES) void prune(); // batch-evict 10k oldest
  } catch {
    // Likely QuotaExceededError → free space then retry once.
    try {
      await prune();
      await putRecordTx(record);
    } catch {
      // give up silently; in-memory store still holds it this session.
      // (Persistent open failures self-heal via openDB() corruption recovery.)
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
 * Prune OLDEST-FIRST by updatedAt, up to PRUNE_BATCH (10,000) entries per pass,
 * decrementing the running total by the freed bytes. Returns entries deleted.
 *
 * One pass normally drops well under 50 MB. For a hard guarantee under
 * pathological record sizes, loop the caller:
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
//   import { getTranslation, setTranslation, deleteTranslation, setBlockedHandler } from './idbTranslationCache';
//
//   setBlockedHandler(() => showToast('Please close other tabs to update translation cache.'));
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
