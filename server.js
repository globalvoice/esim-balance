// server.js
// Minimal proxy for Retell/agents
// - /balance-clean: eSIMGo usage + friendly country/region
// - /plans-by-destination: GlobalESIM coverage -> plans summary
// - /balance: raw eSIMGo passthrough
// CommonJS + Node 18+ (global fetch)

const express = require("express");

const app = express();
const PORT = process.env.PORT || 8787;

// ---- eSIMGo config ----
const ESIMGO_KEY = process.env.ESIMGO_KEY;               // REQUIRED
const ESIMGO_VER = process.env.ESIMGO_VER || "v2.5";

// ---- GlobalESIM config ----
const GLOBALESIM_EMAIL = process.env.GLOBALESIM_EMAIL || "";
const GLOBALESIM_PASSWORD = process.env.GLOBALESIM_PASSWORD || "";

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

// ---- Region & Country Maps (for planName parsing) ----
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
  // extend as needed
};

const REGION_CODES = {
  REUP: "Europe+",
  EURO: "Europe",
  APAC: "Asia Pacific",
  LATAM: "Latin America",
  MENA: "Middle East & North Africa",
  GLOBAL: "Global",
};

// Prefer region code; else ISO2 code; else empty label
function extractRegionOrIso2Label(planName = "", description = "") {
  // 1) Region code at end: _REUP[_V2]
  const regionMatch = planName.match(/_([A-Z]{3,5})(?:_[Vv]\d+)?$/);
  if (regionMatch && REGION_CODES[regionMatch[1]]) return REGION_CODES[regionMatch[1]];

  // 2) ISO2 at end: _GR[_V2]
  const isoMatch = planName.match(/_([A-Z]{2})(?:_[Vv]\d+)?$/);
  if (isoMatch && ISO2_COUNTRIES[isoMatch[1]]) return ISO2_COUNTRIES[isoMatch[1]];

  // 3) Very loose ISO2 sniff in description
  const descIso = description.match(/(?:^|[^A-Z])([A-Z]{2})(?:[^A-Z]|$)/);
  if (descIso && ISO2_COUNTRIES[descIso[1]]) return ISO2_COUNTRIES[descIso[1]];

  return "";
}

// ---- Destination helpers (GlobalESIM) ----
function normalizeDestination(s = "") {
  return String(s).trim().toLowerCase().replace(/\s+/g, " ");
}

// Try to pick a coverage record given user phrase and the API list
function pickCoverageRecord(dest, coverageList = []) {
  const want = normalizeDestination(dest);

  // 1) exact match on country
  let rec = coverageList.find(r => normalizeDestination(r.country) === want);
  if (rec) return rec;

  // 2) common variants for Europe
  const variants = new Set([want]);
  if (want === "europe") variants.add("eu+"), variants.add("eu");
  if (want === "eu") variants.add("eu+"), variants.add("europe");
  if (want === "eu+") variants.add("europe"), variants.add("eu");

  for (const v of variants) {
    rec = coverageList.find(r => normalizeDestination(r.country) === v);
    if (rec) return rec;
  }

  // 3) substring fallback (e.g., “spai” -> “Spain”)
  rec = coverageList.find(r => normalizeDestination(r.country).includes(want));
  if (rec) return rec;

  // 4) allow direct ISO2 (e.g., “ES”)
  rec = coverageList.find(r => normalizeDestination(r.iso2) === want);
  if (rec) return rec;

  return null;
}

function formatTopPlans(plans = [], limit = 5) {
  const top = plans.slice(0, limit);
  return top
    .map(p => `${Number(p.GBs)} GB / ${Number(p.Validity_Days)} days — $${Number(p.retailRate)}`)
    .join("; ");
}

// ---- Routes ----
app.get("/health", (req, res) => res.json({ ok: true, ver: ESIMGO_VER }));

// eSIMGo: processed usage
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
    const label = extractRegionOrIso2Label(planName, description); // country/region

    const initialBytes   = a?.initialQuantity ?? a?.allowances?.[0]?.initialAmount ?? 0;
    const remainingBytes = a?.remainingQuantity ?? a?.allowances?.[0]?.remainingAmount ?? 0;

    const out = {
      planName,
      description,
      country: label, // human-friendly country/region
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

// eSIMGo: raw passthrough
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

// GlobalESIM: coverage -> plans by destination
// Body: { "destination": "Europe" } or { "destination": "Spain" }
app.post("/plans-by-destination", async (req, res) => {
  try {
    const destination = String(req.body?.destination || "").trim();
    if (!destination) return res.status(400).json({ error: "missing destination" });

    if (!GLOBALESIM_EMAIL || !GLOBALESIM_PASSWORD) {
      return res.status(500).json({ error: "config_error", detail: "GLOBALESIM_EMAIL/PASSWORD not set" });
    }

    // 1) Coverage lookup
    const covResp = await fetch("https://globalesim.net/api/coverage", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        email: GLOBALESIM_EMAIL,
        password: GLOBALESIM_PASSWORD
      })
    });
    const covText = await covResp.text();
    if (!covResp.ok) return res.status(covResp.status).type("application/json").send(covText);

    const covJson = JSON.parse(covText);
    const list = Array.isArray(covJson?.Data) ? covJson.Data : [];

    const rec = pickCoverageRecord(destination, list);
    if (!rec) {
      return res.status(404).json({
        error: "not_found",
        detail: `No coverage match for "${destination}"`,
        suggestions: list.slice(0, 10).map(r => r.country)
      });
    }

    // rec example: { id, country, iso2, region: "Yes"/"No" }
    const label = rec.country;                   // "EU+" or "Spain"
    const iso2 = rec.iso2;                       // "EU" or "ES"
    const isRegion = String(rec.region || "").toLowerCase() === "yes";

    // 2) Plans lookup
    const plansResp = await fetch("https://globalesim.net/api/country-plans", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        email: GLOBALESIM_EMAIL,
        password: GLOBALESIM_PASSWORD,
        iso2_country: iso2
      })
    });
    const plansText = await plansResp.text();
    if (!plansResp.ok) return res.status(plansResp.status).type("application/json").send(plansText);

    const plansJson = JSON.parse(plansText);
    const plansRaw = Array.isArray(plansJson?.Data) ? plansJson.Data : [];

    const plans = plansRaw
      .map(p => ({
        brandId: p.brandId,
        planId: p.planId,
        GBs: Number(p.GBs),
        Validity_Days: Number(p.Validity_Days),
        retailRate: Number(p.retailRate),
        dealerRate: Number(p.dealerRate ?? 0),
        usku: p.usku,
        description: p.Description
      }))
      .sort((a, b) => a.GBs - b.GBs || a.Validity_Days - b.Validity_Days || a.retailRate - b.retailRate);

    const top3Text = formatTopPlans(plans, 3);

    const out = {
      label,       // "EU+" or "Spain"
      iso2,        // "EU" or "ES"
      isRegion,    // true/false
      totalPlans: plans.length,
      plans,       // normalized list
      top3Text     // speech-ready summary (up to 3)
    };

    console.log(`[plans-by-destination] "${destination}" -> ${label}/${iso2} (plans=${plans.length})`);
    return res.json(out);
  } catch (e) {
    console.error("[plans-by-destination] ERROR", e);
    return res.status(500).json({ error: "proxy_error", detail: String(e) });
  }
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
  if (!ESIMGO_KEY) console.warn("[WARN] ESIMGO_KEY is not set");
  if (!GLOBALESIM_EMAIL || !GLOBALESIM_PASSWORD) {
    console.warn("[WARN] GLOBALESIM_EMAIL/PASSWORD not set (plans-by-destination will fail)");
  }
});
