const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

function trimSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

const API_BASE_URL_RAW = trimSlash(process.env.MIGHTYCALL_API_BASE_URL || "https://api.mightycall.com/v4");
const API_KEY = process.env.MIGHTYCALL_API_KEY;
// Support both the legacy single secret and numbered secrets for multi-agent webphone:
// - MIGHTYCALL_SECRET_KEY (agent 1)
// - MIGHTYCALL_SECRET_KEYS (agents 2..N, comma separated)
// - OR: MIGHTYCALL_SECRET_KEY_1..MIGHTYCALL_SECRET_KEY_10 (agents 1..10)
// For API calls, use MIGHTYCALL_API_SECRET_KEY if present (recommended).
const API_SECRET_KEY = process.env.MIGHTYCALL_API_SECRET_KEY || process.env.MIGHTYCALL_SECRET_KEY; // user key OR extension

// For WebPhone (browser), use separate secrets so you can keep API auth stable.
const WEBPHONE_SECRET_KEY = process.env.MIGHTYCALL_WEBPHONE_SECRET_KEY || process.env.MIGHTYCALL_SECRET_KEY;
const WEBPHONE_SECRET_KEYS = String(process.env.MIGHTYCALL_WEBPHONE_SECRET_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const WEBPHONE_NUMBERED_SECRETS = Array.from({ length: 10 })
  .map((_, i) => process.env[`MIGHTYCALL_WEBPHONE_SECRET_KEY_${i + 1}`])
  .map((s) => String(s || "").trim())
  .filter(Boolean);
const PORT = Number(process.env.PORT || 5173);
const APP_ACCESS_KEY = process.env.APP_ACCESS_KEY || "";

const CONFIG_OK = Boolean(API_KEY && API_SECRET_KEY);
if (!CONFIG_OK) {
  // eslint-disable-next-line no-console
  console.warn(
    "Server is running but not configured. Create a .env file with MIGHTYCALL_API_KEY and MIGHTYCALL_SECRET_KEY (see .env.example).",
  );
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Serve the frontend
app.use(express.static(path.join(__dirname, "public")));

let tokenCache =
  /** @type {{ accessToken: string; refreshToken?: string; expiresAtMs: number; tokenBaseUrl: string } | null} */ (null);

function nowMs() {
  return Date.now();
}

async function httpJson(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    // @ts-ignore
    err.details = json;
    // @ts-ignore
    err.status = res.status;
    throw err;
  }
  return json;
}

function candidateTokenBases() {
  const input = API_BASE_URL_RAW;
  const hasApi = input.endsWith("/api");
  const base = hasApi ? input.slice(0, -4) : input;

  const set = new Set();
  const add = (b) => {
    const trimmed = trimSlash(b);
    set.add(trimmed);
  };

  add(base);

  // Many accounts use ccapi.mightycall.com (Contact Center) instead of api.mightycall.com
  if (base.includes("api.mightycall.com")) add(base.replace("api.mightycall.com", "ccapi.mightycall.com"));
  if (base.includes("ccapi.mightycall.com")) add(base.replace("ccapi.mightycall.com", "api.mightycall.com"));

  return [...set];
}

function candidateApiBases() {
  const bases = candidateTokenBases();
  return bases.map((b) => `${trimSlash(b)}/api`);
}

async function httpJsonWithBaseFallback(pathname, { method = "GET", headers = {}, body } = {}) {
  // If we already got a token, prefer calling APIs on the same host family.
  const preferredApiBase = tokenCache?.tokenBaseUrl ? `${trimSlash(tokenCache.tokenBaseUrl)}/api` : null;
  const bases = preferredApiBase
    ? [preferredApiBase, ...candidateApiBases().filter((b) => b !== preferredApiBase)]
    : candidateApiBases();

  let lastErr;
  for (const b of bases) {
    try {
      const json = await httpJson(`${b}${pathname}`, { method, headers, body });
      return { json, baseUsed: b };
    } catch (e) {
      lastErr = e;
      const status = e?.status;
      const apiError = e?.details?.error;
      // Fallback on:
      // - 404: wrong base path (/api vs not)
      // - invalid_client: often wrong host (api vs ccapi) OR wrong secret mode (user key vs extension)
      if (!(status === 404 || (status === 400 && apiError === "invalid_client"))) break;
    }
  }
  throw lastErr || new Error("Request failed");
}

async function fetchTokenByClientCredentials() {
  if (!CONFIG_OK) throw new Error("Server not configured: set MIGHTYCALL_API_KEY and MIGHTYCALL_SECRET_KEY in .env");
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", API_KEY);
  body.set("client_secret", API_SECRET_KEY);

  // Token endpoint for these APIs lives at {tokenBase}/auth/token (note: NOT under /api)
  const tokenBases = candidateTokenBases();
  let lastErr;
  /** @type {{ json: any; baseUsed: string } | null} */
  let ok = null;
  for (const b of tokenBases) {
    try {
      const json = await httpJson(`${b}/auth/token`, {
        method: "POST",
        headers: {
          "x-api-key": API_KEY,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      ok = { json, baseUsed: b };
      break;
    } catch (e) {
      lastErr = e;
      const status = e?.status;
      const apiError = e?.details?.error;
      // Try other hosts on invalid_client; otherwise fail fast.
      if (!(status === 400 && apiError === "invalid_client")) break;
    }
  }
  if (!ok) throw lastErr || new Error("Auth token request failed");
  const { json, baseUsed } = ok;

  const accessToken = json?.access_token;
  const refreshToken = json?.refresh_token;
  const expiresIn = Number(json?.expires_in || 0);
  if (!accessToken || !expiresIn) throw new Error("Auth token response missing access_token/expires_in");

  tokenCache = {
    accessToken,
    refreshToken,
    // refresh a bit early
    expiresAtMs: nowMs() + expiresIn * 1000 - 60_000,
    tokenBaseUrl: baseUsed,
  };

  return tokenCache.accessToken;
}

async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAtMs > nowMs()) return tokenCache.accessToken;
  return fetchTokenByClientCredentials();
}

async function mightycallRequest(pathname, { method = "GET", bodyJson } = {}) {
  if (!CONFIG_OK) throw new Error("Server not configured: set MIGHTYCALL_API_KEY and MIGHTYCALL_SECRET_KEY in .env");
  const accessToken = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "x-api-key": API_KEY,
  };
  let body;
  if (bodyJson !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(bodyJson);
  }
  const { json } = await httpJsonWithBaseFallback(pathname, { method, headers, body });
  return json;
}

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    configured: CONFIG_OK,
    apiBaseUrl: API_BASE_URL_RAW,
    tokenBaseCandidates: candidateTokenBases(),
    apiBaseCandidates: candidateApiBases(),
    tokenBaseUrl: tokenCache?.tokenBaseUrl || null,
  }),
);

app.post("/api/auth/test", async (_req, res) => {
  try {
    const accessToken = await getAccessToken();
    res.json({ ok: true, tokenPreview: `${String(accessToken).slice(0, 12)}...` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e), details: e?.details });
  }
});

app.get("/api/phonenumbers", async (_req, res) => {
  try {
    const json = await mightycallRequest("/phonenumbers");
    res.json(json);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e), details: e?.details });
  }
});

function requireAppKey(req) {
  if (!APP_ACCESS_KEY) return true;
  const got = String(req.headers["x-app-key"] || "");
  return got && got === APP_ACCESS_KEY;
}

// WebPhone SDK config (client-side WebRTC phone).
// NOTE: The WebPhone SDK itself requires login/password in the browser to register the softphone.
// This endpoint can be protected by APP_ACCESS_KEY to avoid anonymous use.
app.get("/api/webphone/config", async (req, res) => {
  if (!requireAppKey(req)) return res.status(401).json({ ok: false, error: "Unauthorized" });
  if (!CONFIG_OK) return res.status(500).json({ ok: false, error: "Server not configured (.env missing keys)" });

  const agent = Number(req.query.agent || 0);
  const allSecrets =
    WEBPHONE_NUMBERED_SECRETS.length > 0
      ? WEBPHONE_NUMBERED_SECRETS
      : [WEBPHONE_SECRET_KEY, ...WEBPHONE_SECRET_KEYS].filter(Boolean);
  if (allSecrets.length === 0) {
    return res.status(500).json({
      ok: false,
      error:
        "WebPhone is not configured. Set MIGHTYCALL_WEBPHONE_SECRET_KEY (and optionally MIGHTYCALL_WEBPHONE_SECRET_KEYS).",
    });
  }
  const password = allSecrets[Math.max(0, Math.min(allSecrets.length - 1, agent))] || WEBPHONE_SECRET_KEY;

  try {
    // ensure tokenBaseUrl is discovered so we can build the correct SDK URL (api vs ccapi)
    await getAccessToken();
    const tokenBaseUrl = tokenCache?.tokenBaseUrl || candidateTokenBases()[0];
    const sdkScriptUrl = `${trimSlash(tokenBaseUrl)}/sdk/mightycall.webphone.sdk.js`;

    res.json({
      ok: true,
      sdkScriptUrl,
      mcConfig: { login: API_KEY, password },
      agentCount: allSecrets.length,
      agent,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e), details: e?.details });
  }
});

app.post("/api/calls/makecall", async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ ok: false, error: "`from` and `to` are required" });

  try {
    const json = await mightycallRequest("/calls/makecall", { method: "POST", bodyJson: { from, to } });
    res.json(json);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e), details: e?.details });
  }
});

// Call the same destination from multiple business numbers in parallel.
app.post("/api/calls/makecall/bulk", async (req, res) => {
  const { fromNumbers, to } = req.body || {};
  if (!Array.isArray(fromNumbers) || fromNumbers.length === 0 || !to) {
    return res.status(400).json({ ok: false, error: "`fromNumbers` (array) and `to` are required" });
  }

  try {
    const results = await Promise.allSettled(
      fromNumbers.map((from) => mightycallRequest("/calls/makecall", { method: "POST", bodyJson: { from, to } })),
    );
    res.json({
      ok: true,
      results: results.map((r, i) =>
        r.status === "fulfilled"
          ? { from: fromNumbers[i], ok: true, data: r.value }
          : { from: fromNumbers[i], ok: false, error: r.reason?.message || String(r.reason), details: r.reason?.details },
      ),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e), details: e?.details });
  }
});

// SPA fallback
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Dialer running on http://localhost:${PORT}`);
});

