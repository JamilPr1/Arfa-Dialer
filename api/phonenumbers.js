const mc = require("./_mc");

module.exports = async (_req, res) => {
  res.setHeader("Content-Type", "application/json");
  try {
    const json = await mc.mightycallRequest("/phonenumbers");
    res.statusCode = 200;
    res.end(JSON.stringify(json));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: e?.message || String(e), details: e?.details }));
  }
};

