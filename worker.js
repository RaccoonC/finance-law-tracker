// worker.js
//
// 這個 Worker 除了原本的靜態網站，多處理一個 API 路徑：
//   GET    /api/manual-entries        取得所有補充資料
//   POST   /api/manual-entries        新增／覆蓋一筆補充資料（依名稱比對，同名覆蓋）
//   DELETE /api/manual-entries?name=X 刪除一筆補充資料
//
// 資料存在 Cloudflare KV（見 wrangler.jsonc 的 kv_namespaces 設定），
// 所有使用者共用同一份資料，不需要再手動下載 JSON、上傳 GitHub。
//
// ⚠️ 這個 API 沒有登入驗證，任何拿到網址的人都可以新增/刪除資料。
// 如果之後需要加密碼保護，需要另外設計驗證機制。

const KV_KEY = "manual-entries";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

async function loadEntries(env) {
  const raw = await env.MANUAL_ENTRIES.get(KV_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveEntries(env, entries) {
  await env.MANUAL_ENTRIES.put(KV_KEY, JSON.stringify(entries));
}

async function handleManualEntries(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (request.method === "GET") {
    const entries = await loadEntries(env);
    return jsonResponse({ generated_at: new Date().toISOString(), entries });
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "請求格式錯誤" }, 400);
    }
    const name = (body.name || "").trim();
    const content = (body.content || "").trim();
    if (!name || !content) {
      return jsonResponse({ error: "資料名稱和內容不能空白" }, 400);
    }
    const entries = await loadEntries(env);
    const idx = entries.findIndex((e) => e.name === name);
    const entry = { name, content, added_at: new Date().toISOString() };
    if (idx >= 0) {
      entries[idx] = entry;
    } else {
      entries.push(entry);
    }
    await saveEntries(env, entries);
    return jsonResponse({ generated_at: new Date().toISOString(), entries });
  }

  if (request.method === "DELETE") {
    const url = new URL(request.url);
    const name = url.searchParams.get("name");
    if (!name) {
      return jsonResponse({ error: "缺少 name 參數" }, 400);
    }
    let entries = await loadEntries(env);
    entries = entries.filter((e) => e.name !== name);
    await saveEntries(env, entries);
    return jsonResponse({ generated_at: new Date().toISOString(), entries });
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/manual-entries") {
      return handleManualEntries(request, env);
    }

    // 其餘路徑（網頁本體、data/*.json 等）一律交給靜態資源處理
    return env.ASSETS.fetch(request);
  },
};
