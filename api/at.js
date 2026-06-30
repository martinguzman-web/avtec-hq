const BASE = "appse83xW0hUu10rB";
module.exports = async function handler(req, res) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) return res.status(500).json({ error: "Missing AIRTABLE_TOKEN env var" });
  const b = req.method === "POST" ? (req.body || {}) : (req.query || {});
  const { action, table, recordId, fields } = b;
  const H = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  try {
    if (action === "list") {
      const r = await fetch("https://api.airtable.com/v0/" + BASE + "/" + table + "?pageSize=100", { headers: H });
      return res.status(r.status).json(await r.json());
    }
    if (action === "update") {
      const r = await fetch("https://api.airtable.com/v0/" + BASE + "/" + table + "/" + recordId, { method: "PATCH", headers: H, body: JSON.stringify({ fields }) });
      return res.status(r.status).json(await r.json());
    }
    return res.status(400).json({ error: "bad action" });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
