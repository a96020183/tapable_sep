# server/ —— 語音意圖代理（Vercel）五分鐘部署 runbook

讓公開 demo（<https://a96020183.github.io/tapable_sep/>）的「語音 → 結構化意圖」預設就能走真 LLM，
而 **API key 只存在 Vercel 伺服器端**，瀏覽器與 repo 都不會出現 key。

```
瀏覽器（GitHub Pages）──POST {transcript,state,…}──▶ https://xxx.vercel.app/api/intent ──▶ OpenAI 相容 API
        ◀── {service,copies,action,semester} ◀──   （key 只在這裡）
```

目錄：

| 檔案 | 用途 |
|---|---|
| `vercel/api/intent.js` | Serverless Function 本體（CommonJS，Node 20+） |
| `vercel/package.json` | 標明 `"type":"commonjs"` 與 node 版本 |
| `vercel/vercel.json` | function 逾時／記憶體、no-store 標頭 |
| `vercel/test-local.js` | 離線單元測試（不需 key、不連網）：`node test-local.js` |
| `../index.html` | 前端常數 `LLM_PROXY` 就是代理網址；改網址時改這一行 |

---

## 0. 前置條件（一次性）

- Node.js 20 以上、已安裝 Vercel CLI：`npm i -g vercel`
- 一個 OpenAI（或相容供應商）API key。**不要**把 key 貼進任何檔案，只放 Vercel 環境變數。

## 1. 登入並部署

```bash
cd server/vercel
vercel login
vercel --prod
```

第一次會問幾個問題：Set up and deploy? **Y** → Scope 選自己 → Link to existing project? **N** → 專案名稱隨意（例如 `tapable-intent`）→ 目錄用預設 `./`。
完成後會印出網址，例如 `https://tapable-intent.vercel.app`。

> 此時 POST 會回 `500 {"error":"server_not_configured"}`，因為還沒設 key，這是預期行為。

## 2. 設定環境變數

到 Vercel 網頁後台 → 該專案 → **Settings → Environment Variables**，新增（勾 Production）：

| 名稱 | 必要 | 值 |
|---|---|---|
| `OPENAI_API_KEY` | 是 | 你的 key |
| `OPENAI_MODEL` | 否 | 預設 `gpt-4o-mini` |
| `OPENAI_BASE_URL` | 否 | 預設 `https://api.openai.com/v1`；換相容供應商時填其 base URL |
| `ALLOWED_ORIGINS` | 否 | 預設只允許 `https://a96020183.github.io`；要加本機測試就填 `https://a96020183.github.io,http://localhost:8080` |

或用 CLI（會互動式要你貼值，不會留在 shell 歷史）：

```bash
vercel env add OPENAI_API_KEY production
```

## 3. 重新部署讓環境變數生效

```bash
vercel --prod
```

## 4. 測試

健康檢查（不呼叫上游、不耗 token；`configured:true` 代表 key 已設）：

```bash
curl -s "https://tapable-intent.vercel.app/api/intent?health=1"
# {"ok":true,"model":"gpt-4o-mini","configured":true}
```

一筆 POST（**必須帶 Origin**，否則 403；這是刻意的，避免被當公用代理）：

```bash
curl -s -X POST "https://tapable-intent.vercel.app/api/intent" \
  -H "Content-Type: application/json" \
  -H "Origin: https://a96020183.github.io" \
  -d '{"transcript":"我要英文在學證明兩份","state":"SERVICE","services":[{"id":"enrollment","name":"在學證明"},{"id":"enrollment-en","name":"英文在學證明"}],"maxCopies":5,"semesters":[]}'
# {"service":"enrollment-en","copies":2,"action":null,"semester":null,"matched":true,"state":"SERVICE"}
```

其他步驟的範例 body：

```json
{"transcript":"三份","state":"COPIES","maxCopies":5}
{"transcript":"114 學年度第二學期","state":"SEMESTER","semesters":["114 學年度第 2 學期","114 學年度第 1 學期"]}
{"transcript":"好，確認","state":"REVIEW"}
```

Windows PowerShell 版本：

```powershell
Invoke-RestMethod "https://tapable-intent.vercel.app/api/intent?health=1"
Invoke-RestMethod -Method Post "https://tapable-intent.vercel.app/api/intent" -ContentType "application/json" -Headers @{Origin="https://a96020183.github.io"} -Body '{"transcript":"三份","state":"COPIES","maxCopies":5}'
```

## 5. 在 OpenAI 後台設花費上限（強烈建議）

OpenAI Platform → **Settings → Billing → Limits**，把每月 budget 設為 **5 美元**（gpt-4o-mini 每次呼叫約 300 token，5 美元夠跑數萬次）。
代理本身另有每 IP 每分鐘 20 次的限流，但那是單一 function 實例的記憶體計數，冷啟動會歸零，**不能**當作花費保險。

## 6. 把網址填回前端並 push

編輯 `index.html`，把常數 `LLM_PROXY` 換成你自己的部署網址：

```js
const LLM_PROXY='https://<你的專案>.vercel.app/api/intent';
```

留空字串即完全停用雲端解析，全部改走裝置端規則式。改完 `git commit` 並 push。
GitHub Pages 重新發布後，demo 會先嘗試代理；代理逾時／錯誤時自動退回瀏覽器端關鍵字比對，使用者不會卡住。

---

## API 規格

| 方法 | 路徑 | 說明 |
|---|---|---|
| `OPTIONS` | `/api/intent` | CORS 預檢；白名單 Origin 回 204，否則 403 |
| `GET` | `/api/intent?health=1` | `{ok:true, model, configured}`；不需 Origin |
| `POST` | `/api/intent` | body 見下；需白名單 Origin |
| 其他 | | 405 |

POST body：

```ts
{
  transcript: string;                 // 語音辨識文字，超過 200 字會截斷
  state: 'SERVICE'|'COPIES'|'SEMESTER'|'REVIEW';
  services?: {id:string,name:string}[]; // SERVICE 步驟必填
  maxCopies?: number;                 // 預設 5，上限 99
  semesters?: string[];               // SEMESTER 步驟必填
}
```

回應（200）：`{service, copies, action, semester, matched, state}`，不合法或未提及的欄位一律 `null`。
伺服器會做第二層白名單驗證：`service` 必在 `services` 內、`copies` 為 `1..maxCopies` 整數、`action` 只能 `CONFIRM`/`BACK`、`semester` 必在 `semesters` 內，且只保留目前 `state` 允許的欄位。

錯誤碼：

| HTTP | `error` | 原因 |
|---|---|---|
| 400 | `invalid_body` / `transcript_required` / `invalid_state` | 輸入格式錯 |
| 403 | `origin_not_allowed` | Origin 不在白名單或沒帶 Origin |
| 405 | `method_not_allowed` | 方法錯 |
| 429 | `rate_limited` | 同 IP 一分鐘超過 20 次（附 `Retry-After: 60`） |
| 500 | `server_not_configured` | 未設 `OPENAI_API_KEY` |
| 502 | `upstream_error` / `upstream_rate_limited` / `upstream_not_json` / `upstream_unreachable` | 上游失敗 |
| 504 | `upstream_timeout` | 上游超過 6 秒 |

上游呼叫參數：`temperature 0`、`max_tokens 80`、`response_format json_object`。
Log 只記錯誤類別與上游狀態碼，**不記 key、不記完整上游回應、不記 transcript**。

## 常見錯誤

**瀏覽器 console 出現 CORS 錯誤（`No 'Access-Control-Allow-Origin' header`）**
- 你從非 `https://a96020183.github.io` 的網址開 demo（例如本機 `http://localhost:8080` 或 fork 的 Pages）。到 Vercel 加 `ALLOWED_ORIGINS`，用逗號把所有網址列進去，然後重新部署。
- Origin 比對是**完全比對**（含 scheme 與 port、不含路徑）。`https://a96020183.github.io/tapable_sep/` 這種帶路徑的值不會生效，請填 `https://a96020183.github.io`。

**`502 upstream_error`，Vercel log 顯示 `status=401`**
- key 錯或已撤銷；或 `OPENAI_BASE_URL` 換了供應商但 key 沒換。到 Vercel 環境變數重設，並**重新部署**（改環境變數不會自動套用到既有部署）。

**`502 upstream_rate_limited`，Vercel log 顯示 `status=429`**
- OpenAI 帳號額度用完、達到每月 budget，或免費額度的 RPM 上限。到 OpenAI Billing 看用量。這與代理自己的 `429 rate_limited` 不同：後者是同一 IP 一分鐘超過 20 次。

**`500 server_not_configured`**
- 還沒設 `OPENAI_API_KEY`，或設了但沒重新部署。

**`504 upstream_timeout`**
- 上游 6 秒沒回。偶發可忽略（前端會退回關鍵字比對）；持續發生請換模型或供應商。`vercel.json` 的 `maxDuration` 為 10 秒，勿低於 7。

**curl 直接打 POST 回 403**
- 預期行為：POST 必須帶白名單 Origin 標頭（`-H "Origin: https://a96020183.github.io"`）。

## 本地開發

```bash
cd server/vercel
node --check api/intent.js     # 語法檢查
node test-local.js             # 離線測試，不需 key
vercel dev                     # 本機模擬（會讀 .env.local；請勿把 .env.local 加進 git）
```

## 安全備註

- Key 只在 Vercel 環境變數；`.vercelignore` 排除測試檔；repo 不含任何 key。
- 無 Origin 的請求一律拒絕，避免代理被外部程式直接濫用；但 Origin 標頭可被非瀏覽器客戶端偽造，所以**花費上限請在 OpenAI 後台設**。
- 限流是 demo 等級（單實例記憶體），不是配額系統。
