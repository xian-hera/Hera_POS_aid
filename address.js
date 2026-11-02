// Unit number check for online orders (Shopify Flow → /api/address/check)
// ─────────────────────────────────────────────────────────────────────────────
// Flow ("Order created", orders not from POS) sends the shipping address here. We answer whether
// the order needs a human look, and Flow adds the order tag itself (so the app needs no extra
// Shopify permission):
//
//   needsReview = true  when the address has no unit number AND Canada Post AddressComplete says the
//                       civic address is a building with several units (apartments, condos, offices)
//
// A unit counts as given when address line 2 is not empty, or line 1 contains "12-345 …",
// "#12", "apt / app / unit / suite / ste / bureau / logement / log 12" or similar.
//
// AddressComplete (Canada Post) Interactive Find: a multi-unit building comes back as a container
// ("Next": "Find", description like "24 Addresses") or as a list of "12-345 Street" addresses.
// Key: CANADAPOST_AC_KEY (Render). Results are cached 7 days per address to save lookups.
// Flow authenticates with header X-Address-Key: ADDRESS_CHECK_KEY (Render, 24+ characters).

import fetch from "node-fetch";

const FIND_URL = "https://ws1.postescanada-canadapost.ca/AddressComplete/Interactive/Find/v2.10/json3.ws";
const CACHE_MS = 7 * 24 * 60 * 60 * 1000;

const UNIT_WORDS = /(^|[\s,])(#\s*\w+|(apt|apartment|app|appartement|unit|unité|unite|suite|ste|bureau|bur|logement|log|room|rm|porte|penthouse|ph)\.?\s*#?\s*\w*\d\w*)/i;
const UNIT_DASH_CIVIC = /^\s*([a-z]?\d+[a-z]?|[a-z])\s*[-–]\s*\d+/i; // "12-345 Main St", "A-345 …", "12 - 345 …"
const CIVIC = /^\s*(\d+)\s*([a-z](?![a-z]))?/i;                        // "345 Main", "345A Main"

/** Does the address already carry a unit? */
export function unitGiven(address1, address2) {
  if (String(address2 ?? "").trim()) return { given: true, how: "address line 2" };
  const a1 = String(address1 ?? "");
  if (UNIT_DASH_CIVIC.test(a1)) return { given: true, how: "unit-civic in line 1" };
  if (UNIT_WORDS.test(a1)) return { given: true, how: "unit word in line 1" };
  return { given: false };
}

/** Civic number of line 1 ("345A Main St" → "345") */
export function civicOf(address1) {
  const m = String(address1 ?? "").match(CIVIC);
  return m ? m[1] : "";
}

const norm = (s) => String(s ?? "").toUpperCase().replace(/\s+/g, " ").trim();

/**
 * Reads AddressComplete Find results for one civic address.
 * multiUnit: a container for this civic number with several addresses, or 2+ unit addresses on it.
 */
export function readFindItems(items, civic) {
  const onCivic = (text) => new RegExp(`(^|[-–\\s])${civic}(?!\\d)`).test(String(text ?? ""));
  let units = 0;
  let container = null;
  for (const it of items || []) {
    if (!onCivic(it.Text)) continue;
    const count = Number((String(it.Description ?? "").match(/(\d+)\s+(addresses|adresses)/i) || [])[1] || 0);
    if (it.Next === "Find" && count >= 2 && new RegExp(`^\\s*${civic}(?!\\d)`).test(String(it.Text))) {
      container = { id: it.Id, text: it.Text, count };
    }
    if (it.Next === "Retrieve" && new RegExp(`^\\s*\\w+\\s*[-–]\\s*${civic}(?!\\d)`).test(String(it.Text))) units++;
  }
  if (container) return { multiUnit: true, units: container.count, container };
  if (units >= 2) return { multiUnit: true, units };
  return { multiUnit: false, units };
}

export function registerAddressCheck(app, { rateLimit, safeEqual }) {
  const FLOW_KEY = process.env.ADDRESS_CHECK_KEY || "";
  const AC_KEY = process.env.CANADAPOST_AC_KEY || "";
  if (FLOW_KEY.length < 24) console.warn("[address] ADDRESS_CHECK_KEY is missing or shorter than 24 characters: /api/address/check is disabled");
  if (!AC_KEY) console.warn("[address] CANADAPOST_AC_KEY is missing: unit checks are disabled");

  const cache = new Map(); // normalized address → { at, value }

  async function find(searchTerm, lastId) {
    const url = new URL(FIND_URL);
    url.searchParams.set("Key", AC_KEY);
    url.searchParams.set("SearchTerm", searchTerm);
    url.searchParams.set("Country", "CAN");
    url.searchParams.set("LanguagePreference", "en");
    url.searchParams.set("MaxSuggestions", "10");
    if (lastId) url.searchParams.set("LastId", lastId);
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`AddressComplete HTTP ${resp.status}`);
    const data = await resp.json();
    const items = Array.isArray(data) ? data : data.Items || [];
    const err = items.find((i) => i.Error !== undefined);
    if (err) throw new Error(`AddressComplete error ${err.Error}: ${err.Description || ""}`);
    return items;
  }

  async function multiUnitCheck({ address1, city, province, zip }) {
    const civic = civicOf(address1);
    if (!civic) return { multiUnit: false, note: "no civic number" };
    const term = [address1, city, province, zip].map((s) => String(s ?? "").trim()).filter(Boolean).join(", ");
    const key = norm(term);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.value, cached: true };
    const items = await find(term);
    const value = { ...readFindItems(items, civic), civic };
    if (value.container) delete value.container.id; // keep the answer small
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    return value;
  }

  // Flow → "Send HTTP request" (POST, header X-Address-Key). Always answers 200 with JSON so Flow can
  // read it; `status` says what happened, `needsReview` is what the workflow checks.
  app.post("/api/address/check", rateLimit({ windowMs: 60 * 1000, max: 120 }), async (req, res) => {
    if (FLOW_KEY.length < 24) return res.status(503).json({ error: "ADDRESS_CHECK_KEY is not configured" });
    if (!safeEqual(String(req.headers["x-address-key"] || ""), FLOW_KEY)) {
      console.warn(`[address] rejected: bad key from ${req.ip}`);
      return res.status(401).json({ error: "Unauthorized" });
    }
    const b = req.body || {};
    const order = String(b.order ?? "").slice(0, 40);
    const country = String(b.countryCode ?? b.country ?? "").trim().toUpperCase();
    const answer = (status, extra = {}) => {
      const out = { needsReview: status === "unit-missing", status, ...extra };
      console.log(`[address] ${order || "order ?"}: ${status}${extra.units ? ` (${extra.units} units)` : ""}${extra.how ? ` (${extra.how})` : ""}${extra.error ? ` – ${extra.error}` : ""}`);
      return res.json(out);
    };

    if (!String(b.address1 ?? "").trim()) return answer("skipped", { reason: "no shipping address" });
    if (country && !["CA", "CAN", "CANADA"].includes(country)) return answer("skipped", { reason: "not in Canada" });
    const given = unitGiven(b.address1, b.address2);
    if (given.given) return answer("unit-given", { how: given.how });
    if (!AC_KEY) return answer("error", { error: "CANADAPOST_AC_KEY is not configured" });

    try {
      const r = await multiUnitCheck({ address1: b.address1, city: b.city, province: b.province, zip: b.zip });
      if (r.multiUnit) return answer("unit-missing", { units: r.units || undefined, building: r.container?.text });
      return answer("single-unit", { note: r.note });
    } catch (err) {
      return answer("error", { error: err.message.slice(0, 200) });
    }
  });
}
