// server.js
// Minimal eSIMgo proxy for Retell/agents: returns GB + friendly country name.

import express from "express";

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
  // Accept ICCID from body, query, or header (flexible for any client/agent)
  return String(
    (req.body && req.body.iccid) ||
    (req.query && req.query.iccid) ||
    req.headers["x-iccid"] ||
    ""
  ).trim();
}

// Country map (extend as you go)
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
  IL:"Israel",
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
  RU: "Rusia",
  REUP: "Europe"
  // add regions you sell most often
};

// Regions or marketing bundles
const REGION_CODES = {
  REUP: "Europe+",
  EURO: "Europe",
  APAC: "Asia Pacific",
  LATAM: "Latin America",
  MENA: "Middle East & North Africa",
  GLOBAL: "Global",
};

function extractRegionOrIso2(planName = "") {
  // First check for 4–5 letter region codes like REUP, APAC, LATAM
  const regionMatch = planName.match(/_([A-Z]{3,5})(?:_[Vv]\d+)?$/);
  if (regionMatch) {
    const code = regionMatch[1];
    if (REGION_CODES[code]) return { type: "region", code, label: REGION_CODES[code] };
  }

  // Otherwise check for ISO2 at the end
  const m1 = planName.match(/_([A-Z]{2})(?:_[Vv]\d+)?$/);
  if (m1) {
    const code = m1[1];
    if (ISO2_COUNTRIES[code]) return { type: "country", code, label: ISO2_COUNTRIES[code] };
  }

  return { type: "unknown", code: "", label: "" };
}

// ---- Routes ----
app.get("/health", (req, res) => res.json({ ok: true, ver: ESIMGO_VER }));

// Unified clean endpoint (supports GET with ?iccid=... or POST with { iccid })
// Returns: { planName, description, country, bundleState, validFrom, validUntil, initialGB, remainingGB }
app.all("/balance-clean", async (req, res) => {
  try {
    if (!ESIMGO_KEY) {
      return res.status(500).json({ error: "config_error", detail: "ESIMGO_KEY env var not set" });
    }

    const iccid = pickIccid(req);
    if (!iccid) return res.status(400).json({ error: "missing iccid" });

    const url = `https://api.esim-go.com/${ESIMGO_VER}/esims/${iccid}/bundles`;
    console.log(`[balance-clean] ${req.method} -> ${url}`);

    const r = await fetch(url, {
      headers: { "X-API-Key": ESIMGO_KEY, "Accept": "application/json" },
    });

    const text = await r.text();
    if (!r.ok) {
      console.log(`[balance-clean] esimgo status=${r.status} body=${text.slice(0, 200)}…`);
      return res.status(r.status).type("application/json").send(text);
    }

    const data = JSON.parse(text);
    const b = data?.bundles?.[0] || {};
    const a = b?.assignments?.[0] || {};

    const planName = a?.name || b?.name || "";
    const description = a?.description || b?.description || "";
    const regionOrCountry = extractRegionOrIso2(planName);
const country = regionOrCountry.label || "";  // will be "Europe+" for REUP

    // Bytes → GB, with allowances fallback
    const initialBytes   = a?.initialQuantity ?? a?.allowances?.[0]?.initialAmount ?? 0;
    const remainingBytes = a?.remainingQuantity ?? a?.allowances?.[0]?.remainingAmount ?? 0;

    // Country extraction (prefer plan name; fallback to description)
    const codeFromName = extractIso2FromName(planName);
    const codeFromDesc = codeFromName ? null : extractIso2FromDesc(description);
    const iso2 = (codeFromName || codeFromDesc || "").toUpperCase();
    const country = iso2ToCountry(iso2); // if not found, returns code or ""

    const out = {
      planName,
      description,
      country, // human-friendly name when possible
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

// Optional: raw passthrough if you ever need full JSON
app.all("/balance", async (req, res) => {
  try {
    if (!ESIMGO_KEY) {
      return res.status(500).json({ error: "config_error", detail: "ESIMGO_KEY env var not set" });
    }

    const iccid = pickIccid(req);
    if (!iccid) return res.status(400).json({ error: "missing iccid" });

    const url = `https://api.esim-go.com/${ESIMGO_VER}/esims/${iccid}/bundles`;
    console.log(`[balance] ${req.method} -> ${url}`);

    const r = await fetch(url, {
      headers: { "X-API-Key": ESIMGO_KEY, "Accept": "application/json" },
    });

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
