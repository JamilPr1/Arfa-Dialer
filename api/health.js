const mc = require("./_mc");

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.statusCode = 200;
  res.end(
    JSON.stringify({
      ok: true,
      apiBaseUrl: mc.API_BASE_URL_RAW,
      tokenBaseCandidates: mc.candidateTokenBases(),
      apiBaseCandidates: mc.candidateApiBases(),
      tokenBaseUrl: mc.getTokenBaseUrl(),
    }),
  );
};

