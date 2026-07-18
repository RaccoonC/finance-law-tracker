// scripts/update-laws.mjs
//
// 每天由 GitHub Actions 執行一次：
// 1. 從「全國法規資料庫 Open API」下載現行法規清單（zip 壓縮的 JSON 全量檔）
// 2. 用 data/laws-list.json 裡的法規名稱去比對（含正規化/模糊比對容錯），
//    取出「最新修正日期」「公布日期」兩個欄位、PCode、連結
// 3. 寫入 data/laws-data.json，前端頁面 finance-laws.html 直接讀這個檔案顯示
//
// 欄位名稱是依 Swagger 文件與社群專案推測的，如果比對成功率仍然偏低，
// 請把 log 裡「範例第一筆」那段原始 JSON 貼給我，才能百分之百對到正確欄位。

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";

const API_URL = "https://law.moj.gov.tw/api/Ch/Law/JSON";
const LAW_DETAIL_BASE = "https://law.moj.gov.tw/LawClass/LawAll.aspx?PCode=";

const DATA_DIR = new URL("../data/", import.meta.url);
const LIST_PATH = new URL("laws-list.json", DATA_DIR);
const OUTPUT_PATH = new URL("laws-data.json", DATA_DIR);

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
// 最新修正日期（法規沿革中最後一次修正/廢止/制定的日期，8 碼西元年 YYYYMMDD）
function getAmendDateRaw(record) {
  return pickField(record, ["LawModifiedDate", "lawModifiedDate", "ModifiedDate"]);
}
function getHistories(record) {
  return pickField(record, ["LawHistories", "lawHistories", "Histories"]);
}
function getForewordUrl(record) {
  return pickField(record, ["LawURL", "LawUrl", "lawURL"]);
}
function getCategory(record) {
  return pickField(record, ["LawCategory", "LawLevel"]);
}

// 官方 LawModifiedDate 是 8 碼西元年格式（例如 19470101 = 西元1947年1月1日），
// 轉成前端頁面 parseROCDate() 看得懂的「民國36年01月01日」字串。
function gregorianToROCString(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, yyyy, mm, dd] = m;
  const rocYear = Number(yyyy) - 1911;
  if (rocYear <= 0) return null;
  return `民國${rocYear}年${mm}月${dd}日`;
}

// 中文數字（含十/百）轉阿拉伯數字，用來解析 LawHistories 裡「三十六年一月一日」這種寫法
function cnNumberToInt(cn) {
  const digits = { 零:0, 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
  const units = { 十:10, 百:100, 千:1000 };
  if (/^\d+$/.test(cn)) return parseInt(cn, 10);
  let total = 0;
  let current = 0;
  for (const ch of cn) {
    if (digits[ch] !== undefined) {
      current = digits[ch];
    } else if (units[ch] !== undefined) {
      total += (current || 1) * units[ch];
      current = 0;
    }
  }
  return total + current;
}

// 從 LawHistories 自由文字裡，抓出「…年…月…日〈至多15字〉公布」這段，
// 換算成「民國36年01月01日」字串。找不到就回傳 null。
function extractPublishDate(historiesText) {
  if (!historiesText) return null;
  const re = /中華民國([一二三四五六七八九十百零\d]+)年([一二三四五六七八九十百零\d]+)月([一二三四五六七八九十百零\d]+)日[^\n]{0,15}?公布/;
  const m = historiesText.match(re);
  if (!m) return null;
  const rocYear = cnNumberToInt(m[1]);
  const month = cnNumberToInt(m[2]);
  const day = cnNumberToInt(m[3]);
  if (!rocYear || !month || !day) return null;
  return `民國${rocYear}年${String(month).padStart(2, "0")}月${String(day).padStart(2, "0")}日`;
}

// 名稱正規化：拿掉常見的版本註記、全形/半形空白，方便模糊比對
function normalizeName(name) {
  if (!name) return "";
  return name
    .replace(/[（(][^）)]*[）)]\s*$/g, "") // 去掉結尾括號註記，例如（110.10.10 制定）
    .replace(/[\s　]+/g, "") // 去掉所有空白（含全形空白）
    .trim();
}

// 去掉 UTF-8 BOM（檔案開頭常見的隱藏標記字元，JSON.parse 遇到會直接報錯）
function stripBOM(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function extractArray(json, sourceLabel) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    const direct = json.Laws || json.laws || json.Data || json.data;
    if (Array.isArray(direct)) return direct;

    // 找不到常見鍵名時，自動挑出物件裡「元素最多的那個陣列」，
    // 這樣就不用管官方到底把資料包在哪個鍵名底下。
    let best = [];
    let bestKey = null;
    for (const key of Object.keys(json)) {
      const val = json[key];
      if (Array.isArray(val) && val.length > best.length) {
        best = val;
        bestKey = key;
      }
    }
    if (best.length > 0) {
      console.log(`(${sourceLabel}) 自動判斷資料陣列在鍵名 "${bestKey}" 底下，共 ${best.length} 筆`);
      return best;
    }
    console.log(`(${sourceLabel}) 找不到任何陣列欄位，最外層鍵名為：`, Object.keys(json));
  }
  return [];
}

async function fetchLawDump() {
  console.log(`下載開放資料：${API_URL}`);
  const res = await fetch(API_URL, {
    headers: { "User-Agent": "finance-law-tracker/1.0 (+github actions)" },
  });
  if (!res.ok) throw new Error(`下載失敗：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const isZip = buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b;

  let combined = [];
  if (isZip) {
    console.log("偵測到回傳內容是 zip 壓縮檔，先解壓縮…");
    const zip = new AdmZip(buf);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    console.log(`zip 內含 ${entries.length} 個檔案：`, entries.map((e) => e.entryName).slice(0, 20));
    for (const entry of entries) {
      const text = stripBOM(entry.getData().toString("utf8"));
      try {
        const arr = extractArray(JSON.parse(text), entry.entryName);
        if (arr.length) combined = combined.concat(arr);
      } catch (e) {
        console.log(`(${entry.entryName}) 不是可解析的 JSON，略過：${e.message}`);
      }
    }
  } else {
    combined = extractArray(JSON.parse(stripBOM(buf.toString("utf8"))), "root");
  }

  if (combined.length === 0) {
    throw new Error("解壓縮/解析後找不到任何法規資料，請人工確認 zip 內檔案結構。");
  }

  console.log(`共取得 ${combined.length} 筆法規，範例第一筆：`);
  console.log(JSON.stringify(combined[0], null, 2).slice(0, 1000));
  return combined;
}

function buildIndexes(dump) {
  const byExactName = new Map();
  const byNormalizedName = new Map();
  for (const record of dump) {
    const name = getName(record);
    if (!name) continue;
    if (!byExactName.has(name)) byExactName.set(name, record);
    const norm = normalizeName(name);
    if (norm && !byNormalizedName.has(norm)) byNormalizedName.set(norm, record);
  }
  return { byExactName, byNormalizedName };
}

// 三段式比對：完全相等 → 正規化後相等 → 正規化後互相包含（模糊比對，標記為 fuzzy）
function findMatch(law, dump, { byExactName, byNormalizedName }) {
  if (byExactName.has(law.name)) {
    return { record: byExactName.get(law.name), matchType: "exact" };
  }
  const norm = normalizeName(law.name);
  if (byNormalizedName.has(norm)) {
    return { record: byNormalizedName.get(norm), matchType: "normalized" };
  }
  // 模糊比對：官方名稱包含我們的名稱，或我們的名稱包含官方名稱（避免太短造成誤判，長度需 >= 4）
  if (norm.length >= 4) {
    for (const record of dump) {
      const officialNorm = normalizeName(getName(record));
      if (!officialNorm || officialNorm.length < 4) continue;
      if (officialNorm.includes(norm) || norm.includes(officialNorm)) {
        return { record, matchType: "fuzzy" };
      }
    }
  }
  return null;
}

async function main() {
  const listRaw = await readFile(LIST_PATH, "utf8");
  const trackedLaws = JSON.parse(listRaw);

  let dump = [];
  let fetchError = null;
  try {
    dump = await fetchLawDump();
  } catch (err) {
    fetchError = err.message;
    console.error("抓取全量資料失敗：", err.message);
  }

  const indexes = buildIndexes(dump);
  const checkedAt = new Date().toISOString();

  const results = trackedLaws.map((law) => {
    const base = { ...law, checked_at: checkedAt };
    if (!law.trackable) {
      return {
        ...base,
        last_amend_date: null,
        publish_date: null,
        pcode: null,
        url: null,
        fetch_error: "非全國法規資料庫收錄之單一命名法規，" + (law.note || "無法自動追蹤"),
        matchType: "not_trackable",
      };
    }

    const match = findMatch(law, dump, indexes);
    if (!match) {
      return {
        ...base,
        last_amend_date: null,
        publish_date: null,
        pcode: null,
        url: null,
        fetch_error: fetchError || "在官方開放資料中找不到符合名稱的法規，可能名稱需要微調",
        matchType: "not_found",
      };
    }

    const { record, matchType } = match;
    const pcode = getPCode(record);
    return {
      ...base,
      last_amend_date: gregorianToROCString(getAmendDateRaw(record)),
      publish_date: extractPublishDate(getHistories(record)),
      pcode,
      url: getForewordUrl(record) || (pcode ? `${LAW_DETAIL_BASE}${pcode}` : null),
      fetch_error: matchType === "fuzzy" ? `模糊比對到「${getName(record)}」，建議人工核對是否為同一法規` : null,
      matchType,
    };
  });

  const notFound = results.filter((r) => r.matchType === "not_found");
  const fuzzy = results.filter((r) => r.matchType === "fuzzy");
  if (notFound.length) {
    console.warn(`有 ${notFound.length} 筆找不到符合名稱的法規：`, notFound.map((r) => r.name));
  }
  if (fuzzy.length) {
    console.warn(`有 ${fuzzy.length} 筆是模糊比對，建議人工核對：`, fuzzy.map((r) => `${r.name} → ${byNameOf(r)}`));
  }
  function byNameOf(r) { return r.fetch_error; }

  const output = {
    generated_at: checkedAt,
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
