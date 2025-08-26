// server.js
// Minimal eSIMgo proxy for Retell/agents: returns GB + friendly country/region label.

const express = require("express");

const app = express();
const PORT = process.env.PORT || 8787;
const ESIMGO_KEY = process.env.ESIMGO_KEY;               // REQUIRED
const ESIMGO_VER = process.env.ESIMGO_VER || "v2.5";     // set to v2.4 if your tenant needs it

// ---- Basic hardening / JSON ----
app.disable("x-powered-by");
app.use(express.json());

// ---- Utilities ----
const toGB = (n) => Number((Number(n || 0) / 1_000_000_000).toFixed(2));

function pickIccid(req) {
  return String(
    (req.body && req.body.iccid) ||
    (req.query && req.query.iccid) ||
    req.headers["x-iccid"] ||
    ""
  ).trim();
}

// ---- Region & Country Maps ----
const ISO2_COUNTRIES = {
  US: "United States",
  GB: "United Kingdom",
  GR: "Greece",
  FR: "France",
  ES: "Spain",
  IT: "Italy",
  DE: "Germany",
  NL: "Netherlands",
  PT: "Portugal",
  IE: "Ireland",
  IL: "Israel",
  BE: "Belgium",
  AT: "Austria",
  CH: "Switzerland",
  SE: "Sweden",
  NO: "Norway",
  DK: "Denmark",
  FI: "Finland",
  CZ: "Czechia",
  PL: "Poland",
  RO: "Romania",
  HU: "Hungary",
  SK: "Slovakia",
  BG: "Bulgaria",
  HR: "Croatia",
  SI: "Slovenia",
  EE: "Estonia",
  LV: "Latvia",
  LT: "Lithuania",
  MX: "Mexico",
  RU: "Russia",
};

const REGION_CODES = {
  REUP: "Europe+",
  EURO: "Europe",
  APAC: "Asia Pacific",
  LATAM: "Latin America",
  MENA: "Middle East & North Africa",
  GLOBAL: "Global",
};

function extractRegionOrIso2Label(planName = "", description = "") {
  const regionMatch = planName.match(/_([A-Z]{3,5})(?:_[Vv]\d+)?$/);
  if (regionMatch && REGION_CODES[regionMatch[1]]) return REGION_CODES[regionMatch[1]];

  const isoMatch = planName.match(/_([A-Z]{2})(?:_[Vv]\d+)?$/);
  if (isoMatch && ISO2_COUNTRIES[isoMatch[1]]) return ISO2_COUNTRIES[isoMatch[1]];

  const descIso = description.match(/(?:^|[^A-Z])([A-Z]{2})(?:[^A-Z]|$)/);
  if (descIso && ISO2_COUNTRIES[descIso[1]]) return ISO2_COUNTRIES[descIso[1]];

  return "";
}

// ---- Routes ----
app.get("/health", (req, res) => res.json({ ok: true, ver: ESIMGO_VER }));

app.all("/balance-clean", async (req, res) => {
  try {
    if (!ESIMGO_KEY) return res.status(500).json({ error: "config_error", detail: "ESIMGO_KEY not set" });

    const iccid = pickIccid(req);
    if (!iccid) return res.status(400).json({ error: "missing iccid" });

    const url = `https://api.esim-go.com/${ESIMGO_VER}/esims/${iccid}/bundles`;
    console.log(`[balance-clean] -> ${url}`);

    const r = await fetch(url, { headers: { "X-API-Key": ESIMGO_KEY, "Accept": "application/json" } });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).type("application/json").send(text);

    const data = JSON.parse(text);
    const b = data?.bundles?.[0] || {};
    const a = b?.assignments?.[0] || {};

    const planName = a?.name || b?.name || "";
    const description = a?.description || b?.description || "";
    const label = extractRegionOrIso2Label(planName, description);

    const initialBytes   = a?.initialQuantity ?? a?.allowances?.[0]?.initialAmount ?? 0;
    const remainingBytes = a?.remainingQuantity ?? a?.allowances?.[0]?.remainingAmount ?? 0;

    const out = {
      planName,
      description,
      country: label,
      bundleState: String(a?.bundleState || "").toLowerCase(),
      validFrom: a?.startTime || a?.assignmentDateTime || "",
      validUntil: a?.endTime || "",
      initialGB: toGB(initialBytes),
      remainingGB: toGB(remainingBytes),
    };

    console.log(`[balance-clean] ok -> ${JSON.stringify(out)}`);
    res.json(out);
  } catch (e) {
    console.error("[balance-clean] ERROR", e);
    res.status(500).json({ error: "proxy_error", detail: String(e) });
  }
});

app.all("/balance", async (req, res) => {
  try {
    if (!ESIMGO_KEY) return res.status(500).json({ error: "config_error", detail: "ESIMGO_KEY not set" });

    const iccid = pickIccid(req);
    if (!iccid) return res.status(400).json({ error: "missing iccid" });

    const url = `https://api.esim-go.com/${ESIMGO_VER}/esims/${iccid}/bundles`;
    console.log(`[balance] -> ${url}`);

    const r = await fetch(url, { headers: { "X-API-Key": ESIMGO_KEY, "Accept": "application/json" } });
    const text = await r.text();
    res.status(r.status).type("application/json").send(text);
  } catch (e) {
    console.error("[balance] ERROR", e);
    res.status(500).json({ error: "proxy_error", detail: String(e) });
  }
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
  if (!ESIMGO_KEY) console.warn("[WARN] ESIMGO_KEY is not set");
});
