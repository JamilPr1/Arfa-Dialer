function trimSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

const API_BASE_URL_RAW = trimSlash(process.env.MIGHTYCALL_API_BASE_URL || "https://api.mightycall.com/v4");
const API_KEY = process.env.MIGHTYCALL_API_KEY;
const API_SECRET_KEY = process.env.MIGHTYCALL_API_SECRET_KEY || process.env.MIGHTYCALL_SECRET_KEY;

let tokenCache = /** @type {{ accessToken: string; expiresAtMs: number; tokenBaseUrl: string } | null} */ (null);

function nowMs() {
  return Date.now();
}

async function httpJson(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers, body });
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
  const add = (b) => set.add(trimSlash(b));

  add(base);
  if (base.includes("api.mightycall.com")) add(base.replace("api.mightycall.com", "ccapi.mightycall.com"));
  if (base.includes("ccapi.mightycall.com")) add(base.replace("ccapi.mightycall.com", "api.mightycall.com"));
  return [...set];
}

function candidateApiBases() {
  return candidateTokenBases().map((b) => `${trimSlash(b)}/api`);
}

async function fetchTokenByClientCredentials() {
  if (!API_KEY || !API_SECRET_KEY) throw new Error("Missing env vars: MIGHTYCALL_API_KEY + MIGHTYCALL_API_SECRET_KEY");

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", API_KEY);
  body.set("client_secret", API_SECRET_KEY);

  let lastErr;
  for (const b of candidateTokenBases()) {
    try {
      const json = await httpJson(`${b}/auth/token`, {
        method: "POST",
        headers: { "x-api-key": API_KEY, "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      const accessToken = json?.access_token;
      const expiresIn = Number(json?.expires_in || 0);
      if (!accessToken || !expiresIn) throw new Error("Auth token response missing access_token/expires_in");
      tokenCache = {
        accessToken,
        expiresAtMs: nowMs() + expiresIn * 1000 - 60_000,
        tokenBaseUrl: b,
      };
      return tokenCache.accessToken;
    } catch (e) {
      lastErr = e;
      const status = e?.status;
      const apiError = e?.details?.error;
      if (!(status === 400 && apiError === "invalid_client")) break;
    }
  }
  throw lastErr || new Error("Auth token request failed");
}

async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAtMs > nowMs()) return tokenCache.accessToken;
  return fetchTokenByClientCredentials();
}

async function mightycallRequest(pathname, { method = "GET", bodyJson } = {}) {
  const accessToken = await getAccessToken();
  const headers = { Authorization: `Bearer ${accessToken}`, "x-api-key": API_KEY };
  let body;
  if (bodyJson !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(bodyJson);
  }

  const preferredApiBase = tokenCache?.tokenBaseUrl ? `${trimSlash(tokenCache.tokenBaseUrl)}/api` : null;
  const bases = preferredApiBase
    ? [preferredApiBase, ...candidateApiBases().filter((b) => b !== preferredApiBase)]
    : candidateApiBases();

  let lastErr;
  for (const b of bases) {
    try {
      return await httpJson(`${b}${pathname}`, { method, headers, body });
    } catch (e) {
      lastErr = e;
      const status = e?.status;
      if (status !== 404) break;
    }
  }
  throw lastErr || new Error("Request failed");
}

function getWebphoneSecrets() {
  const first = process.env.MIGHTYCALL_WEBPHONE_SECRET_KEY || "";
  const rest = String(process.env.MIGHTYCALL_WEBPHONE_SECRET_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const numbered = Array.from({ length: 10 })
    .map((_, i) => process.env[`MIGHTYCALL_WEBPHONE_SECRET_KEY_${i + 1}`])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const secrets = numbered.length > 0 ? numbered : [first, ...rest].filter(Boolean);
  return secrets.length > 0 ? secrets : [API_SECRET_KEY].filter(Boolean);
}

module.exports = {
  trimSlash,
  API_BASE_URL_RAW,
  API_KEY,
  candidateTokenBases,
  candidateApiBases,
  getAccessToken,
  mightycallRequest,
  getWebphoneSecrets,
  getTokenBaseUrl: () => tokenCache?.tokenBaseUrl || null,
};

