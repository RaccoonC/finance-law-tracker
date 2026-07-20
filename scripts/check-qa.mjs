// scripts/check-qa.mjs
//
// 每天由 GitHub Actions 執行一次：
// 1. 抓取「經費結報常見疑義問答集」這個固定網頁的內容
// 2. 把整頁文字內容做 SHA-256 雜湊比對，跟上次執行的雜湊值不一樣才算「有更新」
//    （因為完全無法預先確認頁面的 HTML 結構，用「內容整體有沒有變」取代
//    「比對特定日期欄位」，比較不會因為猜錯選擇器而漏抓或抓錯）
// 3. 有更新才重新存全文，沒有變動就沿用舊資料，避免每天無謂重抓
// 4. 輸出 data/qa-data.json（法規清單用的摘要資訊）與 data/qa-fulltext.json
//    （全文，跟 laws-fulltext.json 走一樣的檔案格式），
//    finance-laws.html 前端會把這兩個檔案跟主要的法規資料合併顯示
//
// ⚠️ 重要限制：DGBAS 過去修訂這份問答集時，是另外開一個新網址發布新版本
// （例如這次的 .../1718，上一版是 .../1397），不是直接更新同一頁的內容。
// 如果這次也是「開新網址」而不是「更新這頁」，這支腳本會抓不到新版本，
// 需要人工把下面的 QA_URL 換成新網址。這個限制沒辦法用程式自動解決，
// 只能定期人工確認 DGBAS 官網「友善經費報支專區」有沒有發布新網址。
//
// ⚠️ 另一個重要提醒：這個網站的 robots.txt 明確禁止自動化存取，
// 這支腳本的抓取行為不在網站主動開放的範圍內，是基於低頻率（每天一次）、
// 內部合規用途、且只抓取政府已公開發布之文件的前提下執行，請留意。

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const QA_URL = "https://ebasnew.dgbas.gov.tw/PublicinsideAudit/Detail/0/1718";
const QA_NAME = "經費結報常見疑義問答集";
const QA_CATEGORY = "十四、問與答";

const DATA_DIR = new URL("../data/", import.meta.url);
const OUTPUT_DATA_PATH = new URL("qa-data.json", DATA_DIR);
const OUTPUT_FULLTEXT_PATH = new URL("qa-fulltext.json", DATA_DIR);

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function extractTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? stripHtmlToText(m[1]).trim() : null;
}

// 從文字內容裡盡量抓出一個「民國 X 年 X 月 X 日」格式的日期，
// 用來在畫面上顯示（純粹輔助參考用，抓不到就顯示「以內容更新時間為準」）。
function extractRocDateHint(text) {
  const m = text.match(/中華民國\s*(\d{2,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!m) return null;
  return `民國${m[1]}年${m[2].padStart(2, "0")}月${m[3].padStart(2, "0")}日`;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function loadPreviousData() {
  try {
    const raw = await readFile(OUTPUT_DATA_PATH, "utf8");
    const json = JSON.parse(raw);
    return (json.items || [])[0] || null;
  } catch {
    return null; // 第一次執行，還沒有舊資料
  }
}

async function loadPreviousFulltext() {
  try {
    const raw = await readFile(OUTPUT_FULLTEXT_PATH, "utf8");
    const json = JSON.parse(raw);
    return (json.laws || [])[0]?.content || null;
  } catch {
    return null;
  }
}

async function main() {
  const checkedAt = new Date().toISOString();
  const [prev, prevText] = await Promise.all([loadPreviousData(), loadPreviousFulltext()]);

  let item;
  let fulltextEntry;

  try {
    console.log(`下載：${QA_URL}`);
    const res = await fetch(QA_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; finance-law-tracker/1.0; internal compliance monitoring)",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const text = stripHtmlToText(html);
    const hash = sha256(text);
    const title = extractTitle(html);
    const dateHint = extractRocDateHint(text);

    console.log(`頁面標題：${title || "（抓不到 <title>）"}`);
    console.log(`內容雜湊值：${hash}`);
    console.log(`文字內容前 300 字：${text.slice(0, 300)}`);

    const changed = !prev || prev.content_hash !== hash;
    console.log(changed ? "偵測到內容變動（或首次執行），重新存檔" : "內容跟上次執行相同，沿用舊資料");

    item = {
      name: QA_NAME,
      category: QA_CATEGORY,
      last_amend_date: dateHint,
      publish_date: null,
      url: QA_URL,
      fetch_error: null,
      matchType: "ok",
      trackable: true,
      checked_at: checkedAt,
      content_hash: hash,
      content_updated_at: changed ? checkedAt : prev.content_updated_at,
      newly_detected: changed && !!prev, // 第一次執行不算「異動」，避免一開始就寄信
      newly_error: false,
    };
    fulltextEntry = { name: QA_NAME, content: changed ? text : prevText || text };
  } catch (err) {
    console.error("抓取失敗：", err.message);
    item = {
      name: QA_NAME,
      category: QA_CATEGORY,
      last_amend_date: prev?.last_amend_date || null,
      publish_date: null,
      url: QA_URL,
      fetch_error: `抓取失敗：${err.message}`,
      matchType: prev ? "fetch_error" : "not_found",
      trackable: true,
      checked_at: checkedAt,
      content_hash: prev?.content_hash || null,
      content_updated_at: prev?.content_updated_at || null,
      newly_detected: false,
      newly_error: !!(prev && prev.matchType === "ok"), // 原本抓得到、這次才突然失敗，才算需要提醒
    };
    fulltextEntry = { name: QA_NAME, content: prevText || "" };
  }

  const dataOutput = { generated_at: checkedAt, items: [item] };
  const fulltextOutput = { generated_at: checkedAt, laws: [fulltextEntry] };

  await mkdir(path.dirname(new URL(OUTPUT_DATA_PATH).pathname), { recursive: true }).catch(() => {});
  await writeFile(OUTPUT_DATA_PATH, JSON.stringify(dataOutput, null, 2), "utf8");
  await writeFile(OUTPUT_FULLTEXT_PATH, JSON.stringify(fulltextOutput, null, 2), "utf8");
  console.log(`已寫入 ${OUTPUT_DATA_PATH.pathname} 與 ${OUTPUT_FULLTEXT_PATH.pathname}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
