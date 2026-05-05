const mc = require("../_mc");

module.exports = async (_req, res) => {
  res.setHeader("Content-Type", "application/json");
  try {
    const token = await mc.getAccessToken();
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, tokenPreview: `${String(token).slice(0, 12)}...` }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: e?.message || String(e), details: e?.details }));
  }
};

