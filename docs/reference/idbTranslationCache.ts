// idbTranslationCache.ts
// -----------------------------------------------------------------------------
// Zero-dependency IndexedDB cache for message translation results.
// Pure module — no React / zustand imports. Values must be structured-cloneable.
//
// Handles the raw-IDB footguns:
//   1. Single shared connection (don't open a DB per call).
//   2. Never await non-IDB work *inside* a transaction (it auto-commits/closes).
//   3. Multi-tab upgrades: onversionchange (close) + onblocked.
//   4. Feature-detect + try/catch (Safari private mode / disabled storage) →
//      degrade gracefully to "cache miss" instead of throwing.
//   5. QuotaExceededError → prune (LRU) then one retry.
//   6. LRU eviction via an index on `updatedAt`.
//   7. navigator.storage.persist() best-effort so the browser is less likely
//      to evict us under storage pressure.
// -----------------------------------------------------------------------------

export interface CachedTranslation {
  messageId: string;            // primary key (keyPath)
  targetLang: string;
  translatedMarkdown: string;
  srcVersion: string | number;  // message version at translate time → edit invalidation
  updatedAt: number;            // Date.now() at last write; LRU ordering key
}

const DB_NAME = 'msg-translations';
const DB_VERSION = 1;               // bump + handle in onupgradeneeded when schema changes
const STORE = 'translations';
const LRU_INDEX = 'byUpdatedAt';
const MAX_ENTRIES = 5000;           // tune to your expected history size

let dbPromise: Promise<IDBDatabase> | null = null;

function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false; // some privacy modes throw on mere access
  }
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
      // If you add fields/indexes later, migrate here based on the old version.
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
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
    // Another tab holds an older connection open and blocks our upgrade.
    req.onblocked = () => {
      // Best-effort: nothing to do here except wait; that tab's onversionchange
      // should close it. Left as a hook for logging.
    };
  });
  return dbPromise;
}

/**
 * Run one transaction. `run` must ONLY enqueue IDB requests synchronously —
 * do not await anything non-IDB inside it, or the transaction auto-commits.
 * Resolves with the last request's result (or undefined for writes).
 */
function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return openDB().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        let req: IDBRequest<T> | void;
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        try {
          req = run(store);
        } catch (e) {
          reject(e);
          return;
        }
        tx.oncomplete = () => resolve(req ? (req as IDBRequest<T>).result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

/** Read one message's cached translation (undefined on miss or any IDB error). */
export async function getTranslation(messageId: string): Promise<CachedTranslation | undefined> {
  if (!idbAvailable()) return undefined;
  try {
    return await withStore<CachedTranslation>('readonly', (s) => s.get(messageId));
  } catch {
    return undefined; // degrade: treat every failure as a cache miss
  }
}

/** Batch read (e.g. hydrate a whole viewport in ONE transaction). */
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
    // degrade: return whatever we managed to collect
  }
  return out;
}

/** Upsert a translation. Stamps updatedAt (LRU). Fire-and-forget LRU prune. */
export async function setTranslation(
  entry: Omit<CachedTranslation, 'updatedAt'> & { updatedAt?: number },
): Promise<void> {
  if (!idbAvailable()) return;
  const record: CachedTranslation = { ...entry, updatedAt: entry.updatedAt ?? Date.now() };
  try {
    await withStore('readwrite', (s) => s.put(record));
    void prune(); // keep bounded; runs its own transaction
  } catch {
    // Likely QuotaExceededError → free space then retry once.
    try {
      await prune(Math.floor(MAX_ENTRIES * 0.8));
      await withStore('readwrite', (s) => s.put(record));
    } catch {
      // Give up silently: the in-memory store still holds the value this session.
    }
  }
}

/** Remove one entry (use on revert / edit invalidation / delete). */
export async function deleteTranslation(messageId: string): Promise<void> {
  if (!idbAvailable()) return;
  try {
    await withStore('readwrite', (s) => s.delete(messageId));
  } catch {
    /* ignore */
  }
}

/** Wipe the whole cache. NOTE: do NOT call on logout — PRD requires manual
 *  translations to survive logout/login. Use only for explicit "clear" or migration. */
export async function clearAll(): Promise<void> {
  if (!idbAvailable()) return;
  try {
    await withStore('readwrite', (s) => s.clear());
  } catch {
    /* ignore */
  }
}

/** LRU eviction: if count > cap, delete oldest-by-updatedAt until within cap. */
export async function prune(cap: number = MAX_ENTRIES): Promise<void> {
  if (!idbAvailable()) return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const countReq = store.count();
      countReq.onsuccess = () => {
        let toDelete = countReq.result - cap;
        if (toDelete <= 0) return; // tx will complete
        const cursorReq = store.index(LRU_INDEX).openCursor(null, 'next'); // oldest first
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && toDelete > 0) {
            cursor.delete();
            toDelete--;
            cursor.continue();
          }
        };
      };
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
// Integration sketch (put this in your translation store / bubble, NOT here):
//
//   import { getTranslation, setTranslation, deleteTranslation } from './idbTranslationCache';
//
//   // on translate success (inside the store's run()):
//   setTranslation({ messageId, targetLang, translatedMarkdown: out, srcVersion });
//
//   // on revert() / onMessageEdited() / onMessageRemoved():
//   deleteTranslation(messageId);
//
//   // read-through when a message enters the viewport and the store has no entry:
//   async function hydrateFromCache(messageId: string, currentSrcVersion: string | number) {
//     if (store.getState().byId[messageId]) return;              // already in memory
//     const c = await getTranslation(messageId);
//     if (c && c.srcVersion === currentSrcVersion) {             // version match = valid
//       store.getState().setEntry(messageId, {
//         status: 'translated',
//         targetLang: c.targetLang,
//         translatedMarkdown: c.translatedMarkdown,
//         srcVersion: c.srcVersion,
//       });
//     } else if (c) {
//       deleteTranslation(messageId);                            // stale (edited) → purge
//     }
//   }
//
// Multi-tab coherence (optional): after setTranslation/deleteTranslation, post the
// messageId on a BroadcastChannel('msg-translations') so other tabs update their
// in-memory store (IndexedDB does not broadcast writes on its own).
// -----------------------------------------------------------------------------
