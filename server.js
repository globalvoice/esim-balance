// Simple eSIMgo proxy for Retell / agents
import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8787;
const ESIMGO_KEY = process.env.ESIMGO_KEY;
const ESIMGO_VER = process.env.ESIMGO_VER || "v2.5"; // set to v2.4 if needed

if (!ESIMGO_KEY) {
  console.warn("WARNING: ESIMGO_KEY env var is not set.");
}

app.get("/health", (req, res) => res.json({ ok: true }));

// Pass-through: returns eSIMgo JSON as-is
app.get("/balance", async (req, res) => {
  try {
    const iccid = String(req.query.iccid || "").trim();
    if (!iccid) return res.status(400).json({ error: "missing iccid" });

    const url = `https://api.esim-go.com/${ESIMGO_VER}/esims/${iccid}/bundles`;
    const r = await fetch(url, { headers: { "X-API-Key": ESIMGO_KEY, "Accept": "application/json" }});
    const txt = await r.text();
    res.status(r.status).type("application/json").send(txt);
  } catch (e) {
    res.status(500).json({ error: "proxy_error", detail: String(e) });
  }
});

// Clean output: converts bytes -> GB and returns a small JSON
app.get("/balance-clean", async (req, res) => {
  try {
    const iccid = String(req.query.iccid || "").trim();
    if (!iccid) return res.status(400).json({ error: "missing iccid" });

    const url = `https://api.esim-go.com/${ESIMGO_VER}/esims/${iccid}/bundles`;
    const r = await fetch(url, { headers: { "X-API-Key": ESIMGO_KEY, "Accept": "application/json" }});
    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).type("application/json").send(txt);
    }
    const body = await r.json();

    const b = body?.bundles?.[0] || {};
    const a = b?.assignments?.[0] || {};
    const initialBytes = a?.initialQuantity ?? a?.allowances?.[0]?.initialAmount ?? 0;
    const remainingBytes = a?.remainingQuantity ?? a?.allowances?.[0]?.remainingAmount ?? 0;

    const toGB = (n) => Number((n / 1_000_000_000).toFixed(2));

    res.json({
      planName: a?.name || b?.name || "",
      description: a?.description || b?.description || "",
      bundleState: String(a?.bundleState || "").toLowerCase(),
      validFrom: a?.startTime || a?.assignmentDateTime || "",
      validUntil: a?.endTime || "",
      initialGB: toGB(initialBytes),
      remainingGB: toGB(remainingBytes)
    });
  } catch (e) {
    res.status(500).json({ error: "proxy_error", detail: String(e) });
  }
});

app.listen(PORT, () => console.log(`listening on :${PORT}`));
