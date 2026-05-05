const mc = require("../_mc");

function requireAppKey(req) {
  const expected = process.env.APP_ACCESS_KEY || "";
  if (!expected) return true;
  const got = String(req.headers["x-app-key"] || "");
  return got && got === expected;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (!requireAppKey(req)) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const agent = Number(url.searchParams.get("agent") || 0);

  try {
    await mc.getAccessToken();
    const tokenBaseUrl = mc.getTokenBaseUrl() || mc.candidateTokenBases()[0];
    const sdkScriptUrl = `${mc.trimSlash(tokenBaseUrl)}/sdk/mightycall.webphone.sdk.js`;

    const secrets = mc.getWebphoneSecrets();
    const safeAgent = Math.max(0, Math.min(secrets.length - 1, agent));
    const password = secrets[safeAgent];

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        ok: true,
        sdkScriptUrl,
        mcConfig: { login: mc.API_KEY, password },
        agentCount: secrets.length,
        agent: safeAgent,
      }),
    );
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: e?.message || String(e), details: e?.details }));
  }
};

