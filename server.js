import express from "express";

const app = express();
const PORT = process.env.PORT || 8787;
const ESIMGO_KEY = process.env.ESIMGO_KEY;
const ESIMGO_VER = process.env.ESIMGO_VER || "v2.5";

if (!ESIMGO_KEY) {
  console.warn("[WARN] ESIMGO_KEY env var is not set");
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/balance", async (req, res) => {
  try {
    const iccid = String(req.query.iccid || "").trim();
    if (!iccid) return res.status(400).json({ error: "missing iccid" });

    const url = `https://api.esim-go.com/${ESIMGO_VER}/esims/${iccid}/bundles`;
    console.log(`[balance] GET ${url}`);

    const r = await fetch(url, {
      headers: { "X-API-Key": ESIMGO_KEY, "Accept": "application/json" }
    });

    const text = await r.text();
    console.log(`[balance] esimgo status=${r.status} len=${text.length}`);

    res.status(r.status).type("application/json").send(text);
  } catch (e) {
    console.error("[balance] ERROR", e);
    res.status(500).json({ error: "proxy_error", detail: String(e) });
  }
});

app.get("/balance-clean", async (req, res) => {
  try {
    const iccid = String(req.query.iccid || "").trim();
    if (!iccid) return res.status(400).json({ error: "missing iccid" });

    const url = `https://api.esim-go.com/${ESIMGO_VER}/esims/${iccid}/bundles`;
    console.log(`[balance-clean] GET ${url}`);

    const r = await fetch(url, {
      headers: { "X-API-Key": ESIMGO_KEY, "Accept": "application/json" }
    });

    const text = await r.text();
    if (!r.ok) {
      console.log(`[balance-clean] esimgo status=${r.status} body=${text.slice(0,200)}…`);
      return res.status(r.status).type("application/json").send(text);
    }

    const body = JSON.parse(text);
    const b = body?.bundles?.[0] || {};
    const a = b?.assignments?.[0] || {};
    const initialBytes   = a?.initialQuantity ?? a?.allowances?.[0]?.initialAmount ?? 0;
    const remainingBytes = a?.remainingQuantity ?? a?.allowances?.[0]?.remainingAmount ?? 0;

    const toGB = n => Number((n / 1_000_000_000).toFixed(2));

    const out = {
      planName: a?.name || b?.name || "",
      description: a?.description || b?.description || "",
      bundleState: String(a?.bundleState || "").toLowerCase(),
      validFrom: a?.startTime || a?.assignmentDateTime || "",
      validUntil: a?.endTime || "",
      initialGB: toGB(initialBytes),
      remainingGB: toGB(remainingBytes)
    };

    console.log(`[balance-clean] ok -> ${JSON.stringify(out)}`);
    res.json(out);
  } catch (e) {
    console.error("[balance-clean] ERROR", e);
    res.status(500).json({ error: "proxy_error", detail: String(e) });
  }
});

app.listen(PORT, () => console.log(`listening on :${PORT}`));
