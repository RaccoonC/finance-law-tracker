// scripts/check-news.mjs
//
// 每天由 GitHub Actions 執行一次：
// 1. 用 data/laws-list.json 裡每一筆法規的名稱當關鍵字，
//    去 Google 新聞 RSS 搜尋「法規名稱 + 修正／草案／新制」相關新聞
// 2. 每則新聞第一次被抓到的時間記成 first_seen_at，之後每次執行都沿用
//    這個時間（不會因為又被搜到就更新）；is_new 代表「first_seen_at 距離
//    現在還在 recent_window_days 天以內」，讓網頁上的「新出現」標籤可以
//    維持顯示一段時間，而不是只有偵測到的那一天才看得到
// 3. first_seen_this_run 才是「這次執行才第一次看到」，只會是 true 一次，
//    通知信用這個欄位判斷要不要提醒，避免同一則新聞連續好幾天都寄信
// 4. 寫入 data/news-feed.json，前端「📰 最新動態」分頁讀這個檔案顯示
//
// 用 Google News RSS 是因為不需要申請 API 金鑰、任何人都能直接查詢，
// 缺點是版面/格式如果哪天改版，這支腳本可能要跟著調整。

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = new URL("../data/", import.meta.url);
const LIST_PATH = new URL("laws-list.json", DATA_DIR);
const OUTPUT_PATH = new URL("news-feed.json", DATA_DIR);

const MAX_ITEMS_PER_KEYWORD = 3; // 每個關鍵字最多留幾則，避免單一法規洗版
const MAX_TOTAL_ITEMS = 150; // 檔案最終最多保留幾則（依發布時間排序取新的）
const REQUEST_DELAY_MS = 400; // 每次查詢間隔，避免短時間內對 Google 送出太多請求
const RECENT_WINDOW_DAYS = 14; // 「新出現」標籤要維持顯示幾天

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripCDATA(text) {
  if (!text) return "";
  return text.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// 輕量解析 Google News RSS，不引入完整 XML 套件（格式固定、欄位單純，用正則就夠）
function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.split("<item>").slice(1);
  for (const block of itemBlocks) {
    const body = block.split("</item>")[0];
    const titleMatch = body.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = body.match(/<link>([\s\S]*?)<\/link>/);
    const pubDateMatch = body.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const sourceMatch = body.match(/<source[^>]*>([\s\S]*?)<\/source>/);

    let title = decodeEntities(stripCDATA(titleMatch ? titleMatch[1] : ""));
    const link = decodeEntities(stripCDATA(linkMatch ? linkMatch[1] : ""));
    const pubDate = pubDateMatch ? pubDateMatch[1].trim() : "";
    let source = sourceMatch ? decodeEntities(stripCDATA(sourceMatch[1])) : "";

    // Google News 標題常常是「標題 - 來源」，如果抓到 source 就把標題裡重複的來源後綴拿掉
    if (source && title.endsWith(" - " + source)) {
      title = title.slice(0, -(source.length + 3));
    }

    if (title && link) {
      items.push({ title, link, pub_date: pubDate, source });
    }
  }
  return items;
}

async function fetchNewsForKeyword(keyword) {
  const query = encodeURIComponent(`"${keyword}" (修正 OR 修法 OR 草案 OR 新制)`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "finance-law-tracker/1.0 (+github actions)" },
    });
    if (!res.ok) {
      const msg = `(${keyword}) 新聞查詢失敗：HTTP ${res.status}`;
      console.log(msg);
      return { items: [], error: msg };
    }
    const xml = await res.text();
    const items = parseRssItems(xml).slice(0, MAX_ITEMS_PER_KEYWORD);
    return { items: items.map((item) => ({ ...item, keyword })), error: null };
  } catch (err) {
    const msg = `(${keyword}) 新聞查詢發生錯誤：${err.message}`;
    console.log(msg);
    return { items: [], error: msg };
  }
}

async function loadPreviousItemsByLink() {
  try {
    const raw = await readFile(OUTPUT_PATH, "utf8");
    const json = JSON.parse(raw);
    const byLink = new Map();
    for (const item of json.items || []) {
      byLink.set(item.link, item);
    }
    return byLink;
  } catch {
    return new Map(); // 第一次執行，還沒有舊資料
  }
}

async function main() {
  const listRaw = await readFile(LIST_PATH, "utf8");
  const laws = JSON.parse(listRaw);
  const keywords = [...new Set(laws.map((l) => l.name))]; // 用法規名稱去重複當關鍵字

  console.log(`共 ${keywords.length} 個關鍵字，開始查詢新聞…`);

  const previousByLink = await loadPreviousItemsByLink();
  let allItems = [];
  const errors = [];

  for (const keyword of keywords) {
    const { items, error } = await fetchNewsForKeyword(keyword);
    if (error) errors.push(error);
    if (items.length) {
      console.log(`(${keyword}) 找到 ${items.length} 則`);
      allItems = allItems.concat(items);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  // 依連結去重複（同一則新聞可能被多個關鍵字都搜到），關鍵字合併起來方便看出關聯
  const byLink = new Map();
  for (const item of allItems) {
    if (!byLink.has(item.link)) {
      byLink.set(item.link, item);
    } else {
      const existing = byLink.get(item.link);
      if (!existing.keyword.includes(item.keyword)) {
        existing.keyword = existing.keyword + "、" + item.keyword;
      }
    }
  }

  const now = new Date();
  const nowIso = now.toISOString();

  let uniqueItems = [...byLink.values()].map((item) => {
    const prev = previousByLink.get(item.link);
    const firstSeenAt = prev ? prev.first_seen_at : nowIso; // 沿用第一次被看到的時間，不會因為又搜到就更新
    const firstSeenThisRun = !prev; // 只有這次才第一次出現時才是 true
    const ageDays = (now - new Date(firstSeenAt)) / (1000 * 60 * 60 * 24);
    return {
      ...item,
      first_seen_at: firstSeenAt,
      first_seen_this_run: firstSeenThisRun,
      is_new: ageDays <= RECENT_WINDOW_DAYS,
    };
  });

  // 依發布時間新到舊排序（解析失敗的日期排到最後），只保留前 MAX_TOTAL_ITEMS 筆
  uniqueItems.sort((a, b) => {
    const da = Date.parse(a.pub_date);
    const db = Date.parse(b.pub_date);
    if (isNaN(da) && isNaN(db)) return 0;
    if (isNaN(da)) return 1;
    if (isNaN(db)) return -1;
    return db - da;
  });
  uniqueItems = uniqueItems.slice(0, MAX_TOTAL_ITEMS);

  const newThisRunCount = uniqueItems.filter((i) => i.first_seen_this_run).length;
  console.log(`共取得 ${uniqueItems.length} 則不重複新聞，其中 ${newThisRunCount} 則是這次才第一次出現`);

  const output = {
    generated_at: nowIso,
    recent_window_days: RECENT_WINDOW_DAYS,
    items: uniqueItems,
    errors,
  };

  await mkdir(path.dirname(new URL(OUTPUT_PATH).pathname), { recursive: true }).catch(() => {});
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf8");
  console.log(`已寫入 ${OUTPUT_PATH.pathname}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
