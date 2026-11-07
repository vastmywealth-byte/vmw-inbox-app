// ============================================================
// Cloudflare Pages Function — answers every /api/* request.
//
// Browser  ->  /api/*  (this file)  ->  Google Apps Script
//
// Why it exists:
//   1. The Apps Script URL and secret key never reach the browser.
//   2. Every request needs the inbox password (X-Inbox-Password header).
//   3. The thread list and quick replies are cached for a few seconds at
//      Cloudflare's edge, so repeated refreshes don't hit Apps Script.
//
// Settings (Cloudflare Pages > your project > Settings > Variables and Secrets):
//   APPS_SCRIPT_URL  = https://script.google.com/macros/s/XXXX/exec
//   INBOX_KEY        = same value as the INBOX_KEY script property in Apps Script (Secret)
//   INBOX_PASSWORD   = the password you type into the app once per phone (Secret)
// ============================================================

const CACHE_HOST = "https://inbox-cache.internal/";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");

  const sent = request.headers.get("X-Inbox-Password") || "";
  if (!env.INBOX_PASSWORD || !safeEqual(sent, env.INBOX_PASSWORD)) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }
  if (!env.APPS_SCRIPT_URL || !env.INBOX_KEY) {
    return json({ success: false, error: "Server is not configured (APPS_SCRIPT_URL / INBOX_KEY missing)." }, 500);
  }

  try {
    // Used by the login screen to check the password.
    if (route === "login" && request.method === "GET") {
      return json({ success: true });
    }

    if (route === "threads" && request.method === "GET") {
      const data = await cachedJson("threads", 8, () => gasGet(env, { action: "getManualInboxThreads" }));
      return json(data);
    }

    if (route === "quick-replies" && request.method === "GET") {
      const data = await cachedJson("quick-replies", 120, () => gasGet(env, { action: "getQuickReplies" }));
      return json(data);
    }

    if (route === "messages" && request.method === "GET") {
      const mobile = (url.searchParams.get("mobile") || "").replace(/\D/g, "").slice(-10);
      if (mobile.length !== 10) return json({ success: false, error: "Invalid mobile number." }, 400);
      // Never cached: an open conversation must always be live.
      return json(await gasGet(env, { action: "getManualInboxMessages", mobile: mobile }));
    }

    if (route === "send" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { return json({ success: false, error: "Invalid request." }, 400); }
      const mobile = String(body.mobile || "").replace(/\D/g, "").slice(-10);
      const message = String(body.message || "");
      if (mobile.length !== 10 || !message.trim()) return json({ success: false, error: "Missing mobile or message." }, 400);
      if (message.length > 4000) return json({ success: false, error: "Message is too long." }, 400);

      const result = await gasPost(env, { action: "sendManualReply", mobile: mobile, message: message });
      // The thread list just changed — drop the cached copy.
      try { await caches.default.delete(new Request(CACHE_HOST + "threads")); } catch (e) { /* ignore */ }
      return json(result);
    }

    return json({ success: false, error: "Unknown route." }, 404);
  } catch (err) {
    return json({ success: false, error: "Upstream error: " + String(err) }, 502);
  }
}

// ---------- Apps Script calls ----------
async function gasGet(env, params) {
  const u = new URL(env.APPS_SCRIPT_URL);
  Object.keys(params).forEach(function (k) { u.searchParams.set(k, params[k]); });
  u.searchParams.set("key", env.INBOX_KEY);
  const res = await fetch(u.toString(), { redirect: "follow" });
  return parseGas(await res.text());
}

async function gasPost(env, payload) {
  payload.key = env.INBOX_KEY;
  // text/plain keeps Apps Script happy; its 302 redirect is followed automatically.
  const res = await fetch(env.APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
    redirect: "follow"
  });
  return parseGas(await res.text());
}

function parseGas(text) {
  try { return JSON.parse(text); }
  catch (e) { return { success: false, error: "Apps Script returned an unexpected reply. Check the deployment is up to date." }; }
}

// ---------- Edge cache (only successful replies are stored) ----------
async function cachedJson(key, ttlSeconds, producer) {
  const cache = caches.default;
  const req = new Request(CACHE_HOST + key);
  try {
    const hit = await cache.match(req);
    if (hit) return await hit.json();
  } catch (e) { /* cache unavailable — fall through to live call */ }
  const data = await producer();
  if (data && data.success) {
    try {
      await cache.put(req, new Response(JSON.stringify(data), { headers: { "Cache-Control": "max-age=" + ttlSeconds } }));
    } catch (e) { /* ignore */ }
  }
  return data;
}

// ---------- helpers ----------
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
