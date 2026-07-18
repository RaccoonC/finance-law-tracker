// scripts/update-laws.mjs
//
// 每天由 GitHub Actions 執行一次：
// 1. 從「全國法規資料庫 Open API」下載現行法規清單（JSON 全量檔）
// 2. 用 data/laws-list.json 裡的法規名稱去比對，取出修正日期、PCode、連結
// 3. 寫入 data/laws-data.json，前端頁面 finance-laws.html 直接讀這個檔案顯示
//
// 注意：law.moj.gov.tw 會阻擋部分自動化流量（robots.txt），我這邊的開發環境
// 無法直接連線驗證欄位名稱，以下寫法是依官方 Swagger（/api/swagger/index.html）
// 揭露的路徑，加上其他開發者專案（如 kong0107/mojLawSplit）記錄過的欄位名稱
// 組合而成。第一次跑的時候，請先看 Action log 裡印出的「原始資料範例」，
// 確認欄位名稱與程式裡的 candidateKeys 一致；如果 API 回傳結構不同，
// 只要調整 pickField() 裡的候選欄位名稱即可，不需要改其他邏輯。

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";

const API_URL = "https://law.moj.gov.tw/api/Ch/Law/JSON"; // 現行法規開放資料（全量）
const LAW_DETAIL_BASE = "https://law.moj.gov.tw/LawClass/LawAll.aspx?PCode=";

const DATA_DIR = new URL("../data/", import.meta.url);
const LIST_PATH = new URL("laws-list.json", DATA_DIR);
const OUTPUT_PATH = new URL("laws-data.json", DATA_DIR);

// 幾種可能的欄位命名（依大小寫 / 底線差異做容錯）
function pickField(record, candidateKeys) {
  for (const key of candidateKeys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") {
      return record[key];
    }
  }
  return null;
}

function getName(record) {
  return pickField(record, ["LawName", "lawName", "Name", "name"]);
}
function getPCode(record) {
  return pickField(record, ["PCode", "pcode", "LawPCode"]);
}
function getModifiedDate(record) {
  return pickField(record, [
    "LawModifiedDate",
    "lawModifiedDate",
    "ModifiedDate",
    "LawModifyDate",
  ]);
}
function getForewordUrl(record) {
  return pickField(record, ["LawURL", "LawUrl", "lawURL"]);
}

// 民國年（如 1150618）轉西元日期字串
function rocToDate(rocStr) {
  if (!rocStr) return null;
  const s = String(rocStr).trim();
  const m = s.match(/^(\d{2,3})(\d{2})(\d{2})$/);
  if (!m) return s; // 格式不明就原樣回傳，讓人工檢查
  const [, roc, mm, dd] = m;
  const year = Number(roc) + 1911;
  return `${year}-${mm}-${dd}`;
}

// 把單一 parse 出來的 JSON 內容轉成法規陣列（官方格式可能是 { Laws: [...] } 或直接就是陣列）
function extractArray(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    return json.Laws || json.laws || json.Data || json.data || [];
  }
  return [];
}

async function fetchLawDump() {
  console.log(`下載開放資料：${API_URL}`);
  const res = await fetch(API_URL, {
    headers: { "User-Agent": "finance-law-tracker/1.0 (+github actions)" },
  });
  if (!res.ok) {
    throw new Error(`下載失敗：HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  // 官方 API 回傳的其實是「壓縮成 zip 的 JSON」，檔頭是 PK，不是直接的 JSON 文字。
  // 判斷開頭兩個 byte 是不是 "PK"（zip 檔特徵），是的話先解壓縮再解析。
  const isZip = buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b; // 'P' 'K'

  let combined = [];
  if (isZip) {
    console.log("偵測到回傳內容是 zip 壓縮檔，先解壓縮…");
    const zip = new AdmZip(buf);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    console.log(`zip 內含 ${entries.length} 個檔案：`, entries.map((e) => e.entryName).slice(0, 20));

    for (const entry of entries) {
      const text = entry.getData().toString("utf8");
      try {
        const json = JSON.parse(text);
        const arr = extractArray(json);
        if (arr.length) combined = combined.concat(arr);
      } catch {
        // 不是 JSON 的檔案（例如說明文件）就跳過
      }
    }
  } else {
    const text = buf.toString("utf8");
    const json = JSON.parse(text);
    combined = extractArray(json);
  }

  if (combined.length === 0) {
    throw new Error("解壓縮/解析後找不到任何法規資料，請人工確認 zip 內檔案結構。");
  }

  console.log(`共取得 ${combined.length} 筆法規，範例第一筆：`);
  console.log(JSON.stringify(combined[0], null, 2).slice(0, 800));
  return combined;
}

async function main() {
  const listRaw = await (await import("node:fs/promises")).readFile(LIST_PATH, "utf8");
  const trackedLaws = JSON.parse(listRaw);

  let dump = [];
  let fetchError = null;
  try {
    dump = await fetchLawDump();
  } catch (err) {
    fetchError = err.message;
    console.error("抓取全量資料失敗：", err.message);
  }

  // 用法規名稱建立索引（同名取第一筆，官方資料通常同名只留最新版）
  const byName = new Map();
  for (const record of dump) {
    const name = getName(record);
    if (name && !byName.has(name)) byName.set(name, record);
  }

  const results = trackedLaws.map((law) => {
    if (!law.trackable) {
      return {
        ...law,
        status: "not_trackable",
        modifiedDate: null,
        pcode: null,
        url: null,
      };
    }
    const record = byName.get(law.name);
    if (!record) {
      return {
        ...law,
        status: fetchError ? "fetch_error" : "not_found",
        modifiedDate: null,
        pcode: null,
        url: null,
      };
    }
    const pcode = getPCode(record);
    return {
      ...law,
      status: "ok",
      modifiedDate: rocToDate(getModifiedDate(record)),
      pcode,
      url: getForewordUrl(record) || (pcode ? `${LAW_DETAIL_BASE}${pcode}` : null),
    };
  });

  const notFound = results.filter((r) => r.status === "not_found");
  if (notFound.length) {
    console.warn(
      `有 ${notFound.length} 筆在官方資料裡找不到同名法規，請人工確認名稱是否需要微調：`,
      notFound.map((r) => r.name)
    );
  }

  const output = {
    generatedAt: new Date().toISOString(),
    source: API_URL,
    fetchError,
    laws: results,
  };

  await mkdir(path.dirname(new URL(OUTPUT_PATH).pathname), { recursive: true }).catch(() => {});
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf8");
  console.log(`已寫入 ${OUTPUT_PATH.pathname}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
