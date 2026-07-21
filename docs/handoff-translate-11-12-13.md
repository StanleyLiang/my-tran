# Handoff Plan — Manual Translate 控制流(Tasks #11 / #12 / #13)

> 執行者:**opencode + qwen(本機、可存取原始碼)**
> 委託者:你(可讀 code、curate 此計畫)
> 這份文件的作者看不到你的原始碼,所以所有「與你的檔名/符號綁定」的部分,都以 `«placeholder»` 標記,由執行的 agent 在 **Phase 0 偵察** 時填實,並**先停下來給你確認**再動工。

---

## 0. 怎麼使用這份 Handoff(重要)

因為(a)本計畫作者看不到 code、(b)qwen 比 Claude 弱,容易臆造 API,所以**不要**一次把整份丟給 qwen 叫它「做完」。請照這個迴圈:

```
Phase 0  Recon 偵察      qwen 只讀不寫,填好「偵察表」→ STOP,你檢查
   │                      (可選)把偵察表貼回 Claude,讓它用真實符號名把 Phase 2 步驟再收斂一次
   ▼
Phase 1  對齊契約         qwen 覆述「狀態機 + 控制流」理解 → STOP,你確認它沒理解錯
   ▼
Phase 2  逐步實作         一次一個 Step;每個 Step 完成就跑該 Step 的「驗收指令」→ 綠燈才下一步
   ▼
Phase 3  驗收             跑完整 Acceptance checklist(對照 PRD §4.2.2)
```

**給 qwen 的三條鐵律(請放進 `AGENTS.md`,見 §7):**
1. 找不到本文提到的符號/檔案時,**停下來回報,不准自己發明**。
2. 只透過 `«TranslationService»` 介面呼叫翻譯;**不准碰資料整合軌(後端 / 翻譯服務 / 持久化)**。
3. 渲染翻譯結果時**重用既有的 markdown→Lexical 渲染路徑**,不准自己新寫 Lexical 序列化程式。

---

## 1. Scope — 這次只做什麼

**目標:** 把聊天室桌面版「單則他人訊息手動翻譯」的**互動控制流**接起來,對接 **Mock TranslationService**(Task #19),完全不碰後端。

| 任務 | 這次要做 | 你已完成 / 不在本次 |
|---|---|---|
| **#11** | 翻譯流程串接:取訊息 markdown → 呼叫 `«TranslationService»` → 得譯文 markdown → 用既有 pipeline 重渲染 bubble;保留原文;可重複翻譯;切語言不影響已翻譯訊息 | — |
| **#12** | **Loading** 狀態(送出後顯示 loading icon)、**Failed** 狀態(Toast) | ✅ **Success 狀態的 translated icon + 選單(`MessageTranslateMenu`)你已完成** |
| **#13** | **「See original message」→ 切回原文** 的實際行為(狀態回退、translated icon 消失) | ✅ 選單 UI(`MessageTranslateMenu` 內的兩個選項)你已完成 |

**一句話:** 三個任務其實共用同一顆「**每則訊息的翻譯狀態機**」。你已有**呈現層**(選單/icon);缺的是**驅動它的狀態與控制流**,以及 loading / failed 兩個狀態的接線。

**明確不在本次(遇到請跳過並回報):** 翻譯服務 真實串接、跨平台同步、真正的持久化、Auto-translate、Search/Pin/Threads/Copy/Edit 等跨功能連動(那是 #14–#17)。

---

## 2. Target Contract — 狀態機與控制流(這份是權威,照抄語意)

> 這一節是**不依賴你 code 也能定死**的核心。qwen 必須嚴格照此語意實作;命名可依專案慣例調整,但**狀態轉移與行為不可改**。

### 2.1 每則訊息的翻譯狀態

```ts
type TranslateStatus = 'idle' | 'loading' | 'translated' | 'failed';

interface MessageTranslation {
  status: TranslateStatus;
  targetLang?: string;          // 本次翻譯用的語言(點擊當下的設定值)
  translatedMarkdown?: string;  // 成功後的譯文(markdown)
  // 原文 markdown 不存在這裡:一律從訊息本體即時取得,永遠是 source of truth
}
```

- 狀態**以 messageId 為 key**(每則訊息獨立)。
- `failed` 是**暫時態**:顯示 Toast 後即回到 `idle`(畫面維持原文),**不留持久 UI**。
- 開發期狀態放在 in-memory store / context 即可(**不做持久化** — 那是 #16)。

### 2.2 狀態轉移圖

```
        translate(lang)
 idle ───────────────►  loading
  ▲                       │  success              ┌────────────┐
  │                       ├─────────────────────► │ translated │
  │  revertToOriginal     │                       └─────┬──────┘
  ├───────────────────────┘                             │ translate(lang)  (重複翻譯 / 換語言)
  │                       │  error/timeout/RPM          │  → 回 loading
  │                       ▼                             │
  └──────────────────  failed ──(顯示 Toast)──► idle    │
  ▲                                                      │
  └──────────────────────────────────────────────────────  revertToOriginal (See original message)
```

### 2.3 三個動作(pseudocode — 照語意實作)

```
function translate(messageId, targetLang):
    abortInFlight(messageId)                       # 若有前一個請求,先 abort(見 §2.5)
    setState(messageId, { status: 'loading', targetLang })
    original = «getMessageMarkdown»(messageId)      # ← Phase 0 要找出這個
    try:
        translated = await «translationService».translate(
            { text: original, targetLang }, signal(messageId))
        # 空內容(emoji/亂碼)→ Mock 會回原文,這仍算成功
        setState(messageId, { status: 'translated', targetLang, translatedMarkdown: translated })
    catch AbortError:
        return                                      # 被新動作取代,什麼都不做
    catch (err):
        «showToast»('Failed to translate. Please try again later.')   # PRD 文案,逐字
        setState(messageId, { status: 'idle' })

function revertToOriginal(messageId):
    abortInFlight(messageId)
    setState(messageId, { status: 'idle', translatedMarkdown: undefined })
    # translated icon 隨 status !== 'translated' 自動消失

# 重複翻譯 / 換語言:再次呼叫 translate(messageId, newLang) 即可,不需特例
# 關鍵不變式:切換「全域目標語言設定」不會自動 re-translate 既有已翻譯訊息(PRD §3.2)
#   → 只有使用者對「該則訊息」再次點翻譯,才會用新語言翻。translate() 讀的是「點擊當下」的設定。
```

### 2.4 Bubble 渲染規則(#11 核心)

```
render(message):
    md = (translation.status === 'translated')
           ? translation.translatedMarkdown
           : message.originalMarkdown
    return «renderMarkdownBubble»(md)     # ← 重用既有 markdown→Lexical→Composer,不要新寫
```

- **必須重用**既有渲染函式/元件。每則訊息本來就有自己的 Lexical Composer,只是把「餵進去的 markdown」依狀態換掉。
- `loading` / `failed` / `idle` 時都渲染**原文**;只有 `translated` 渲染譯文。

### 2.5 Abort 規則

- 每則訊息保留一個 in-flight 的 `AbortController`(或用 `«TranslationService».abort()`)。
- 觸發 abort 的情境:對同一則發新的 translate、revertToOriginal、元件卸載。
- Abort 後**不得**再寫入該請求的結果(靠 `catch AbortError: return`)。

---

## 3. Phase 0 — Recon 偵察表(qwen 只讀不寫,填完 STOP)

> 指示 qwen:**只用搜尋/讀檔**填下表,附上 `file:line` 佐證。**任何一格找不到 → 標 `NOT FOUND` 並停止**,回報給人類。填完先別寫任何 code。

| # | Placeholder | 意義 | 建議搜尋線索 | 你(agent)填:符號 / 路徑 (`file:line`) |
|---|---|---|---|---|
| P1 | `«MessageBubble»` | 渲染單則訊息的元件 | 找 `MessageTranslateMenu` 的使用處 / message list item | |
| P2 | `«renderMarkdownBubble»` | 既有 markdown→Lexical→Composer 渲染路徑 | `LexicalComposer`, `initialConfig`, `$convertFromMarkdownString`, `TRANSFORMERS` | |
| P3 | `«getMessageMarkdown»(id)` | 取得某則訊息的**原文 markdown** | message model / selector / store | |
| P4 | `«TranslationService»` | Task #18 介面 + #19 Mock(translate/abort/狀態) | 找 #18/#19 產出的 hook 或 service | |
| P5 | `«MessageTranslateMenu»` | **已完成**:translated icon + 選單 | 你已知 | (已存在) |
| P6 | `«LoadingIcon»` | design system 的 spinner/loading | 既有元件庫 | |
| P7 | `«showToast»(msg)` | Toast API | 既有 notification/toast util | |
| P8 | `«openTranslationSettingModal»` | 開 Translation Setting Modal(#7);沒有就用暫時 stub | Task #7 產出;若無 → stub | |
| P9 | `«isSelfMessage» / «messageType»` | 判定他人訊息 / 系統訊息 等(#6 已做) | message model | (若 #6 已封裝,填其函式) |
| P10 | `«editIconAnchor»` | timestamp 旁 edit icon 的位置(translated icon 要放它右邊) | bubble timestamp 區塊 | |
| P11 | 狀態存放處 | 決定 translation state 放哪(既有 store? context? 新建?) | 既有 zustand/redux/context 慣例 | |
| P12 | 驗證指令 | typecheck / lint / test / dev 啟動指令 | `package.json` scripts | typecheck:__ test:__ dev:__ |

**Recon 產出 = 上表填實 + 一段「我打算改動哪些檔案」清單。STOP。**
> (可選,強烈建議)把這張填好的表貼回 Claude,它會用真實符號名把 §4 步驟再收斂、把 pseudocode 換成貼近你 code 的骨架,降低 qwen 臆造風險。

---

## 4. Phase 2 — 逐步實作(每步都小、可驗證)

> 一次只做一個 Step。每步做完**立刻跑該步驟的 Verify**,綠燈才進下一步。改檔前先重讀該檔。

### Step 1 — 建立 translation state store(對應 §2.1)
- 在 P11 決定的地方新增以 messageId 為 key 的 `MessageTranslation` 狀態與 `setState`。
- 匯出讀取單則狀態的 selector/hook(供 bubble、menu、[...] 共用,達成解耦)。
- **Verify:** typecheck 綠;寫一個最小 unit test:對某 id set/get 狀態正確。

### Step 2 — 實作三個動作(對應 §2.3 + §2.5)
- `translate / revertToOriginal / abortInFlight`,嚴格照 §2.3 pseudocode;翻譯呼叫走 P4 `«TranslationService»`。
- Toast 文案**逐字**:`Failed to translate. Please try again later.`
- **Verify(用 Mock 寫測試,當紅綠 oracle):**
  - translate 成功:idle→loading→translated,`translatedMarkdown` 有值。
  - translate 失敗:idle→loading→failed→idle,且 `«showToast»` 被呼叫一次(mock 之)。
  - revertToOriginal:translated→idle,`translatedMarkdown` 清空。
  - 重複 translate:translated→loading→translated。
  - abort:loading 中被新 translate 取代,舊結果不得寫入。

### Step 3 — Bubble 依狀態切 markdown(#11,對應 §2.4)
- 在 P1 `«MessageBubble»` 讀取該則 translation 狀態;`translated` 時餵譯文、否則餵原文,交給 P2 `«renderMarkdownBubble»`。
- **不要**改 P2 的內部;只換輸入的 markdown 來源。
- **Verify:** 手動:對一則訊息呼叫 translate(mock 回罐頭譯文)→ bubble 內容換成譯文;revert → 換回原文。截圖或錄影。

### Step 4 — Loading 狀態(#12)
- 送出翻譯後(status==='loading')在 timestamp 區顯示 P6 `«LoadingIcon»`,直到 translated/idle。
- **Verify:** 把 Mock 延遲調到 ~1.5s,肉眼看到 loading icon 出現→消失。

### Step 5 — Failed 狀態(#12)
- status 轉 `failed` 時彈 P7 Toast(§2.3 已接);確認畫面停在原文、無殘留 icon。
- **Verify:** 讓 Mock 以 `failed`(timeout / RPM / api-error 皆可)回傳 → 出現 Toast、bubble 仍原文。

### Step 6 — 接線 `MessageTranslateMenu`(#13 的原文切換)
- 你已完成的選單裡:
  - **See original message** → `revertToOriginal(messageId)`(切回原文、icon 消失)。
  - **Translation settings** → P8 `«openTranslationSettingModal»`(沒有就先 `console.log`/no-op stub 並標 TODO)。
- translated icon 的顯示條件綁 `status === 'translated'`。
- tooltip:hover 延遲 **500ms** 顯示 `Translation options`,移開消失(若 design system 有 tooltip 元件,設 delay=500)。
- **Verify:** 手動:translated 狀態下點 icon→選單→See original→回原文且 icon 消失;hover 500ms 出 tooltip。

### Step 7 —(整合點,若 #10 已存在則接,否則標 TODO)`[...]` 選單切換
- 當 `status === 'translated'`,訊息 `[...]` 選單的 **Translate into {{lang}}** 顯示為 **See original message**(PRD §4.2.2.2),點擊同樣呼叫 `revertToOriginal`。
- 若 #10 尚未做 → 只留 TODO 註記與整合點說明,不硬做。
- **Verify:** typecheck 綠;若 #10 在,手動驗證切換。

---

## 5. Phase 3 — Acceptance Checklist(對照 PRD §4.2.2,逐條打勾)

- [ ] 點「Translate into {{lang}}」→ 出現 loading icon → 換成譯文 bubble(內容為 Mock 譯文)。
- [ ] Success:translated icon 出現在 timestamp 旁(**若有 edit icon,在其右邊**)。
- [ ] hover translated icon 延遲 **500ms** 出現 tooltip `Translation options`,移開消失。
- [ ] 點 translated icon → 選單:**See original message** / **Translation settings**;再點 icon 或點空白處關閉。
- [ ] **See original message** → 回原文、translated icon 消失。
- [ ] Failed(Mock 模擬 timeout / RPM / api-error)→ Toast `Failed to translate. Please try again later.`,bubble 維持原文。
- [ ] 空內容(emoji/亂碼,Mock 回原文)→ 視為**成功**(不報錯)。
- [ ] 重複翻譯可行;對已翻譯訊息再翻(換語言)→ 重新 loading→translated。
- [ ] 「切換全域目標語言設定」**不會**自動 re-translate 已翻譯的其他訊息。
- [ ] loading 中切走 / revert → 舊請求被 abort,不會有 stale 譯文蓋回來。
- [ ] typecheck / lint / 既有測試全綠。

---

## 6. Guardrails — 不准做的事

- ❌ 不碰後端 / 翻譯服務 / SSE / 認證 / 持久化 / 跨平台同步(那是資料整合軌 #2–#5、#16)。
- ❌ 不新寫 Lexical 序列化(extract/rehydrate/transId/anchor);只重用既有渲染。
- ❌ 不改 `«TranslationService»` 介面形狀(那是 #18 契約,兩軌共用)。
- ❌ 不做大範圍重構;只加「狀態機 + 接線」所需的最小改動。
- ❌ 找不到符號不准臆造:標 `NOT FOUND` 並停。
- ✅ 每個 Step 後跑 Verify;不綠不前進。

---

## 7. 建議放進專案的 `AGENTS.md`(opencode 會自動讀,穩定 qwen 行為)

```md
# AGENTS.md — Manual Translate 任務規則(給 opencode/qwen)
- 範圍限於 tasks #11/#12/#13 的「訊息翻譯狀態機 + 接線」。禁止改動後端、翻譯服務、持久化。
- 翻譯只透過 TranslationService 介面呼叫;禁止直接呼叫 API。
- 渲染譯文時重用既有 markdown→Lexical 渲染,禁止新寫 Lexical 序列化。
- 找不到本文件提到的符號/檔案時:停止並回報,禁止發明不存在的 API/檔名。
- 每完成一個 Step 就執行:`<typecheck>` 與 `<test>`;未通過不得進入下一步。
- 一次只改一個 Step 的範圍;改檔前先完整重讀該檔;不做無關重構。
- Toast/選單文案需與 PRD 逐字一致(英文)。
```

---

## 8. 可直接貼進 opencode 的任務提示(逐 Phase 貼,不要一次全貼)

**Phase 0(先貼這個):**
```
Read docs/handoff-translate-11-12-13.md. Do ONLY Phase 0 (Recon).
Fill the recon table (§3) by SEARCHING and READING the codebase.
For every row give the real symbol/path with file:line evidence.
If any row can't be found, mark it NOT FOUND and STOP.
Do NOT write or modify any code yet. Output the filled table plus the list of files you plan to change. Then STOP.
```

**Phase 1(Recon 通過後):**
```
Restate, in your own words, the state machine and control flow from §2 of the handoff
(states, the 3 actions, the render rule, the abort rule). List anything ambiguous. Then STOP for my confirmation. Do not write code yet.
```

**Phase 2(每個 Step 各貼一次,做完驗收再貼下一個):**
```
Implement Step <N> from §4 of the handoff, and ONLY Step <N>.
Follow the pseudocode/contract in §2 exactly. Obey AGENTS.md.
After the change, run the Step's Verify (typecheck/test/manual) and report results.
If Verify fails, fix within Step <N> scope; if blocked, STOP and report. Do not start Step <N+1>.
```

**Phase 3:**
```
Run the full Acceptance Checklist in §5 against the running app with the Mock TranslationService.
Report each item as pass/fail with evidence (screenshot/log). List any failures with proposed fixes.
```

---

## 9. 為什麼這樣設計能讓 opencode + qwen 可靠執行(方法論摘要)

1. **Recon → STOP gate**:把「我看不到 code」與「qwen 會臆造」兩個風險,收斂到一張**先填、先停、先給你看**的偵察表;錯誤在寫 code 前就被攔下。
2. **契約與 pseudocode 前置**:最難、最不能錯的「狀態機」由本文件定死,qwen 只做**照抄語意 + 接線**,不做架構決策(弱模型最容易出錯的地方)。
3. **原子化步驟 + 每步 Verify**:小步紅綠燈,錯誤不擴散;qwen 在有 test oracle 時表現明顯較穩,故 Step 2 特別要求先寫狀態機測試。
4. **AGENTS.md 常駐護欄**:把「不准碰後端 / 不准臆造 / 每步驗證」變成 opencode 每回合都會讀到的規則,而非只在提示裡講一次。
5. **逐 Phase 貼提示**:避免一次性大任務讓弱模型「假裝做完」;每段都有明確 STOP。
6. **回貼 Claude 收斂(可選)**:Recon 產出貼回給我,我能用你的**真實符號名**把步驟與骨架再精修一輪——在不看原始碼的前提下,這是最有效的「隔空校準」。
```
