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
  // add regions you sell most often
};

function extractIso2FromName(name = "") {
  // Prefer a trailing _XX or _XX_V2 pattern (e.g., esims_10GB_30D_GR_V2)
  const m1 = name.match(/_([A-Z]{2})(?:_[Vv]\d+)?$/);
  if (m1) return m1[1];
  // Fallback: first _XX occurrence
  const m2 = name.match(/_([A-Z]{2})(?:_|$)/);
  return m2 ? m2[1] : null;
}

function extractIso2FromDesc(desc = "") {
  // Very loose: find any isolated 2-letter uppercase token
  const m = desc.match(/(?:^|[^A-Z])([A-Z]{2})(?:[^A-Z]|$)/);
  return m ? m[1] : null;
}

function iso2ToCountry(iso2) {
  return iso2 ? (ISO2_COUNTRIES[iso2] || iso2) : "";
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
