# 財務法規追蹤系統

自動追蹤財務／會計／稅務相關法規在「全國法規資料庫」的最後修正日期，用法與你原本的「人事法規追蹤系統」相同：GitHub Actions 每天抓一次資料 → 寫回 repo → Cloudflare Pages 重新部署。

## 檔案結構
```
finance-law-tracker/
├─ finance-laws.html          # 主頁面，讀取 data/laws-data.json 顯示
├─ expense-review.html        # 你原本的支出報核憑證審核要點頁面（已加上導覽列連結）
├─ data/
│  ├─ laws-list.json          # 63 筆要追蹤的法規清單（可自行增刪）
│  └─ laws-data.json          # 由 Action 自動產生／更新，含最後修正日期
├─ scripts/
│  └─ update-laws.mjs         # 抓取全國法規資料庫開放資料、比對、寫檔
└─ .github/workflows/
   └─ update-laws.yml         # 每天排程執行 update-laws.mjs
```

## 一、建立 GitHub Repository
1. 到 GitHub 建立新的 repository，例如 `finance-law-tracker`（public 或 private 皆可，Cloudflare Pages 兩者都支援）。
2. 把這個資料夾的內容全部推上去：
   ```bash
   cd finance-law-tracker
   git init
   git add .
   git commit -m "init: finance law tracker"
   git branch -M main
   git remote add origin https://github.com/<你的帳號>/finance-law-tracker.git
   git push -u origin main
   ```

## 二、Cloudflare Pages 串接
1. Cloudflare Dashboard → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**。
2. 授權並選擇剛剛建立的 `finance-law-tracker` repository。
3. Build 設定：這是純靜態 HTML/JS，不需要 build step：
   - Build command：留空
   - Build output directory：`/`（repo 根目錄）
4. 送出後 Cloudflare 會自動建立一個 production 分支部署（對應 `main`），之後每次 push 到 `main` 都會自動重新部署，包含每天 Action 自動 commit 的 `data/laws-data.json` 更新。

## 三、GitHub Actions 需要的權限
`update-laws.yml` 裡設定了 `permissions: contents: write`，讓 Action 可以 `git push` 回 repo。如果你的 GitHub organization 有另外關閉 Actions 的預設寫入權限，需要到：
`Repo → Settings → Actions → General → Workflow permissions` 選擇「Read and write permissions」。

## 四、關於資料來源的重要提醒
`scripts/update-laws.mjs` 呼叫的是官方「全國法規資料庫 Open API」（`https://law.moj.gov.tw/api/Ch/Law/JSON`，可在 `https://law.moj.gov.tw/api/swagger/index.html` 查到）。這個網站會擋掉部分自動化流量，我這邊的開發環境無法直接連線驗證欄位名稱，所以程式裡：
- 用 `pickField()` 對常見的幾種欄位命名（`LawName`/`lawName`、`LawModifiedDate` 等）做容錯嘗試；
- 每次執行都會在 Action log 印出「第一筆原始資料」，方便你核對真正的欄位名稱；
- 如果欄位名稱對不上，只要照 log 印出的內容調整 `pickField()` 裡的候選字串即可，不需要改其他邏輯。

**建議第一次先用 `workflow_dispatch`（GitHub 網頁上手動按「Run workflow」）跑一次**，確認 `data/laws-data.json` 有正確產生日期後，再放著讓每日排程接手。

## 五、`data/laws-list.json` 中 `trackable: false` 的項目
清單中約 10 筆（例如「財政部函釋」「國稅局函釋」「金管會函令」「IFRS」「審計準則公報」等）並非全國法規資料庫收錄的單一命名法規，而是函釋/準則彙整或跨機關資料，程式不會嘗試自動比對，頁面上會顯示「無法自動追蹤」，並附上備註說明查證方向。如果你有想追蹤的更精確法規名稱（例如某個特定準則的正式公告名稱），可以直接在 `laws-list.json` 補上正確名稱、把 `trackable` 改成 `true`。

## 六、補充資料共用儲存（KV）設定
「📤 新增補充資料」分頁讓使用者直接新增資料、所有人立即可見，資料存在 Cloudflare KV，需要你先手動建立一次：

1. Cloudflare Dashboard → 左側選單 **儲存與資料庫（Storage & Databases）** → **KV** → **Create a namespace**
2. Namespace 名稱隨意取（例如 `finance-law-manual-entries`），建立後會得到一組 **Namespace ID**（一串英數字）
3. 打開 repo 裡的 `wrangler.jsonc`，找到這一段：
   ```jsonc
   "kv_namespaces": [
     { "binding": "MANUAL_ENTRIES", "id": "REPLACE_WITH_YOUR_KV_NAMESPACE_ID" }
   ]
   ```
   把 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` 換成剛剛複製的 Namespace ID，commit 上傳
4. Cloudflare 會自動重新部署，部署成功後「新增補充資料」分頁就能直接寫入、所有人共用

**注意**：這個功能對應的 API（`/api/manual-entries`）目前**沒有登入驗證**，任何拿到網站網址的人都可以新增或刪除資料。如果之後需要加上密碼保護，需要另外設計驗證機制（可以再回來找我）。
