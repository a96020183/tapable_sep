# 程式導覽：東西都在哪、為什麼長這樣

給想讀原始碼的人的地圖。本專案刻意採用**兩支自足的單檔 HTML**，這是決策不是偷懶，
先講理由，再給地圖。

## 為什麼是單檔，不是模組化＋建置

| 考量 | 單檔給我們的 |
|---|---|
| 離線 | Service Worker 預快取一份清單就是完整產品，沒有 chunk 圖要維護 |
| 可重現 | `git clone` ＋任何靜態伺服器就能跑，評審與貢獻者不需 node_modules、不需 build |
| 可稽核 | 「頁面到底會發出什麼請求」一支檔案內全部可見；本專案的隱私承諾（影像不上傳、身分語音不出手機）靠這個被檢驗 |
| 部署面 | GitHub Pages 直接服務原始碼，線上內容與 repo HEAD 逐位元一致，不存在「build 產物與原始碼不符」的問題 |

代價是單檔變大（操作段約 82KB）、瀏覽門檻高。緩解方式就是本文件＋檔內的區塊註解＋
`window.__OP`／`window.__V` 測試掛鉤（它們同時是理解程式行為的觀測口）。

## 操作段 `index.html`（約 82KB）

由上而下的區塊順序，搜尋這些字串就能跳到對應段落：

| 搜尋關鍵 | 內容 |
|---|---|
| `globalThis.TT=` | 機台知識庫：12 畫面、11 項服務與價目、學年期、實體動作提示（投幣、取件）。**這包資料就是「NFC 碰一下之後手機知道的事」** |
| `class Session` | 16 步驟狀態機。所有狀態轉移的守衛都在這裡（例如份數超過上限直接拒絕），UI 與語音都只是它的投影 |
| `class Speech` | 裝置端 TTS 封裝：斷句、iOS cancel workaround、token 失效機制（換頁後舊語音一定閉嘴） |
| `class SwipeNavigator` | demo 模式的左右滑動（視障者手機慣用手勢的示意） |
| `震動＋音效雙重回饋` | `feedback()`／`tone()`，每次回饋記入 `feedbackLog` 供測試斷言 |
| `const VOICE_STATES=` | 哪四個步驟開放語音輸入（身分輸入與驗證中永遠不在內——這就是「身分語音不出手機」的實作點） |
| `const pages=` | 每個狀態的畫面模板；`heading()`＋`#action-bar` 的結構是鍵盤與讀屏順序的依據 |
| `function handleEvent` | 事件入口（含 demo 模擬事件 SIM_PAID／PRINT_READY）；換頁後的焦點管理與 350ms 防連點冷卻也在 render 這一帶 |
| `語音意圖解析第一層` | `parseIntent2()`：規則式解析，同義詞計分＋模糊比對＋簡繁轉換，純函式、可整段抽出來單測（`tests/intent/` 就是這樣測它的） |
| `預設 LLM 意圖層` | `parseIntentProxy()`：呼叫自架代理（`server/vercel`），2.5 秒逾時、可中止、頁面載入先暖機；`sanitizeIntent()` 是所有解析結果（不管哪一層來的）落地前的最後守門 |
| `選用：改用自己的 LLM 端點` | 使用者自備 key 的直連路徑，設定只存 localStorage |
| `window.__OP=` | 測試掛鉤：狀態、解析器、模擬事件派發、語音與回饋記錄 |

資料流一句話：**辨識文字 → 意圖（LLM 優先，規則式備援）→ `sanitizeIntent` 白名單 →
覆誦 → 使用者確認 → `handleEvent` → `Session` 守衛 → render**。
語音永遠不直接觸發狀態轉移。

## 鏡頭段 `vision/index.html`（約 26KB）

| 搜尋關鍵 | 內容 |
|---|---|
| `./lib/` | tf.js、coco-ssd（SSDLite-MobileNetV2）、jsQR 全部隨頁自帶，執行期零外部請求 |
| `P0_SCORE` | 播報門檻：高信心＋連續幀才開口；畫框用較低閾值（看得到≠吵你） |
| `GROW=` | 逼近判定：偵測框面積成長 18% 以上才算「朝你來」，同向移動與靜止物不觸發 |
| `kiosk-refs.json` | 機台外觀比對：MobileNet 嵌入 kNN（參考照不入庫，產生流程見 `tools/build-kiosk-refs.js`）；最終確認以視覺標記為準 |
| `handoff` | 抵達後交棒操作段：先 `stop()` 關相機再導頁（不耗電、不多拍） |
| `window.__V=` | 測試掛鉤：`__V.evaluate()` 注入合成偵測，回歸測試不需要相機 |

## 其他

- `server/vercel/`：意圖代理（Vercel Function）。CORS 白名單、伺服器端二次驗證、限流、
  不記逐字稿。部署與 API 規格見 [server/README.md](../server/README.md)
- `sw.js`：預快取清單＋network-first HTML。改任何檔案要 bump `CACHE` 版本
- `tests/`：op（Playwright 80 項）、r2 UX（29）、intent（85，直接測 index.html 內的出貨程式碼）、
  vision（31，合成偵測）、a11y（axe 18 畫面＋純鍵盤 6 項）。執行方式見 [tests/README.md](../tests/README.md)，
  最近一次完整結果見 [tests/RESULTS.md](../tests/RESULTS.md)
