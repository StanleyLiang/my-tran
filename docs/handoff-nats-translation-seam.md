# Handoff — TranslationService seam(NATS 傳輸整合)

> 執行者:**in-house coding agent(可存取原始碼)**
> 定位:把 issue #3 的 **NATS pub/sub 翻譯傳輸**收斂成前端 `TranslationService` seam(task #18 介面契約 / #4 real 實作 / #19 Mock)。
> 本文件作者看不到你的原始碼:凡需綁定你 code 的部分以 `«placeholder»` 標記,由 agent 在 **Phase 0 Recon** 填實並 **STOP** 給人類確認,再動工。
>
> 相關文件(同 repo):
> - `docs/handoff-translation-store-concurrency.md`(generation token / 併發閘門 / stale 防護)
> - `docs/handoff-idb-cache-integration.md`(本地快取 intent/content)
> - `docs/reference/idbTranslationCache.ts`(快取模組)
>
> 傳輸契約來源:issue #3 本文 + 「翻譯功能 — 前端 NATS 整合 SPEC」comment(**已定案**)。

---

## 0. 怎麼用這份 handoff

```
Phase 0 Recon    只讀不寫,填偵察表 → STOP,人類確認
Phase 1 對齊     覆述 seam 契約與資料流 → STOP
Phase 2 實作     Mock 先通 → 再接 real NATS,每步驗收
Phase 3 驗收     跑 Acceptance
```

**鐵律(放進 `AGENTS.md`,見 §9):**
1. seam **只負責傳輸**(publish + demux + timeout);generation token / stale 防護 / 併發閘門一律在 **store**,不在 seam。
2. 訂閱**只開一次**(app 生命週期),用 registry 依 `requestId` demux;**禁用** per-request subscribe/unsubscribe(有 race)。
3. 找不到 NATS client / `account` / `siteID` 來源 → **STOP** 回報,不准臆造。
4. `translatedText` 一律當 markdown 收下(見 §7);seam **不做**任何字串加工。

---

## 1. 鎖定的架構決策(不需再議)

| # | 決策 |
|---|---|
| D1 | **markdown 進 / markdown 出**;整則訊息翻譯(whole-message)。 |
| D2 | **sticky**:切換全域語言不重翻已翻訊息。 |
| D3 | 三態 UI:loading / success / failed。 |
| D4 | 傳輸為 **NATS pub/sub**,但 **seam 介面不變**——只換 seam 內部實作。 |
| D5 | 傳輸關聯用 **`requestId`(NATS)**;顯示/寫回關聯用 **`reqSeq`(store generation token)**。兩者職責不同,都要。 |
| D6 | 併發閘門保留且更重要(NATS 無連線數上限,更易灌爆後端;且無專屬背壓訊號)。 |

---

## 2. 傳輸契約(已定案,摘自 issue #3)

**送出(publish)** → `chat.user.{account}.request.translate.{siteID}`

```json
{ "requestId": "01970a4f-8c2d-7c9a-abcd-e0123456789f", "text": "原文", "targetLang": "zhTW" }
```

- `requestId`:前端產生的 36 字元 hyphenated UUID,**必填且唯一**(空的會收不到結果)。
- `text`:原文(宣告無長度上限;過長仍可能被後端拒,見 §8)。
- `targetLang` ∈ `zhTW | zhCN | en | de | ja`(不在清單 → `unsupported_lang`)。

**接收(subscribe)** → `chat.user.{account}.response.{requestId}`,建議掛在既有長訂閱 `chat.user.{account}.>` 上。

```jsonc
// 成功
{ "requestId": "...", "status": "ok", "translatedText": "你好,世界", "targetLang": "zhTW", "timestamp": 1700000000000 }
// 失敗
{ "requestId": "...", "status": "error", "targetLang": "fr", "error": "unsupported targetLang", "code": "bad_request", "reason": "unsupported_lang", "timestamp": 1700000000000 }
```

| 欄位 | 說明 |
|---|---|
| `status` | `"ok"` \| `"error"` |
| `translatedText` | 成功時才有;**視為 markdown**(見 §7) |
| `targetLang` | echo 回請求值 |
| `error` / `code` / `reason` | 失敗時的可讀文案 / 分類(`bad_request`/`internal`)/ 領域原因(`empty_text`/`unsupported_lang`) |
| `timestamp` | 發布時間(UTC ms) |

---

## 3. seam 介面契約(task #18,mock/real 共用)

```ts
export type TargetLang = 'zhTW' | 'zhCN' | 'en' | 'de' | 'ja';

export interface TranslateResult {
  translatedMarkdown: string;   // = response.translatedText(視為 markdown,見 §7)
}

// 傳輸/領域錯誤;store 依 code/reason 決定 UI 文案與可否 retry
export class TranslationError extends Error {
  constructor(
    public code: string,               // 'bad_request' | 'internal' | 'timeout' | 'aborted'
    public reason: string | undefined, // 'empty_text' | 'unsupported_lang' | undefined
    message: string,
  ) { super(message); }
}

export interface TranslationService {
  translate(
    text: string,
    targetLang: TargetLang,
    opts?: { signal?: AbortSignal },   // abort 由 store 的 per-message AbortController 帶入
  ): Promise<TranslateResult>;
}
```

store 只依賴這個介面;Mock(#19)與 NATS real(#4)各自實作它。**store 不需要知道 NATS 存在。**

---

## 4. NATS real 實作骨架(#4,欄位已填實)

```ts
type Pending = {
  resolve: (r: TranslateResult) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pending = new Map<string, Pending>();

export function createNatsTranslationService(deps: {
  publish: (subject: string, payload: unknown) => void;
  getAccount: () => string;   // «Phase 0:來源»
  getSiteID: () => string;    // «Phase 0:來源»
  timeoutMs: number;          // 建議 10_000–15_000(SPEC §6)
}): TranslationService {

  // 訂閱只開一次;若已有 chat.user.{account}.> 長訂閱,把 handler 掛上去即可
  ensureResponseSubscription(onResponseMessage); // «Phase 0:既有訂閱掛點»

  return {
    translate(text, targetLang, opts) {
      const requestId = crypto.randomUUID();
      return new Promise<TranslateResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new TranslationError('timeout', undefined, `translate timeout: ${requestId}`));
        }, deps.timeoutMs);

        pending.set(requestId, { resolve, reject, timer });

        opts?.signal?.addEventListener('abort', () => {
          const e = pending.get(requestId);
          if (!e) return;
          clearTimeout(e.timer); pending.delete(requestId);
          reject(new TranslationError('aborted', undefined, 'aborted'));
        }, { once: true });

        deps.publish(
          `chat.user.${deps.getAccount()}.request.translate.${deps.getSiteID()}`,
          { requestId, text, targetLang },
        );
      });
    },
  };
}

// 單一訂閱 handler:依 requestId demux(本帳號所有 response.* 都會進來)
function onResponseMessage(payload: any) {
  const rid = payload?.requestId;
  const entry = rid && pending.get(rid);
  if (!entry) return;                 // 不是我們的翻譯 / 已逾時或 abort → 忽略
  clearTimeout(entry.timer); pending.delete(rid);

  if (payload.status === 'ok') {
    entry.resolve({ translatedMarkdown: payload.translatedText });
  } else {
    entry.reject(new TranslationError(payload.code, payload.reason, payload.error ?? 'translate failed'));
  }
}
```

**要點**
- **單訂閱 + registry demux**:`chat.user.{account}.>`(SPEC 建議)天生無 race;禁用逐次訂閱。
- **多分頁/多裝置**:同帳號其他分頁的請求回應也會流進本 handler,`pending.get(rid)` 找不到就自動忽略——這正是 SPEC §7「一定要用 requestId 過濾」的處理。
- **timeout 必備**:core NATS at-most-once,回應遺失就永久 loading;逾時 → reject(`code:'timeout'`)→ store 進 failed(可 retry)。
- **reconnect**:斷線期間到達的回應會遺失;reconnect 後仍在 `pending` 的請求交由 timeout 收尾(或在 reconnect 事件主動 reject 全部 pending)。
- **seam 不碰 reqSeq**:promise resolve 後,由 **store** 比對 `reqSeq` 是否仍為該 messageId 最新,再決定寫不寫。

---

## 5. 送出前的 client 驗證(擋掉可預防的錯誤)

SPEC 的 `empty_text` / `unsupported_lang` 都是**前端可預防**的,送出前先擋,避免浪費一趟往返:

- `text.trim() === ''` → 不送,直接視為 no-op(或提示)。
- `targetLang` 不在 `TargetLang` 清單 → 不送(UI 本來就只該給清單內語言)。

若這兩個 `reason` 仍從後端回來,視為**前端 bug**(該擋沒擋),記 log。

---

## 6. 錯誤 → UI 對應(交給 store,seam 只丟 `TranslationError`)

| `code` / `reason` | 意義 | store/UI 處理 |
|---|---|---|
| `timeout` | 逾時未收到回應 | failed;可 retry |
| `internal` | 後端翻譯失敗 | failed「翻譯暫時失敗,請重試」;可 retry(**見 §8 退避**) |
| `bad_request` / `empty_text` | 空字串 | 理論上已被 §5 擋掉;若出現記 log,不 retry |
| `bad_request` / `unsupported_lang` | 語言不支援 | 同上,不 retry |
| `aborted` | 使用者 abort / 被新請求取代 | 不算 failed,靜默丟棄 |

---

## 7. markdown 保真(non-blocking,標記待確認)

- seam **直接**把 `translatedText` 當 `translatedMarkdown` 收下,**不做任何加工**。
- ⚠️ **待與後端確認**:我們送的 `text` 是整則訊息 markdown(含 `**粗體**`、code block、URL、`@mention`、emoji shortcode)。需確認 `translatedText` **保留 markdown 結構**且**不翻譯** code / URL / mention。
- 這屬**翻譯品質**(task #5「Markdown 保真 prompt/參數」),**不擋本 seam 接線**。若後端確認會破壞結構,對策放在後端 prompt/參數或 task #5,不改本 seam。

---

## 8. 背壓 / rate-limit(non-blocking,client 端自律)

SPEC **沒有**專屬的限流/背壓訊號(過載只會回泛用 `code:'internal'`)。在後端補訊號前,防線全在 client:

1. **併發閘門**(`maxConcurrent` + queue)——主動限制同時 in-flight 數(見 `handoff-translation-store-concurrency.md`)。**最重要的自律**。
2. **retry 要有上限 + backoff + jitter**——避免過載時的 retry storm。
3. **自動翻譯**(未來)要做**節流/去抖 + 批次**,不要每則訊息各送一發。

> 選配後端需求(低成本、對自動翻譯上線很有價值):error 回應增加 `code:'rate_limited'` + `retryAfterMs`。屆時 client 只在被限流時退避、並 honor `retryAfterMs`,而非盲目重試。**本 seam 已把 `code` 原樣帶出**,補上時 store 端加一條分支即可,不改 seam 介面。

---

## 9. Phase 0 Recon(newchat 專屬,填完 STOP)

| 項目 | 待填 |
|---|---|
| NATS client 實例位置、publish/subscribe wrapper | `«...»` |
| 目前是否已有 `chat.user.{account}.>` 長訂閱?掛在哪?能否加 handler? | `«...»` |
| `account` 來源(session/user context) | `«...»` |
| `siteID` 來源 | `«...»` |
| message 原文 markdown 怎麼取(送去當 `text`) | `«...»` |
| 既有 `messageTranslation` store 的 translate action 目前怎麼呼叫服務(要換成本 seam) | `«...»` |
| 採用 `timeoutMs`(建議 10–15s) | `«...»` |

---

## 10. 驗收清單

- [ ] Mock seam 能讓 UI/store 跑通三態(#19)。
- [ ] real seam:`translate()` publish 到正確 subject、payload 三欄位正確。
- [ ] 單訂閱依 `requestId` 正確 demux;非本次 / 其他分頁的 response 不誤觸。
- [ ] `status:'ok'` → resolve `translatedMarkdown`;`status:'error'` → reject `TranslationError(code, reason)`。
- [ ] timeout(10–15s)觸發 → store 進 failed 且可 retry。
- [ ] abort(per-message)→ reject `code:'aborted'`、registry 清乾淨、無殘留 timer。
- [ ] 送出前擋 `empty_text` / `unsupported_lang`。
- [ ] 快點多則不同訊息 → 各自 requestId 不互串;store 依 reqSeq 只寫最新。
- [ ] (待 §7 後端確認)結果為 markdown 且 code block / URL / mention / emoji 未被翻壞。

---

## 11. AGENTS.md 片段

```
# Translation — NATS seam
- seam 只做傳輸(publish + demux + timeout)。generation token / stale / 併發閘門一律在 store。
- 訂閱只開一次(app 生命週期),依 requestId demux;禁用 per-request subscribe/unsubscribe。
- translatedText 一律當 markdown 收下,seam 不做字串加工。
- 送出前擋 empty_text / unsupported_lang;逾時 code='timeout'、abort code='aborted'。
- 找不到 NATS client / account / siteID 來源 → STOP 回報,不臆造。
```

---

_關聯:issue #3(NATS 傳輸規格,已定案)。未決且非阻塞:§7 markdown 保真、§8 rate-limit 訊號。_
