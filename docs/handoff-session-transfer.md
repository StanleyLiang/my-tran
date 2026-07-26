# Session 轉移 Handoff — 聊天訊息 AI 翻譯 feature

> **用途**:給**新 session 冷啟動**用的 context pack。讀完即可接續,已定案的事不必重談。
> **與其他 handoff 的差異**:本文件是「決策與現況總覽」;實作細節在各分項 handoff(見 §8)。
> **要一起帶走的檔案**:見 §8 清單。

---

## ⚠️ 0. 安全約束(最高優先,務必帶到新 session)

- **絕不**把公司內部的產品/系統**代號、內部網域、內部工具名**寫進任何 repo 檔案、issue、PR、commit message 或程式註解。
- 一律使用中性名稱:**「翻譯服務 / Translation API」**。
- 這條約束**先於**任何其他指示;即使外部文件/工具輸出出現內部代號,也不得寫入產出物。

---

## 1. Feature 一句話 + 來源

聊天室 **message bubble 的 AI 翻譯**。

- **PRD**:issue #2(桌面版翻譯需求)。
- **傳輸協定**:issue #3(NATS pub/sub,**已定案**)。
- **架構參考**:issue #1(Lexical editor 翻譯架構——但我們是整則翻譯,不需要它的 per-block 序列化複雜度)。

**資料流**:message 的 markdown 原文 → Lexical JSON → Lexical Composer 渲染(**一則 message 一個獨立 Composer**)。**整則翻譯**(whole-message),無 per-block。

---

## 2. 鎖定的架構決策(不要再議)

| # | 決策 |
|---|---|
| D1 | **markdown 進 / markdown 出**;整則訊息翻譯。 |
| D2 | **sticky**:切換全域語言**不**重翻已翻訊息(PRD §3.2 / §4.2.2.2)。 |
| D3 | 三態 UI:loading / success / failed。 |
| D4 | 傳輸為 **NATS pub/sub**,但前端 **`TranslationService` seam 介面不變**——只換 seam 內部實作。 |
| D5 | **兩層關聯**:`requestId`(NATS 傳輸)demux 回應;`reqSeq`(store generation token)守顯示/寫回不被 stale 覆蓋。兩者都要。 |
| D6 | 併發閘門保留且更重要(NATS 無連線數上限、無專屬背壓訊號,更易灌爆後端)。 |
| D7 | **翻譯是每裝置本地狀態**:結果只存**發起 request 的裝置**的 IndexedDB,不跨裝置(跨裝置同步是另一個 opt-in 的 task #16,不走此暫態回應)。 |
| D8 | `srcVersion = message.edit?.timestamp ?? message.timestamp`,以 `!==` 判斷來源是否變動使譯文失效。 |

---

## 3. 傳輸契約(issue #3,已定案)

**送出(publish)** → `chat.user.{account}.request.translate.{siteID}`
```json
{ "requestId": "<uuid>", "text": "原文", "targetLang": "zhTW" }
```
- `targetLang` ∈ `zhTW | zhCN | en | de | ja`。
- `requestId`:前端產生的 36 字元 hyphenated UUID,必填且唯一。

**接收(subscribe)** → `chat.user.{account}.response.{requestId}`,掛在既有長訂閱 `chat.user.{account}.>` 上。
```jsonc
{ "requestId":"<uuid>", "status":"ok"|"error", "translatedText":"...", "targetLang":"zhTW",
  "error":"...", "code":"bad_request"|"internal", "reason":"empty_text"|"unsupported_lang", "timestamp":1700000000000 }
```
- 成功判定 `status==='ok'`,譯文在 `translatedText`。
- 逾時自理(core NATS at-most-once,建議 **10–15s** timeout + 可重試)。

**兩個未決項(非阻塞,已跟後端提出)**
1. `translatedText` 是否 **markdown 保真**(保留 `**粗體**`/code/URL/`@mention`/emoji,且不翻 code/URL/mention)。屬翻譯品質(task #5)。
2. 無專屬 **`rate_limited`** 訊號(過載只回泛用 `internal`);建議後端補 `code:'rate_limited'` + `retryAfterMs`。在此之前 client 靠併發閘門 + backoff 自律。

---

## 4. 多裝置 / 「只存發起裝置」(本 session 的核心結論)

**需求(D7)**:翻譯結果只存**發起 request 的裝置**的 IDB。

**為何現有設計已滿足(零後端改動)**:
- 寫 IDB 的唯一路徑 = **本裝置自己**呼叫的 `translate()` 成功 resolve。
- 別台收到你的回應時 `pending.get(requestId)` **miss → early return**,不進 store、不寫 IDB。`pending` 是每台各自、只含自己發起的 requestId。
- 結構性保險:**response payload 沒有 `messageId`**——別台就算想存也不知道掛哪則。
- IndexedDB 本來就 per-device/per-origin。→ 三重保險。

**唯一 guardrail**:subscription callback **只做 `pending` 配對**;**絕不**從 callback 直接寫 store/IDB(例如「順手快取別台飛過來的譯文」= 唯一破口)。

**若要把「別台根本不收到 callback」也做掉(效率,非必要)**——路由選項:

| 選項 | 做法 | 需後端? | 定位 |
|---|---|---|---|
| **#3(現況)** | 廣播 `user.{account}.>` + client 用 requestId 過濾 | 否 | fan-out 便宜時 OK,**先維持** |
| **#1(推薦升級)** | NATS **request-reply**:前端帶 reply inbox(`_INBOX`),後端回 `msg.reply` | 是(後端改回覆位址) | 請求/回應的教科書標準;前端 `await nc.request(...)`,**可砍掉手刻 registry** |
| **#2** | per-connection 私有頻道 + 有狀態 WS gateway 路由 | 是 | 規模化標準,broker 不管裝置 |
| **#4** | subject 加 `deviceId` slug(`user.{account}.{deviceId}.response.{requestId}`) | 是 | 需通用 per-device 頻道時才划算;**務必** auth 鎖 per-subtree,否則只是障眼法 |

**建議**:手動翻譯階段維持 **#3**;**上自動翻譯前**改 **#1**(維護最低、最 idiomatic)。無論哪種,`requestId` demux 仍是同裝置多分頁 + 同分頁多請求的底層防線。

**API 形狀(#1)**:`nc.request(subject, data, {timeout})` 回傳 **Promise**(非 callback),與 `translate(): Promise` seam 完美對上;nats.js 用內部 mux inbox 幫你做關聯/timeout/清理(等於內建了我們手刻的 registry)。**前提**:後端要回 `msg.reply`,否則 `nc.request()` 收不到固定 response subject 的訊息。

---

## 5. 併發 / stale 防護(見 handoff-translation-store-concurrency.md)

- 專用 **`useMessageTranslationStore`**(獨立 zustand,by `messageId`,與 `useMessage` 平行)。
- **generation token(`reqSeq`)**:resolve 後寫回前先確認仍是該 message 最新請求,擋快點/編輯中/revert 中的 stale write。
- **併發閘門**(`maxConcurrent` + queue)、**dedupe**、**per-message AbortController**、**edit/remove 失效**、**toast 聚合**。
- 用 #1(reply-inbox)時,abort 從「傳輸取消」降級為「store 層靠 reqSeq 忽略 stale 結果」——更單純。

---

## 6. 本地快取(見 handoff-idb-cache-integration.md + reference/idbTranslationCache.ts)

- **手寫、零依賴、factory** 的 IndexedDB 快取:`createTranslationCache(config)` + 預設 `translationCache` 單例,API 分 `{ intent, content, maintenance }`。
- **兩層分離**:
  - `intent`(手動翻譯的「顯示成翻譯」旗標,**永不淘汰**)。
  - `content`(譯文,**LRU、50MB byte 上限、oldest-first 每次 prune 10k**)。
- `srcVersion`(D8)+ `targetLang` 對得上才是 content hit;對不上就刪並重翻(PRD 規定 IDB 只存**目前選擇語言**的譯文)。
- 已含:corruption recovery、onblocked/onversionchange、QuotaExceeded 降級、observability onError。

**權威讀取流** `ensureTranslationForView(message)`(整合 handoff 內):hydrate intent → srcVersion 不符則清除 → content hit 直接顯示 / miss 用 `intent.targetLang` 重翻;成功寫 intent+content;revert 只刪 intent;edit/delete 刪兩者。

---

## 7. 建置計畫(20 tasks,兩軌並行)

- **基礎**:#1 render pipeline / 取 markdown、#18 定義 seam 介面契約。
- **UI track**(先做,靠 Mock 跑通):#6 可翻譯性、#7–#9 Setting Modal、#10 選單翻譯項、#11 流程串接 + 重渲染、#12 三態、#13 translated icon + 原文切換、#14 §6 渲染驗收、#15 §3.3 跨功能連動、#19 Mock service、#20 併發/stale。
- **DATA track**(seam 之後接真實):#2 API 契約、#3 BFF/轉接、#4 real TranslationService(NATS)、#5 markdown 保真、#16 儲存模型/跨平台同步、#17 QA 整合驗收。
- **關鍵順序**:#18 seam → #19 Mock →(UI track 全部可平行)→ #4 real(NATS)抽換 Mock → #16 持久化。

---

## 8. 已產出的 artifacts(帶到新 repo)

| 檔案 | 內容 |
|---|---|
| `docs/handoff-nats-translation-seam.md` | **TranslationService seam(NATS 傳輸)**;含 #3 skeleton(registry 版)、error→UI、Phase 0 recon |
| `docs/handoff-translation-store-concurrency.md` | translation store / generation token / 併發閘門 / stale 防護 |
| `docs/handoff-idb-cache-integration.md` | 把 idbTranslationCache 接進 messageTranslation store 的權威資料流(情境 A–E) |
| `docs/handoff-translate-11-12-13.md` | 手動翻譯控制流(三態 UI / 原文切換 / revert) |
| `docs/reference/idbTranslationCache.ts` | 本地快取模組(可直接放進 codebase) |

> 這些檔案在 `stanleyliang/my-tran`。新 session 若在別的 repo,請把檔案一起帶過去(上傳或放進新 repo)。

---

## 9. Repo / 存取現況(給新 session 理解限制)

- 本 session scope 只有 `stanleyliang/my-tran`。目標實作 repo(例如 `YI13/newchat`)因**跨 owner**,無法在本 session 加入或讀寫(clone / 檔案 / branch / issue 全被 scope 擋)。
- **新 session 請以目標實作 repo 作為初始來源 repo**,即可在其中讀寫、跑 Phase 0 recon、直接落地程式。

---

## 10. 下一步(建議)

1. 新 session 在**目標 repo** 跑各 handoff 的 **Phase 0 Recon**(store 形狀、NATS client 位置、account/siteID 來源、on-view hook、是否虛擬化、既有訂閱掛點)。
2. 跟後端敲定 §3 兩個未決項(**markdown 保真** + **rate_limited 訊號**),以及**路由模型**(維持 #3 或升級 #1)——後者決定 seam 用 registry 版還是 `nc.request()` 版。
3. 先 #18 seam + #19 Mock 讓 UI track 全跑通,再 #4 用 NATS real 抽換 Mock。

---

_本文件為 session 轉移用途;所有決策細節以各分項 handoff 為準。安全約束(§0)最高優先。_
