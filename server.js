// server.js
// Minimal proxy for Retell/agents
// - /balance-clean: eSIMGo usage + friendly country/region
// - /balance: raw eSIMGo passthrough
// - /plans-by-destination: GlobalESIM coverage -> plans summary (form-encoded, PHP-friendly)
// CommonJS + Node 18+ (global fetch)

const express = require("express");

const app = express();
const PORT = process.env.PORT || 8787;

// ---- eSIMGo config ----
const ESIMGO_KEY = process.env.ESIMGO_KEY;               // REQUIRED
const ESIMGO_VER = process.env.ESIMGO_VER || "v2.5";     // e.g., "v2.4" if needed

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

// ---- Form helpers (for PHP endpoints) ----
function formBody(obj) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined && v !== null) params.append(k, String(v));
  }
  return params.toString();
}

async function postForm(url, data) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "*/*",
      "User-Agent": "esim-proxy/1.0"
    },
    body: formBody(data)
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
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

// GlobalESIM: coverage -> plans by destination (form-encoded; tolerant to Retell probes; fallback to .php)
app.all("/plans-by-destination", async (req, res) => {
  try {
    // Accept from body or query; default "Europe" for save/probes with no payload
    let destination =
      (req.body && req.body.destination) ||
      (req.query && req.query.destination) ||
      "Europe";

    destination = String(destination).trim();
    if (!destination) destination = "Europe";

    if (!GLOBALESIM_EMAIL || !GLOBALESIM_PASSWORD) {
      return res.status(500).json({ error: "config_error", detail: "GLOBALESIM_EMAIL/PASSWORD not set" });
    }

    // 1) Coverage lookup (form-encoded). Try /api/coverage, fallback to /api/coverage.php
    let cov = await postForm("https://globalesim.net/api/coverage", {
      email: GLOBALESIM_EMAIL,
      password: GLOBALESIM_PASSWORD
    });

    if (!cov.ok) {
      console.log(`[coverage] status=${cov.status} len=${cov.text.length}`);
      cov = await postForm("https://globalesim.net/api/coverage.php", {
        email: GLOBALESIM_EMAIL,
        password: GLOBALESIM_PASSWORD
      });
      if (!cov.ok) {
        return res.status(cov.status).type("application/json").send(cov.text);
      }
    }

    let covJson;
    try { covJson = JSON.parse(cov.text); } catch {
      return res.status(502).json({ error: "bad_coverage_payload", raw: cov.text.slice(0, 400) });
    }

    const list = Array.isArray(covJson?.Data) ? covJson.Data : [];
    const rec = pickCoverageRecord(destination, list);
    if (!rec) {
      return res.status(404).json({
        error: "not_found",
        detail: `No coverage match for "${destination}"`,
        suggestions: list.slice(0, 10).map(r => r.country)
      });
    }

    const label = rec.country;                         // "EU+" or "Spain"
    const iso2 = rec.iso2;                             // "EU" or "ES"
    const isRegion = String(rec.region || "").toLowerCase() === "yes";

    // 2) Plans lookup (form-encoded). Try /api/country-plans, fallback to .php
    let plans = await postForm("https://globalesim.net/api/country-plans", {
      email: GLOBALESIM_EMAIL,
      password: GLOBALESIM_PASSWORD,
      iso2_country: iso2
    });

    if (!plans.ok) {
      console.log(`[country-plans] status=${plans.status} len=${plans.text.length}`);
      plans = await postForm("https://globalesim.net/api/country-plans.php", {
        email: GLOBALESIM_EMAIL,
        password: GLOBALESIM_PASSWORD,
        iso2_country: iso2
      });
      if (!plans.ok) {
        return res.status(plans.status).type("application/json").send(plans.text);
      }
    }

    let plansJson;
    try { plansJson = JSON.parse(plans.text); } catch {
      return res.status(502).json({ error: "bad_plans_payload", raw: plans.text.slice(0, 400) });
    }

    const plansRaw = Array.isArray(plansJson?.Data) ? plansJson.Data : [];

    const normalized = plansRaw
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

    const top3Text = formatTopPlans(normalized, 3);

    const out = {
      label,
      iso2,
      isRegion,
      totalPlans: normalized.length,
      plans: normalized,
      top3Text
    };

    console.log(`[plans-by-destination] "${destination}" -> ${label}/${iso2} (plans=${normalized.length})`);
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
