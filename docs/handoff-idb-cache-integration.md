# Handoff — 把 idbTranslationCache 接進現有的 messageTranslation store

> 執行者:**in-house coding agent(可存取原始碼)**
> 前提:UI 與 zustand store `messageTranslation` 的整合**已完成**。本任務只做「把 `docs/reference/idbTranslationCache.ts` 這支本地快取接上去,讓手動翻譯的顯示狀態與譯文跨 logout/login/reload 保留(本地、不跨裝置)」。
> 本文件作者看不到你的原始碼:凡是需要綁定你 store/元件的部分,以 `«placeholder»` 標記,由 agent 在 **Phase 0 Recon** 填實並 **STOP** 給人類確認,再動工。

---

## 0. 怎麼用這份 handoff

```
Phase 0 Recon    只讀不寫,填偵察表 → STOP,人類確認
Phase 1 對齊     覆述資料流與不變式 → STOP
Phase 2 實作     逐步接線,每步驗收
Phase 3 驗收     跑 Acceptance(對照情境 A–E)
```

**三條鐵律(放進 `AGENTS.md`,見 §7):**
1. 找不到本文提到的 store 欄位/action/元件 → 停下回報,**不准臆造**。
2. **只在翻譯成功時**寫 IDB;loading / failed 不寫。
3. 不碰併發/多分頁(F/G 本次排除);不改翻譯服務、不改 UI 外觀。

---

## 1. 背景與這支快取

`idbTranslationCache` 有**兩層**(已實作、勿改介面):
- **intent**(權威顯示旗標,永不淘汰):`{ messageId, mode:'manual', targetLang, srcVersion }`。存在 = 這則要顯示成翻譯。
- **content**(可重建譯文快取,50MB LRU):`{ messageId, targetLang, translatedMarkdown, srcVersion }`。可能被淘汰。

API(工廠 or 預設單例):
```ts
import { translationCache as cache } from '<path>/idbTranslationCache';
cache.intent.get/getMany/set/remove
cache.content.get/getMany/set/remove/touch/totalBytes
cache.maintenance.prune/clearAll/recover/requestPersistentStorage
```

---

## 2. 已確認的設計(不是 recon,直接照做)

### 2.1 srcVersion(edit 偵測的把手)
```ts
const srcVersionOf = (message) => message.edit?.timestamp ?? message.timestamp;
```
- 沒改過 → `message.timestamp`(發送時間,恆定)。
- 改過 → `message.edit.timestamp`(最新修改時間,每次 edit 變)。
- 已確認:reaction / pin **不會**動 `message.edit`(不會假失效);`message.edit` 改變**會 re-render**(畫面上被 edit 也會被重新比對)。
- 比對一律用 `!==`(只問「有沒有變」,不需單調遞增)。

### 2.2 決策(鎖定)
| 決策 | 定案 |
|---|---|
| D1 revert | **只刪 intent、留 content**(切回/再翻可秒回) |
| D4 還原策略 | **read-through per-view(惰性)**,可選對可見窗 `getMany` 預取 |
| D5 miss 判定 | `cache.content.get()` 回 `undefined`,或 `srcVersion`/`targetLang` 不匹配 = miss → 重翻 |
| D6 寫入時機 | **只在翻譯成功時**寫 intent + content |
| D7 IDB 不可用 | 當次 session 仍可翻,重載不保留 —— 可接受 |
| 範圍外 | **F(併發/爆量)、G(多分頁 BroadcastChannel + onBlocked 提示)本次不做** |

### 2.3 四個接線點
1. **寫**(翻譯成功):`cache.intent.set(...)` + `cache.content.set(...)`
2. **revert**:`cache.intent.remove(id)`(**不動 content**)
3. **失效**(edit / 刪除):`cache.intent.remove(id)` + `cache.content.remove(id)`,store 回原文
4. **read-through**(進 viewport 且 store 無 entry):intent 決定顯示;content 命中就渲染、miss 就重翻

### 2.4 權威資料流(照抄語意)
```
srcVersionOf(message) = message.edit?.timestamp ?? message.timestamp

// 在 bubble render / on-view 呼叫:
ensureTranslationForView(message):
  id = message.id ; sv = srcVersionOf(message) ; entry = store.byId[id]

  // (b) 已顯示翻譯、但訊息在翻譯後被 edit → 回原文
  if entry?.status === 'translated' && entry.srcVersion !== sv:
      store.revert(id); cache.intent.remove(id); cache.content.remove(id); return

  if entry: return                       // store 已有新鮮 entry,不用 hydrate

  // (a) 從快取 hydrate
  intent = await cache.intent.get(id)
  if !intent: return                     // 沒翻過 → 原文
  if intent.srcVersion !== sv:           // 翻完後被 edit → 丟棄
      cache.intent.remove(id); cache.content.remove(id); return
  content = await cache.content.get(id)
  hit = content && content.srcVersion === sv && content.targetLang === intent.targetLang
  if hit:
      store.setEntry(id, {status:'translated', targetLang: content.targetLang,
                          translatedMarkdown: content.translatedMarkdown, srcVersion: sv})
  else:
      store.translate(id, intent.targetLang)   // ★content miss → 重翻(用 intent 的 sticky 語言,不是全域設定)

// 翻譯成功(store 轉 translated 的地方)寫 IDB:
onTranslateSuccess(id, targetLang, translatedMarkdown, sv):
  cache.intent.set({ messageId:id, mode:'manual', targetLang, srcVersion: sv })
  cache.content.set({ messageId:id, targetLang, translatedMarkdown, srcVersion: sv })

// revert(See original):
onRevert(id): cache.intent.remove(id)          // 留 content

// 訊息被刪除:
onMessageRemoved(id): cache.intent.remove(id); cache.content.remove(id)
```

**不變式:**
- I1 **只在成功寫 IDB**;loading/failed 不寫。
- I2 重翻永遠用 **`intent.targetLang`(sticky)**,不是全域設定(切語言不重翻既有訊息)。
- I3 revert **只刪 intent**;edit/刪除 **刪 intent + content**。
- I4 快取呼叫**不阻塞 render**(fire-and-forget;讀取失敗當 miss)。
- I5 `store` 是顯示的即時來源;IDB 只是持久化 + hydrate 來源。

---

## 3. Phase 0 — Recon 偵察表(只讀不寫,填完 STOP)

| # | Placeholder / 問題 | 意義 | 填(符號 / 路徑 `file:line`) |
|---|---|---|---|
| P1 | `«messageTranslation store»` | store 檔案與建立處 | |
| P2 | `«store.byId[id]» 形狀` | 每則 entry 欄位:status 有哪些值?譯文/語言/版本欄位名? | |
| P3 | `«store.translate(id, lang)»` | 觸發翻譯的 action 名與簽章 | |
| P4 | `«翻譯成功的落點»` | status 轉 translated 在哪(action / reducer / subscription)——寫 IDB 要掛這 | |
| P5 | `«store.revert(id)»` | 切回原文的 action | |
| P6 | `«store.setEntry(id, ...)»` | 直接塞一則 translated 狀態的方法(hydrate 用);沒有就找等價 | |
| P7 | `«bubble / message 元件»` | 掛 `ensureTranslationForView` 的地方 | |
| P8 | **列表是否虛擬化?** | 決定 read-through 掛法(render vs IntersectionObserver) | yes / no |
| P9 | `«on-view hook»` | 進 viewport 的時機掛哪 | |
| P10 | `«取全域目標語言»` | 新翻譯用的當前設定(**注意:重翻用 intent.targetLang,不是這個**) | |
| P11 | store 是否已自帶 persist? | 避免與 IDB 雙重持久化/衝突 | |
| P12 | `idbTranslationCache.ts` import 路徑 | | |
| P13 | 驗證指令 | typecheck / test / dev | |

**確認題(非 recon,已定,但請一併核對真實欄位存在):**
- `message.timestamp`、`message.edit?.timestamp` 存在且如述(reaction/pin 不動 edit、edit 變會 re-render)。

**Recon 產出 = 上表填實 + 打算改動的檔案清單。STOP。**
> (建議)把填好的表貼回 Claude,用真實符號名把 §4 骨架再收斂一輪。

---

## 4. Phase 2 — 逐步實作(每步驗收)

### Step 1 — 基礎接線
- import cache 單例;新增 `srcVersionOf(message)` helper。
- **Verify:** typecheck 綠。

### Step 2 — 寫 IDB(翻譯成功)
- 在 P4 落點,status 轉 translated 時呼叫 `cache.intent.set` + `cache.content.set`(帶 `srcVersionOf(message)`)。
- **Verify:** 手動翻一則 → DevTools ▸ Application ▸ IndexedDB 看到 `intent` 與 `translations` 各一筆;reload 後(先做完 Step 5 才看得到還原,這步先確認有寫入)。

### Step 3 — revert(只刪 intent)
- 在 P5 revert action 呼叫 `cache.intent.remove(id)`(**不動 content**)。
- **Verify:** 翻譯→revert → intent 消失、content 還在;再翻同語言可秒回(Step 5 後驗)。

### Step 4 — edit / 刪除失效
- 訊息被刪:呼叫 `cache.intent.remove(id) + cache.content.remove(id)`。
- edit 的失效併入 Step 5 的 `ensureTranslationForView`(srcVersion 比對)。
- **Verify:** 見 Step 5。

### Step 5 — read-through / on-view(核心)
- 實作 `ensureTranslationForView(message)`(§2.4 語意),掛在 P7/P9。
- **Verify(對照情境):**
  - **A1**:翻一則 → reload → 該則自動顯示翻譯(從 intent+content 還原)。
  - **A3/E1**:手動清掉該則 content(或呼叫 `cache.content.remove`)後 reload → 進 viewport 觸發重翻、回填。
  - **edit(D)**:翻完後模擬該訊息 `message.edit.timestamp` 改變 → 該則回原文,且 intent/content 被清。
  - **C**:revert 後留著 content → 再顯示/再翻秒回。

### Step 6 —(可選)可見窗預取
- 若 P8 虛擬化:對可見範圍用 `cache.intent.getMany` / `cache.content.getMany` 批次預取,減少逐筆往返。
- **Verify:** 捲動不卡;行為與逐筆一致。

### Step 7 — 降級與 persist 衝突
- 確認 IDB 不可用(無痕)時:當次仍可翻譯、只是不持久(D7);不 crash。
- 若 P11 store 已自帶 persist:確認**不雙重持久化**(以 IDB 為譯文/intent 的持久來源;store persist 若有,排除翻譯欄位或關掉,recon 決定)。
- **Verify:** 無痕視窗跑一輪翻譯正常;typecheck/test 綠。

---

## 5. Phase 3 — Acceptance Checklist(對照情境 A–E)

- [ ] **A1** reload / 重開聊天室 → 先前翻譯過的訊息自動顯示為翻譯(intent+content 還原)。
- [ ] **A3 / E1** content 被淘汰但 intent 在 → 進 viewport 透明重翻並回填。
- [ ] **A4** 關 app 時某則正在 loading → 重載後回原文(無假 loading,因 loading 不寫 IDB)。
- [ ] **B1** 翻譯成功 → intent + content 各寫一筆。
- [ ] **B2** 換語言再翻 → content 覆蓋、intent 更新(維持一則一筆)。
- [ ] **C1** revert → 刪 intent、留 content;再翻/再顯示秒回。
- [ ] **D-edit** 翻完後訊息被 edit(srcVersion 變)→ 回原文 + 清 intent/content。
- [ ] **D-del** 訊息刪除 → 清 intent/content。
- [ ] **E2** 大量寫入觸發 prune → intent **從不**被刪。
- [ ] **D5** 重翻用 `intent.targetLang`(sticky),不是全域設定。
- [ ] **D7** 無痕/停用 IDB → 當次可用、重載不保留、不 crash。
- [ ] typecheck / test / 既有翻譯功能全綠(無退化)。

---

## 6. Guardrails
- ❌ 不在 loading/failed 寫 IDB(只在成功寫)。
- ❌ revert 不刪 content(只刪 intent);edit/刪除才刪兩者。
- ❌ 重翻不可用全域設定當語言 —— 一律 `intent.targetLang`。
- ❌ 不改 `idbTranslationCache` 的介面;不動 UI 外觀。
- ❌ 不做 F(併發閘門)/ G(BroadcastChannel、onBlocked 提示)。
- ❌ 快取讀寫不可阻塞 render;讀取失敗一律當 miss。
- ❌ 找不到 store 欄位/action → 停並回報,不臆造。
- ✅ 每步跑 Verify;不綠不前進。

---

## 7. 建議放進 `AGENTS.md`
```md
# AGENTS.md — 接 idbTranslationCache 任務規則
- 只做「把本地快取接進既有 messageTranslation store」;不改翻譯服務/UI 外觀/快取介面。
- 只在翻譯成功寫 IDB(intent+content);loading/failed 不寫。
- srcVersion = message.edit?.timestamp ?? message.timestamp;比對用 !==。
- revert 只刪 intent、留 content;edit(srcVersion 變)/刪除 才刪 intent+content。
- 重翻一律用 intent.targetLang(sticky),不是全域設定。
- 快取呼叫不阻塞 render;讀取失敗當 cache miss。
- 不做併發閘門與多分頁同步(F/G)。
- 找不到 store 欄位/action/元件 → 停並回報,不得臆造。
- 每步跑 <typecheck>/<test>;未過不進下一步。
```

---

## 8. 可貼進 agent 的提示(逐 Phase)
**Phase 0:**
```
Read docs/handoff-idb-cache-integration.md. Do ONLY Phase 0 (Recon).
Fill the recon table (§3) by searching/reading the codebase, with file:line evidence.
Answer P8 (virtualized?) and P11 (store already persists?) explicitly. Any missing row → NOT FOUND + STOP.
Do NOT write code. Output the table + files you plan to change. Then STOP.
```
**Phase 1:**
```
Restate the data flow and invariants (I1–I5) from §2 in your own words, mapped to the real store symbols you found. List anything ambiguous. STOP for confirmation. No code yet.
```
**Phase 2(每步一次):**
```
Implement Step <N> from §4, ONLY Step <N>. Follow §2.4 semantics and AGENTS.md.
Run the Step's Verify and report. If blocked, STOP. Do not start Step <N+1>.
```
**Phase 3:**
```
Run the Acceptance Checklist (§5) against the running app. Report each item pass/fail with evidence. List failures with proposed fixes.
```

---

## 9. 為什麼這樣能可靠執行
1. **Recon→STOP**:把「作者看不到 code + agent 會臆造」收斂成一張先填先停的偵察表。
2. **資料流已定死(§2.4)**:agent 只照抄語意 + 接四個點,不做架構決策。
3. **原子步驟 + 每步驗收 + Acceptance 對照情境 A–E**:小步紅綠燈,不退化。
4. **AGENTS.md 常駐護欄 + 逐 Phase 貼**:規則每回合都在,避免「假裝做完」。
5. srcVersion / edit / 決策全部已確認 —— 這份 handoff 幾乎沒有留白,只剩 store 形狀是 recon。
