// scripts/check-dgbas.mjs
//
// 每天由 GitHub Actions 執行一次：
// 1. 讀取 data/dgbas-list.json（每一筆是「行政院主計總處主管法規共用系統」
//    上的固定網址，因為這個系統沒有像全國法規資料庫那樣的公開 API，
//    沒辦法用名稱去比對，只能一筆一筆用直接網址追蹤）
// 2. 抓取頁面，解析「制(訂)定日期」「修正日期」兩個欄位
// 3. 跟上次抓到的日期比對，有變動才重新擷取全文
// 4. 寫入 data/dgbas-data.json、data/dgbas-fulltext.json，
//    前端會把這兩個檔案併入主要法規清單
//
// ⚠️ 重要提醒：這個系統的頁面結構是根據「臺北市法規查詢系統」
// （跟這個系統共用同一套軟體、法規編號也共用）推測出來的，
// 不是直接驗證過 law.dgbas.gov.tw 本身的頁面，第一次執行後
// 務必看 log 裡印出的「解析結果」是否正確，不對的話需要調整。
//
// ⚠️ 另外 law.dgbas.gov.tw 跟先前連線逾時的 ebasnew.dgbas.gov.tw
// 同屬 dgbas.gov.tw 網域，有可能也會擋 GitHub Actions 的連線，
// 這點沒辦法事先確認。

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = new URL("../data/", import.meta.url);
const LIST_PATH = new URL("dgbas-list.json", DATA_DIR);
const OUTPUT_DATA_PATH = new URL("dgbas-data.json", DATA_DIR);
const OUTPUT_FULLTEXT_PATH = new URL("dgbas-fulltext.json", DATA_DIR);

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

// 抓「標籤文字 + 民國 X 年 X 月 X 日」，中間允許夾雜 HTML 標籤／換行，
// 因為看不到 law.dgbas.gov.tw 實際頁面結構，用寬鬆一點的比對方式。
function extractLabeledDate(html, label) {
  const re = new RegExp(label + "[\\s\\S]{0,80}?民國\\s*(\\d{1,3})\\s*年\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日");
  const m = html.match(re);
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
    const byName = new Map();
    for (const item of json.items || []) byName.set(item.name, item);
    return byName;
  } catch {
    return new Map();
  }
}

async function loadPreviousFulltext() {
  try {
    const raw = await readFile(OUTPUT_FULLTEXT_PATH, "utf8");
    const json = JSON.parse(raw);
    const byName = new Map();
    for (const item of json.laws || []) byName.set(item.name, item.content);
    return byName;
  } catch {
    return new Map();
  }
}

async function fetchOne(law, checkedAt) {
  console.log(`下載：${law.name}（${law.url}）`);
  try {
    const res = await fetch(law.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; finance-law-tracker/1.0; internal compliance monitoring)",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const title = extractTitle(html);
    const amendDate = extractLabeledDate(html, "修正日期");
    const publishDate = amendDate ? null : extractLabeledDate(html, "制\\s*[（(]?\\s*訂\\s*[）)]?\\s*定日期");
    const text = stripHtmlToText(html);

    console.log(`  頁面標題：${title || "（抓不到 <title>）"}`);
    console.log(`  解析到的修正日期：${amendDate || "（無）"}，公布日期：${publishDate || "（無）"}`);
    console.log(`  文字內容前 200 字：${text.slice(0, 200)}`);

    return { ok: true, title, amendDate, publishDate, text };
  } catch (err) {
    const causeDetail = err.cause ? `（底層原因：${err.cause.code || err.cause.message || err.cause}）` : "";
    console.error(`  抓取失敗：${err.message}${causeDetail}`);
    return { ok: false, error: `抓取失敗：${err.message}${causeDetail}` };
  }
}

async function main() {
  const checkedAt = new Date().toISOString();
  const listRaw = await readFile(LIST_PATH, "utf8");
  const laws = JSON.parse(listRaw);

  const [prevData, prevFulltext] = await Promise.all([loadPreviousData(), loadPreviousFulltext()]);

  const items = [];
  const fulltextEntries = [];

  for (const law of laws) {
    const result = await fetchOne(law, checkedAt);
    const prev = prevData.get(law.name);

    if (!result.ok) {
      items.push({
        name: law.name,
        category: law.category,
        url: law.url,
        last_amend_date: prev?.last_amend_date || null,
        publish_date: prev?.publish_date || null,
        checked_at: checkedAt,
        matchType: prev ? "fetch_error" : "not_found",
        trackable: true,
        fetch_error: result.error,
        content_updated_at: prev?.content_updated_at || null,
        newly_detected: false,
        newly_error: !!(prev && prev.matchType === "ok"),
      });
      fulltextEntries.push({ name: law.name, content: prevFulltext.get(law.name) || "" });
      continue;
    }

    const datesUnchanged =
      prev && prev.last_amend_date === result.amendDate && prev.publish_date === result.publishDate;
    const changed = !datesUnchanged;

    items.push({
      name: law.name,
      category: law.category,
      url: law.url,
      last_amend_date: result.amendDate,
      publish_date: result.publishDate,
      checked_at: checkedAt,
      matchType: "ok",
      trackable: true,
      fetch_error: null,
      content_updated_at: changed ? checkedAt : prev?.content_updated_at || checkedAt,
      newly_detected: changed && !!prev,
      newly_error: false,
    });

    const text = changed ? result.text : prevFulltext.get(law.name) || result.text;
    fulltextEntries.push({ name: law.name, content: text });
    console.log(changed ? `  → 偵測到日期變動（或首次執行），重新存全文` : `  → 日期沒變，沿用舊全文`);
  }

  const dataOutput = { generated_at: checkedAt, items };
  const fulltextOutput = { generated_at: checkedAt, laws: fulltextEntries };

  await mkdir(path.dirname(new URL(OUTPUT_DATA_PATH).pathname), { recursive: true }).catch(() => {});
  await writeFile(OUTPUT_DATA_PATH, JSON.stringify(dataOutput, null, 2), "utf8");
  await writeFile(OUTPUT_FULLTEXT_PATH, JSON.stringify(fulltextOutput, null, 2), "utf8");
  console.log(`已寫入 ${OUTPUT_DATA_PATH.pathname} 與 ${OUTPUT_FULLTEXT_PATH.pathname}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
