# Handoff Plan — Translation Store / Generation Token / 併發閘門(Task #20)

> 執行者:**opencode + qwen(本機、可存取原始碼)**
> 前置關係:強化 #11/#12/#13 的併發正確性;與 #16(持久化)交界。
> 本文件作者看不到你的原始碼。已知的真實符號直接寫出;仍需綁定你 code 的部分以 `«placeholder»` 標記,由 agent 在 **Phase 0 偵察**填實並 **STOP** 給人類確認。

---

## 0. 背景與這份 handoff 要解決的問題

**現況(使用者提供):**
```
useMessageLoader(roomId) → useMessage → zustand(儲存 messages)
翻譯狀態  ✗ 目前做在 Message Component 的 scope(component-local)
```

**component-local 翻譯狀態的四個地雷:**
1. 虛擬化列表捲動 → Message Component unmount → 翻譯狀態消失(違反 PRD §4.2.2「維持該狀態」)。
2. In-flight 請求在 unmount 後回來 → setState on unmounted / 結果遺失。
3. 跨 surface(Pin panel、Threads entry,PRD §3.3)讀不到別的 component 的 local state。
4. 無法做**全域併發控制**(限流 / dedupe / generation token 需要看得到所有訊息的翻譯狀態)。

**本任務目標:** 把翻譯狀態抽成**獨立 zustand store**(`useMessageTranslationStore`,by `messageId`,與 `useMessage` 平行),並在其中實作 **generation token**、**併發閘門**、**dedupe**、**per-message abort**、**edit/remove 失效**、**toast 聚合**;同時**保留每則 re-render 隔離**。

**使用方式:** 照 `Phase 0 Recon → Phase 1 對齊契約 → Phase 2 逐步實作(每步驗收) → Phase 3 驗收`。三條鐵律見 §7 AGENTS.md。

---

## 1. Scope

**IN:**
- 新建 `useMessageTranslationStore`(獨立於 `useMessage`)。
- generation token(`reqSeq`)、dedupe、併發閘門(`maxConcurrent` + queue)、per-message `AbortController`。
- `translate / revert / onMessageEdited / onMessageRemoved` 四個 action。
- 把 Message Component 從 component-local 遷到 `useMessageTranslation(messageId)` hook(顆粒化 selector)。
- toast 去重/聚合(不改 PRD 文案)。

**OUT(遇到跳過並回報):**
- 翻譯服務 真實串接(走 `«TranslationService»` 介面即可,#4)。
- 真正的持久化 / 跨平台同步(#16)——本 store 先做 in-memory;之後由 #16 決定要不要 persist `byId`(且**只** persist 可序列化的部分,見 §6 護欄)。
- Pin/Threads/Copy 等跨功能連動 UI(#15)——本 store 讓它們**可讀**即可,實際接線在 #15。

---

## 2. Target Contract — 權威契約(照語意實作,命名可依專案慣例)

### 2.1 State 形狀

```ts
type TranslateStatus = 'idle' | 'loading' | 'translated' | 'failed';

interface TranslationEntry {
  status: TranslateStatus;
  targetLang?: string;
  translatedMarkdown?: string;
  reqSeq: number;              // 每則「單調遞增」的世代號 = generation token
  srcVersion?: string | number;// 翻譯當下的 message 版本(updatedAt/editedAt/hash),用來偵測 edit 失效
}

// 元件會訂閱的「反應式」狀態:只放這個
interface TranslationStore {
  byId: Record<string /*messageId*/, TranslationEntry>;
  // actions
  translate(messageId: string, targetLang: string): void;
  revert(messageId: string): void;
  onMessageEdited(messageId: string, newVersion: string | number): void;
  onMessageRemoved(messageId: string): void;
}
```

**併發機器(非反應式,元件不需訂閱)——放在「模組層變數」或明確標為不可被 component select 的欄位**:
```ts
// module-scope refs in the same file (NOT in reactive state components subscribe to)
const controllers = new Map<string, AbortController>(); // per-message in-flight controller
const queue: Array<{ messageId: string; targetLang: string; seq: number }> = [];
let activeCount = 0;
const MAX_CONCURRENT = 4;      // client 端併發上限,依 翻譯服務 RPM 調
```
> 為什麼分開:元件用顆粒化 selector 只訂閱 `byId[messageId]`,`controllers/queue/activeCount` 一變不該觸發任何 re-render,也不可序列化(#16 persist 時會出事)。

### 2.2 核心不變式(qwen 必須全部遵守)

- **G1 世代守衛(最重要):** 任何「把結果/失敗寫回 `byId[id]`」的地方,**先比對** `byId[id].reqSeq === job.seq`,不相等就**丟棄**。→ 根治亂序、stale write、翻譯貼錯訊息。**絕不靠回應到達順序**(對齊 issue #1「transId 是 linchpin」的精神)。
- **G2 Dedupe:** 相同 `messageId` 且 `targetLang` 已在 `loading` → `translate()` 直接 return,不重發。
- **G3 併發閘門:** 同時最多 `MAX_CONCURRENT` 個 in-flight,其餘進 `queue`;有 slot 就 `pump()`。
- **G4 Per-message abort:** retranslate / revert / edit / remove 都要 abort 該則 in-flight controller,並 bump `reqSeq`(雙保險:就算 abort 沒趕上,G1 也會丟棄回應)。
- **G5 Failed 是暫時態:** 失敗 → 回 `idle`(畫面維持原文)→ 交給 toast 聚合器,不留持久 UI。
- **G6 Re-render 隔離:** 元件一律用 `s => s.byId[messageId]` 這類**顆粒化 selector**,禁止 select 整包 `byId`。

### 2.3 Actions(pseudocode — 照抄語意)

```
translate(messageId, targetLang):
    cur = byId[messageId]
    if cur?.status === 'loading' && cur.targetLang === targetLang:   # G2 dedupe
        return
    seq = (cur?.reqSeq ?? 0) + 1
    abortInFlight(messageId)                                          # G4:取代前一次
    setEntry(messageId, {
        status: 'loading', targetLang, reqSeq: seq,
        srcVersion: «getMessageVersion»(messageId),
        translatedMarkdown: cur?.translatedMarkdown,                  # 重翻時暫留舊譯文(可選)
    })
    queue.push({ messageId, targetLang, seq })                        # G3
    pump()

pump():                                                               # G3
    while activeCount < MAX_CONCURRENT && queue.length > 0:
        job = queue.shift()
        if byId[job.messageId]?.reqSeq !== job.seq:                   # 已被後續請求取代 → 跳過
            continue
        run(job)

run(job):
    activeCount++
    ctrl = new AbortController(); controllers.set(job.messageId, ctrl)
    try:
        md = «getMessageMarkdown»(job.messageId)
        out = await «translationService».translate(
                 { text: md, targetLang: job.targetLang }, ctrl.signal)
        if byId[job.messageId]?.reqSeq !== job.seq: return            # G1 世代守衛
        setEntry(job.messageId, {
            status:'translated', targetLang: job.targetLang,
            translatedMarkdown: out, reqSeq: job.seq,
        })
    catch e:
        if isAbortError(e): return                                    # G4
        if byId[job.messageId]?.reqSeq !== job.seq: return            # G1
        setEntry(job.messageId, { status:'idle' })                   # G5
        reportFailure(job.messageId)                                  # → toast 聚合器(§2.4)
    finally:
        if controllers.get(job.messageId) === ctrl:
            controllers.delete(job.messageId)
        activeCount--
        pump()

revert(messageId):                                                    # See original message
    abortInFlight(messageId)
    seq = (byId[messageId]?.reqSeq ?? 0) + 1                          # bump → 任何 in-flight 回應變 stale 被丟棄
    setEntry(messageId, { status:'idle', reqSeq: seq, translatedMarkdown: undefined })

onMessageEdited(messageId, newVersion):                               # PRD §3.3:對方 edit → Manual 回原文
    e = byId[messageId]
    if !e || e.status === 'idle': return
    abortInFlight(messageId)
    seq = (e.reqSeq ?? 0) + 1
    setEntry(messageId, { status:'idle', reqSeq: seq, translatedMarkdown: undefined, srcVersion: newVersion })

onMessageRemoved(messageId):
    abortInFlight(messageId)
    removeQueuedJobsFor(messageId)
    deleteEntry(messageId)

abortInFlight(messageId):
    ctrl = controllers.get(messageId)
    if ctrl: ctrl.abort(); controllers.delete(messageId)
```

`setEntry` 用不可變更新(zustand):
```
setEntry(id, patch):
    set(s => ({ byId: { ...s.byId, [id]: { ...s.byId[id], ...patch } } }))
```

### 2.4 Toast 聚合(解決 toast storm)

- **預設(不改 PRD 文案):** 同一時間若標準失敗 toast 已顯示,則**抑制**重複 toast(不疊加)。文案沿用 PRD 逐字:`Failed to translate. Please try again later.`
- **可選(需產品確認文案):** 收集 ~800ms 視窗內的失敗數 N,顯示單一聚合 toast(如 `Failed to translate N messages. Please try again later.`)。**未經產品確認前不要自創文案**;預設走「抑制重複」。
- `reportFailure(messageId)` 丟給一個小聚合器:window 內去重 / 計數,對外只呼叫一次 `«showToast»`。

### 2.5 元件遷移(從 component-local → store)

提供一個 hook,讓 Message Component 幾乎不用改邏輯:
```ts
function useMessageTranslation(messageId: string) {
  const entry = useMessageTranslationStore(s => s.byId[messageId]);          // G6 顆粒化
  const translate = useMessageTranslationStore(s => s.translate);
  const revert = useMessageTranslationStore(s => s.revert);
  return {
    status: entry?.status ?? 'idle',
    translatedMarkdown: entry?.translatedMarkdown,
    translate: (lang: string) => translate(messageId, lang),
    revert: () => revert(messageId),
  };
}
```
- 移除 Message Component 內的 `useState` 翻譯狀態,改用上面 hook。
- Bubble 渲染規則不變(#11):`status==='translated' ? translatedMarkdown : originalMarkdown` 餵給既有 `«renderMarkdownBubble»`。

---

## 3. Phase 0 — Recon 偵察表(只讀不寫,填完 STOP)

> 每格附 `file:line` 佐證;找不到 → 標 `NOT FOUND` 並停,回報人類。**先別寫 code。**

| # | Placeholder / 問題 | 意義 | 搜尋線索 | 填:符號 / 路徑 (`file:line`) |
|---|---|---|---|---|
| P1 | `useMessage` / zustand store | 訊息 store 位置與建立方式 | `create(` from zustand、`useMessage` 定義 | |
| P2 | `«getMessageMarkdown»(id)` | 從 store 取單則**原文 markdown** | `useMessage` selector / message shape | |
| P3 | `«getMessageVersion»(id)` | 訊息版本欄位(edit 偵測用) | `updatedAt` / `editedAt` / `revision` / `version` | |
| P4 | 訊息 edit 如何進 store | 對方 edit 時 store 怎麼更新 | `useMessageLoader` 更新處 / socket handler | |
| P5 | `«TranslationService»` | #18 介面 + #19 Mock | 前一份 handoff 產出 | |
| P6 | 目前 component-local 翻譯狀態 | 要遷移/移除的 useState | Message Component 內 | |
| P7 | `«renderMarkdownBubble»` | 既有 markdown→Lexical 渲染 | `LexicalComposer` / `$convertFromMarkdownString` | |
| P8 | `«showToast»` | Toast API | 既有 notification util | |
| P9 | **列表是否虛擬化?** | 決定 unmount 嚴重度與 off-screen 完成策略 | react-window / virtuoso / 自製 | yes / no |
| P10 | **`useMessageLoader` 重載是 replace 或 merge?** | 決定翻譯 store 獨立的必要性 | loader set 邏輯 | replace / merge |
| P11 | zustand 版本 & 是否用 immer middleware | 決定 immutable 寫法 / 可否用 Map/Set | `package.json` / store 建立處 | |
| P12 | 驗證指令 | typecheck / test / dev | `package.json` scripts | typecheck:__ test:__ dev:__ |

**Recon 產出 = 上表填實 + 打算改動/新增的檔案清單。STOP。**
> (可選,建議)把填好的表貼回 Claude,用真實符號名把 §4 步驟與骨架再收斂一輪。

---

## 4. Phase 2 — 逐步實作(小步、每步驗收)

> 一次一個 Step;做完立刻跑該步 Verify,綠燈才前進。改檔前先重讀該檔。

### Step 1 — 建 store 骨架(§2.1)
- 新增 `useMessageTranslationStore`(獨立檔),含 `byId` 與四個 action 的空殼;模組層 `controllers/queue/activeCount/MAX_CONCURRENT`。
- 加 `setEntry` 不可變 helper。
- **Verify:** typecheck 綠;最小 test:`translate` set 出 `loading` 狀態、`byId[id]` 正確。

### Step 2 — generation token + dedupe(G1/G2)
- 實作 `translate`(含 dedupe、bump `reqSeq`)、`run` 的**世代守衛**(先不做閘門,`MAX_CONCURRENT = Infinity`)。
- **Verify(用 Mock 當 oracle):**
  - 成功:idle→loading→translated。
  - **亂序丟棄:** 對同一則連發兩次(seq1、seq2),讓 seq1 的 Mock **較慢**回 → 最終顯示 seq2 結果,seq1 被丟棄。
  - dedupe:loading 中對相同 lang 再點 → 不產生第二次 service 呼叫(spy Mock 呼叫次數)。

### Step 3 — 併發閘門 + per-message abort(G3/G4)
- 加 `queue` / `activeCount` / `pump`;`translate` 改成 enqueue→pump;`abortInFlight`;`run` 的 finally 遞減並 pump;pump 內跳過 stale queued job。
- **Verify:**
  - 閘門:同時丟 10 個,觀察同時 in-flight ≤ MAX_CONCURRENT(Mock 記錄併發峰值),其餘依序 drain。
  - abort:loading 中呼叫 `revert` → 舊回應到達時被丟棄(status 維持 idle)。

### Step 4 — edit / remove 失效(G4,PRD §3.3)
- 實作 `onMessageEdited`(translated/loading 的訊息版本變了 → abort + 回原文)、`onMessageRemoved`。
- 與 `useMessage` 接線:訂閱訊息版本變化(在 loader 或一個 store subscription)→ 呼叫 `onMessageEdited`。
- **Verify:** 翻譯完成後模擬該則 edit(version 變)→ 自動回原文;loading 中 edit → in-flight 被丟棄。

### Step 5 — toast 聚合(§2.4,G5)
- `reportFailure` → 聚合器:視窗內去重,對外一次 `«showToast»`;文案沿用 PRD。
- **Verify:** 讓 Mock 對 5 則同時回 failed → 只出現 1 個 toast;畫面各則維持原文、無殘留 icon。

### Step 6 — 元件遷移(§2.5,G6)
- 加 `useMessageTranslation(messageId)` hook;把 Message Component 的 component-local 翻譯 `useState` 移除,改用此 hook。
- **Verify:**
  - 功能不退化:單則 translate/revert 正常。
  - **re-render 隔離:** 翻某一則時,只有那一顆 bubble re-render(用 React DevTools/console.count 驗證,其他 bubble 不重繪)。

### Step 7 — Burst 壓力手測(整合)
- 把 Mock 延遲調到 ~1.5–3s,快速點 15+ 則。
- **Verify(對照 §5 驗收):** 併發受限、無 toast storm、無譯文貼錯訊息、(若虛擬化)捲走再捲回狀態還在。

---

## 5. Phase 3 — Acceptance Checklist

- [ ] 快速點 N 則:同時 in-flight ≤ `MAX_CONCURRENT`,其餘排隊後陸續完成。
- [ ] 慢/亂序回應**絕不**寫入已被後續請求取代的訊息(generation guard)。
- [ ] loading 中對「相同訊息 + 相同語言」再點 → 不產生第二次 service 呼叫(dedupe)。
- [ ] 換語言重翻 → 舊的被 abort/丟棄,新的勝出。
- [ ] loading 中 revert → in-flight 丟棄,顯示原文。
- [ ] 翻譯後該則被 edit → 回原文,in-flight(若有)丟棄(PRD §3.3)。
- [ ] 訊息 remove → 清 entry、清 queue、abort。
- [ ] (若虛擬化)訊息捲出畫面再捲回 → 翻譯狀態保留(因為在 store,不在 component)。
- [ ] 多則同時失敗 → 不疊 toast(單一/聚合);文案為 PRD 原文。
- [ ] 每則 re-render 隔離:翻一則不會觸發整個列表重繪。
- [ ] `controllers/queue/activeCount` 不在 component 訂閱路徑上、不被 persist。
- [ ] typecheck / test 全綠。

---

## 6. Guardrails

- ❌ 不把 `AbortController / queue / activeCount` 放進「元件會 select 的反應式狀態」或任何 persist 分區(不可序列化、且會造成 re-render 風暴)。
- ❌ 不把翻譯狀態併進 `useMessage` domain store(生命週期不同;message reload 會洗掉)。用**獨立 store**。
- ❌ 不靠回應到達順序判斷歸屬:**每個寫入點都要 generation guard**。
- ❌ 不自創 toast 文案(聚合版需產品確認);預設走「抑制重複 + PRD 原文」。
- ❌ 不碰後端 / 翻譯服務 / 持久化(#4 / #16);翻譯只走 `«TranslationService»` 介面。
- ❌ 找不到符號不臆造:標 `NOT FOUND` 並停。
- ✅ 元件一律顆粒化 selector;每步跑 Verify,不綠不前進。

### zustand 眉角(給 qwen)
- 不可變更新:`set(s => ({ byId: { ...s.byId, [id]: { ...s.byId[id], ...patch } } }))`。
- 若選多個欄位,考慮 `useShallow` 避免不必要 re-render。
- 有裝 immer middleware 才可直接 mutate;否則一律展開。
- `controllers`(Map)、`queue`(Array)、`activeCount` 建議放**模組層變數**,不放 store state。

---

## 7. 建議放進 `AGENTS.md`

```md
# AGENTS.md — Task #20 翻譯併發控制規則(給 opencode/qwen)
- 範圍:新建 useMessageTranslationStore + generation token + 併發閘門 + 元件遷移。禁止改後端/翻譯服務/持久化。
- 每個「寫回 byId」的地方都要先比對 reqSeq(generation guard);絕不靠回應順序。
- controllers/queue/activeCount 放模組層變數,不放元件會訂閱的 state,不 persist。
- 翻譯狀態用獨立 store,禁止併入 useMessage。翻譯只透過 TranslationService 介面。
- 元件一律用顆粒化 selector(s => s.byId[messageId]),禁止 select 整包 byId。
- toast 文案用 PRD 原文;聚合版文案需人類確認才可用。
- 每完成一個 Step 執行 <typecheck> 與 <test>;未過不得進下一步。找不到符號→停並回報,不得發明。
```

---

## 8. 可直接貼進 opencode 的提示(逐 Phase 貼)

**Phase 0:**
```
Read docs/handoff-translation-store-concurrency.md. Do ONLY Phase 0 (Recon).
Fill the recon table (§3) by SEARCHING/READING the codebase, with file:line evidence.
Answer P9 (virtualized?) and P10 (replace/merge?) explicitly. If any row is missing, mark NOT FOUND and STOP.
Do NOT write code. Output the table + files you plan to add/change. Then STOP.
```

**Phase 1:**
```
Restate in your own words: the state shape, the 6 invariants (G1–G6), and the 4 actions from §2.
List anything ambiguous or anything the recon revealed that conflicts with the contract. STOP for confirmation. No code yet.
```

**Phase 2(每步一次):**
```
Implement Step <N> from §4, and ONLY Step <N>. Follow §2 pseudocode and invariants exactly. Obey AGENTS.md.
Then run the Step's Verify (write the unit test where specified) and report results.
If Verify fails, fix within Step <N>; if blocked, STOP and report. Do not start Step <N+1>.
```

**Phase 3:**
```
Run the Acceptance Checklist in §5 (including the burst stress test with a slow Mock). Report each item pass/fail with evidence. List failures with proposed fixes.
```

---

## 9. 為什麼這樣設計能讓 opencode + qwen 可靠執行

1. **世代守衛是單一、可測的規則**:把「亂序 / stale / 貼錯訊息」這類最難 debug 的併發錯誤,收斂成一句「寫入前比對 `reqSeq`」——弱模型只要照抄這個檢查,就避開整類靜默錯誤。
2. **契約 + pseudocode 前置**:狀態機與併發機器由本文件定死,qwen 只做照抄與接線,不做架構決策。
3. **原子步驟 + 每步測試 oracle**:Step 2/3/4 都指定了具體的紅綠測試(亂序丟棄、dedupe 呼叫次數、閘門併發峰值、edit 失效),qwen 有 oracle 時最穩。
4. **模組層 vs 反應式狀態的明確切分**:直接告訴 qwen 什麼放 store、什麼放模組變數,避免它把 AbortController 塞進 persist 或 select 而炸掉。
5. **AGENTS.md 常駐 + 逐 Phase 貼**:護欄每回合都在,大任務被切成有 STOP 的小段,避免「假裝做完」。
6. **回貼 Claude 收斂(可選)**:Recon(尤其 P9/P10/P11)貼回來,我能用你真實的 store 寫法把骨架精修,降到最貼近你 code。
