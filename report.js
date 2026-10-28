// Restock report: password-protected web page for head office
// ─────────────────────────────────────────────────────────────────────────────
//   https://search-0wf4.onrender.com/report
//
// Reads every `restock_request` metaobject (pending, notified, cancelled) with the customer's name and
// contact, plus the current stock of the products still waited for. All grouping and filtering is done
// in the browser (report/index.html), so the server only has one data endpoint.
//
// REPORT_PASSWORD (Render, 10+ characters) turns the page on. Signing in sets a 12-hour cookie;
// changing REPORT_PASSWORD signs everybody out.

import crypto from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(__dirname, "report", "index.html"), "utf8");
const LOGIN_PAGE = readFileSync(join(__dirname, "report", "login.html"), "utf8");

const COOKIE = "hera_report";
const SESSION_SECONDS = 12 * 60 * 60;
const CACHE_MS = 2 * 60 * 1000;
const TYPE = "restock_request";

const REPORT_QUERY = `
  query RestockReport($after: String) {
    metaobjects(type: "${TYPE}", first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        fields { key value }
        customer: field(key: "customer") {
          reference { ... on Customer { displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } } }
        }
        variant: field(key: "variant") {
          reference { ... on ProductVariant { product { vendor productType } } }
        }
      }
    }
  }
`;

const LOCATIONS_QUERY = `
  query RestockReportLocations {
    locations(first: 100, includeInactive: true) {
      nodes { id name isActive displayName: metafield(namespace: "custom", key: "display_name") { value } }
    }
  }
`;

const idOf = (g) => String(g || "").split("/").pop();
const nowSeconds = () => Math.floor(Date.now() / 1000);

function displayNameOf(raw) {
  // tolerate a list-type metafield (["Chambly | Longueuil"])
  const v = String(raw ?? "").trim();
  if (v.startsWith("[")) {
    try { return String(JSON.parse(v)[0] ?? "").trim(); } catch { /* plain text */ }
  }
  return v;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function registerReport(app, { graphql, rateLimit, safeEqual, restock }) {
  const PASSWORD = process.env.REPORT_PASSWORD || "";
  const ENABLED = PASSWORD.length >= 10;
  if (!ENABLED) console.warn("[report] disabled: set REPORT_PASSWORD (10+ characters) on Render");

  // Key for the session cookie: changes when the password changes
  const sessionKey = crypto.createHash("sha256")
    .update(`hera-report|${PASSWORD}|${process.env.SHOPIFY_API_SECRET || ""}`)
    .digest();
  const sign = (exp) => crypto.createHmac("sha256", sessionKey).update(`report|${exp}`).digest("base64url");

  function isSignedIn(req) {
    if (!ENABLED) return false;
    const raw = parseCookies(req.headers.cookie)[COOKIE] || "";
    const [exp, sig] = raw.split(".");
    if (!/^\d{10}$/.test(exp || "") || Number(exp) < nowSeconds()) return false;
    return safeEqual(sign(exp), sig || "");
  }

  function setSecurityHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    );
  }

  // ── Pages ──

  app.get("/report", (req, res) => {
    setSecurityHeaders(res);
    res.type("html");
    if (!ENABLED) return res.status(503).send("The report is not set up (REPORT_PASSWORD is missing on the server).");
    return res.send(isSignedIn(req) ? PAGE : LOGIN_PAGE);
  });

  // Wrong passwords: per IP, and at most 20 per hour for the whole shop
  let loginFails = [];
  app.post("/report/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), (req, res) => {
    setSecurityHeaders(res);
    if (!ENABLED) return res.status(503).json({ error: "The report is not set up" });
    const now = Date.now();
    loginFails = loginFails.filter((t) => now - t < 60 * 60 * 1000);
    if (loginFails.length >= 20) {
      console.warn("[report] sign-in locked: 20 wrong passwords in the last hour");
      return res.status(429).json({ error: "Too many wrong passwords. Try again in an hour." });
    }
    if (!safeEqual(String(req.body?.password ?? ""), PASSWORD)) {
      loginFails.push(now);
      console.warn(`[report] wrong password from ${req.ip} (${loginFails.length} in the last hour)`);
      return res.status(401).json({ error: "Wrong password" });
    }
    const exp = String(nowSeconds() + SESSION_SECONDS);
    res.setHeader("Set-Cookie", `${COOKIE}=${exp}.${sign(exp)}; Path=/report; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`);
    console.log(`[report] signed in from ${req.ip}`);
    return res.json({ ok: true });
  });

  app.post("/report/logout", (req, res) => {
    setSecurityHeaders(res);
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/report; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
    return res.json({ ok: true });
  });

  // ── Data ──

  let cache = null; // { at, value }
  let loading = null;

  async function loadAll() {
    const records = [];
    let after = null;
    for (let page = 0; page < 300; page++) {
      const data = await graphql(REPORT_QUERY, { after });
      const conn = data.metaobjects;
      for (const n of conn?.nodes || []) {
        const f = Object.fromEntries((n.fields || []).map((x) => [x.key, x.value]));
        const c = n.customer?.reference;
        const p = n.variant?.reference?.product;
        records.push({
          status: f.status || "",
          locationId: f.location_id || "",
          store: f.location_code || "",
          sku: f.sku || "",
          variantId: f.variant_id || "",
          product: f.product_title || "",
          variant: f.variant_title || "",
          vendor: p?.vendor || "",
          productType: p?.productType || "",
          channel: f.channel || "",
          notifiedChannel: f.notified_channel || "",
          requestedAt: f.requested_at || "",
          notifiedAt: f.notified_at || "",
          availableAtNotify: f.available_at_notify == null ? null : Number(f.available_at_notify),
          customerId: f.customer_id || "",
          customerName: c?.displayName || (f.customer_id ? `Customer ${f.customer_id}` : ""),
          email: c?.defaultEmailAddress?.emailAddress || "",
          phone: c?.defaultPhoneNumber?.phoneNumber || "",
          staffId: f.staff_id || "",
          stock: null,
          needed: null,
        });
      }
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }

    // Current stock of what is still waited for, at the store where it was asked
    const pendingByLocation = new Map();
    for (const r of records) {
      if (r.status !== "pending" || !/^\d+$/.test(r.locationId) || !/^\d+$/.test(r.variantId)) continue;
      if (!pendingByLocation.has(r.locationId)) pendingByLocation.set(r.locationId, []);
      pendingByLocation.get(r.locationId).push(r);
    }
    for (const [locationId, list] of pendingByLocation) {
      try {
        const variants = await restock.loadVariants([...new Set(list.map((r) => r.variantId))], locationId);
        for (const r of list) {
          const v = variants.get(r.variantId);
          if (!v) continue;
          r.stock = v.available;
          r.needed = restock.thresholdFor(v);
          r.vendor = v.vendor || r.vendor;
          r.productType = v.productType || r.productType;
        }
      } catch (err) {
        console.warn(`[report] stock for location ${locationId} failed: ${err.message}`);
      }
    }

    const locData = await graphql(LOCATIONS_QUERY, {});
    const locations = (locData.locations?.nodes || []).map((l) => ({
      id: idOf(l.id),
      code: l.name,
      name: displayNameOf(l.displayName?.value),
      active: l.isActive,
    }));

    return { generatedAt: new Date().toISOString(), locations, records };
  }

  app.get("/report/data", rateLimit({ windowMs: 60 * 1000, max: 30 }), async (req, res) => {
    setSecurityHeaders(res);
    if (!isSignedIn(req)) return res.status(401).json({ error: "Please sign in again" });
    try {
      const fresh = req.query.refresh === "1";
      if (fresh || !cache || Date.now() - cache.at > CACHE_MS) {
        loading ||= loadAll().finally(() => { loading = null; });
        cache = { at: Date.now(), value: await loading };
      }
      return res.json(cache.value);
    } catch (err) {
      console.error("[report] data failed:", err.message);
      return res.status(502).json({ error: "Shopify did not respond, please try again" });
    }
  });
}
