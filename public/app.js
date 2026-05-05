const $ = (id) => document.getElementById(id);

const windowRef = window;

const logEl = $("log");
const dialInputEl = $("dialInput");
const webphoneStateEl = $("webphoneState");
const activeLineInfoEl = $("activeLineInfo");

let webphoneScriptLoading = null;
let webphoneStarted = false;
let activeUserSlot = null;
let activeFromNumber = null;

function log(obj) {
  const ts = new Date().toISOString();
  const line = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  logEl.textContent = `[${ts}] ${line}\n\n` + logEl.textContent;
}

async function api(path, { method = "GET", body } = {}) {
  const headers = body ? { "Content-Type": "application/json" } : {};
  const appKey = $("appKey")?.value?.trim();
  if (appKey) headers["x-app-key"] = appKey;
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const message = json?.error || `HTTP ${res.status}`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }
  return json;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setupPad() {
  const keys = [
    ["1", ""],
    ["2", "ABC"],
    ["3", "DEF"],
    ["4", "GHI"],
    ["5", "JKL"],
    ["6", "MNO"],
    ["7", "PQRS"],
    ["8", "TUV"],
    ["9", "WXYZ"],
    ["*", ""],
    ["0", "+"],
    ["#", ""],
  ];
  const pad = $("pad");
  pad.innerHTML = "";
  for (const [d, s] of keys) {
    const el = document.createElement("div");
    el.className = "key";
    el.innerHTML = `<div class="d">${escapeHtml(d)}</div><div class="s">${escapeHtml(s)}</div>`;
    el.addEventListener("click", () => {
      dialInputEl.value = dialInputEl.value + d;
    });
    pad.appendChild(el);
  }
}

async function authTest() {
  try {
    const json = await api("/api/auth/test", { method: "POST" });
    log({ event: "auth_test", response: json });
  } catch (e) {
    log({ event: "auth_test_error", error: e.message || String(e) });
  }
}

$("btnAuthTest").addEventListener("click", authTest);

$("btnBackspace").addEventListener("click", () => {
  dialInputEl.value = dialInputEl.value.slice(0, -1);
});
$("btnClear").addEventListener("click", () => {
  dialInputEl.value = "";
});
setupPad();

function setWebphoneState(s) {
  webphoneStateEl.textContent = s || "";
}

function setActiveLineInfo() {
  const slot = activeUserSlot;
  const userLabel = slot === null ? "User: (not started)" : `User: ${slot + 1}`;
  const fromLabel = activeFromNumber ? `From: ${activeFromNumber}` : "From: (will show when call starts)";
  activeLineInfoEl.textContent = `${userLabel}  •  ${fromLabel}`;
}

function populateUserSlots(count) {
  const sel = $("agentSelect");
  sel.innerHTML = "";
  const n = Math.max(1, Number(count || 1));
  for (let i = 0; i < n; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `User ${i + 1}`;
    sel.appendChild(opt);
  }
  if (Number(sel.value) >= n) sel.value = "0";
}

async function loadUserSlots() {
  try {
    // This does NOT start WebPhone; it only discovers how many users are configured server-side.
    const cfg = await api("/api/webphone/config?agent=0");
    if (cfg?.ok) {
      populateUserSlots(cfg.agentCount || 1);
      setWebphoneState(`Ready. ${cfg.agentCount || 1} user slot(s) available.`);
      setActiveLineInfo();
    }
  } catch (e) {
    // Keep UI usable even if config is protected (APP_ACCESS_KEY) or temporarily failing.
    setWebphoneState("Ready.");
    setActiveLineInfo();
  }
}

function loadScriptOnce(src) {
  if (webphoneScriptLoading) return webphoneScriptLoading;
  webphoneScriptLoading = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => resolve(true);
    el.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(el);
  });
  return webphoneScriptLoading;
}

async function webphoneInit() {
  const agent = Number($("agentSelect").value || 0);
  setWebphoneState("Loading config…");
  const cfg = await api(`/api/webphone/config?agent=${encodeURIComponent(agent)}`);
  if (!cfg?.ok) throw new Error("Failed to get WebPhone config");

  setWebphoneState("Loading WebPhone SDK…");
  await loadScriptOnce(cfg.sdkScriptUrl);
  if (!windowRef.MightyCallWebPhone) throw new Error("WebPhone SDK did not attach MightyCallWebPhone");

  setWebphoneState("Applying config…");
  windowRef.MightyCallWebPhone.ApplyConfig(cfg.mcConfig);

  // Init inline in container
  setWebphoneState(`Starting browser phone for User ${agent + 1}… (you may be prompted for mic permission)`);
  windowRef.MightyCallWebPhone.Phone.Init("webphoneContainer");

  // Populate agent slots (1..N)
  populateUserSlots(cfg.agentCount || 1);
  $("agentSelect").value = String(cfg.agent || 0);

  activeUserSlot = agent;
  activeFromNumber = null;
  webphoneStarted = true;
  setWebphoneState(`Browser phone started for User ${agent + 1}. Dial above and press Call.`);
  setActiveLineInfo();

  // Subscribe to events to discover the actual "From" number being used.
  try {
    const onCallInfo = (callInfo) => {
      const from = callInfo?.From || callInfo?.from || callInfo?.BusinessNumber;
      if (from) activeFromNumber = String(from);
      setActiveLineInfo();
    };
    windowRef.MightyCallWebPhone.Phone.OnCallOutgoing?.subscribe?.(onCallInfo);
    windowRef.MightyCallWebPhone.Phone.OnCallStarted?.subscribe?.(onCallInfo);
  } catch {
    // ignore SDK differences
  }
  log({ event: "webphone_init", sdkScriptUrl: cfg.sdkScriptUrl, agent: cfg.agent, agentCount: cfg.agentCount });
}

function webphoneStatus() {
  if (!windowRef.MightyCallWebPhone) return log("WebPhone SDK not loaded yet.");
  const st = windowRef.MightyCallWebPhone.Phone.Status();
  setWebphoneState(`Status: ${st}`);
  log({ event: "webphone_status", status: st });
}

function webphoneCall() {
  if (!webphoneStarted || !windowRef.MightyCallWebPhone) {
    setWebphoneState("Click “Start browser phone” first.");
    return;
  }
  const currentSlot = Number($("agentSelect").value || 0);
  if (activeUserSlot !== null && currentSlot !== activeUserSlot) {
    setWebphoneState(`You switched to User ${currentSlot + 1}. Click “Start browser phone” again.`);
    webphoneStarted = false;
    return;
  }
  const to = dialInputEl.value.trim();
  if (!to) return log("Dial a destination number first.");
  windowRef.MightyCallWebPhone.Phone.Call(to);
  windowRef.MightyCallWebPhone.Phone.Focus();
  log({ event: "webphone_call", user: (activeUserSlot ?? currentSlot) + 1, to });
}

function webphoneHangup() {
  if (!windowRef.MightyCallWebPhone) return log("WebPhone SDK not loaded yet.");
  windowRef.MightyCallWebPhone.Phone.HangUp();
  log({ event: "webphone_hangup" });
}

$("btnWebPhoneInit").addEventListener("click", async () => {
  try {
    await webphoneInit();
  } catch (e) {
    setWebphoneState("");
    log({ event: "webphone_init_error", error: e.message || String(e) });
  }
});
$("btnWebPhoneStatus").addEventListener("click", webphoneStatus);
$("btnDialCall").addEventListener("click", webphoneCall);
$("btnDialHangup").addEventListener("click", webphoneHangup);

loadUserSlots();
setActiveLineInfo();

// If the user changes slot after starting, require re-start so credentials actually change.
$("agentSelect").addEventListener("change", () => {
  const slot = Number($("agentSelect").value || 0);
  if (activeUserSlot === null) {
    setWebphoneState(`Ready. Selected User ${slot + 1}. Click “Start browser phone”.`);
    return;
  }
  if (slot !== activeUserSlot) {
    webphoneStarted = false;
    setWebphoneState(`Switched to User ${slot + 1}. Click “Start browser phone” to apply.`);
  }
});

