// Hera_POS_aid backend
// - Apple Wallet loyalty card (generate, Apple Wallet web service, push updates)
// - Smile.io points sync on orders/paid
// - /api/verify for the POS "Customer Login" tile
// - Physical gift cards: /api/giftcard/status for the POS "Gift Card Sale" tile + activation on orders/paid
// - Shopify App Proxy page for the storefront "Add to Apple Wallet" button
// - Gift card balance: storefront page /apps/hera/giftcard-balance and POS /api/giftcard/balance
// - Restock Notify: POS tile + daily stock check called by Shopify Flow (see restock.js)

import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { PKPass } from "passkit-generator";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import http2 from "http2";
import { readFileSync } from "fs";
import { createGiftCardService, lookupBalance } from "./giftcard.js";
import { registerRestock, RESTOCK_SCOPES } from "./restock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.set("trust proxy", true); // Render sits behind a proxy; needed for req.ip

// Raw body needed for Shopify webhook HMAC validation
app.use("/webhooks", express.raw({ type: "application/json" }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  APP_URL,
  SHOP_DOMAIN,
  SHOP_ACCESS_TOKEN,
  QR_SECRET,
  SMILE_API_KEY,
  KLAVIYO_API_KEY,
} = process.env;

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";
const PUBLIC_URL = (APP_URL || "https://search-0wf4.onrender.com").replace(/\/+$/, "");

// "log"     → accept POS requests without a valid Shopify session token, but log it
// "enforce" → reject them (switch to this after confirming the logs show "[pos-auth] ok")
const POS_AUTH_MODE = (process.env.POS_AUTH_MODE || "log").toLowerCase();

// Old storefront links (/wallet/email/:email, /wallet/:id, /api/pass/generate/:id).
// Set LEGACY_WALLET_LINKS=off on Render once Klaviyo points to /apps/hera/wallet.
const LEGACY_WALLET_LINKS = (process.env.LEGACY_WALLET_LINKS || "on").toLowerCase() !== "off";

const PASS_TYPE_ID = "pass.com.herabeauty.loyalty";
const AUTH_TOKEN   = "herabeauty2026loyalty"; // shared Apple Wallet auth token (per-pass tokens: phase 2)
const DOWNLOAD_TTL_SECONDS = 10 * 60;

for (const [name, value] of Object.entries({
  SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOP_DOMAIN, SHOP_ACCESS_TOKEN, QR_SECRET,
  WWDR_PEM_B64: process.env.WWDR_PEM_B64,
  SIGNER_CERT_B64: process.env.SIGNER_CERT_B64,
  SIGNER_KEY_B64: process.env.SIGNER_KEY_B64,
})) {
  if (!value) console.error(`[config] Missing environment variable ${name}`);
}

// ─── Apple Wallet certificates ────────────────────────────────────────────────
const wwdr       = Buffer.from(process.env.WWDR_PEM_B64 || "", "base64");
const signerCert = Buffer.from(process.env.SIGNER_CERT_B64 || "", "base64");
const signerKey  = Buffer.from(process.env.SIGNER_KEY_B64 || "", "base64");

// ─── Small helpers ────────────────────────────────────────────────────────────

const nowSeconds = () => Math.floor(Date.now() / 1000);
const isCustomerId = (v) => typeof v === "string" && /^\d{1,20}$/.test(v);
const customerGid = (id) => `gid://shopify/Customer/${id}`;
const hostOf = (url) => { try { return new URL(url).host; } catch { return null; } };

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hmacHex(secret, message) {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function customerIdFromSerial(serialNumber) {
  const m = /^hera-(\d{1,20})$/.exec(serialNumber || "");
  return m ? m[1] : null;
}

// Simple in-memory fixed-window rate limiter
function rateLimit({ windowMs, max, key: keyOf }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = (keyOf ? keyOf(req) : req.ip) || "unknown";
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      entry = { start: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      console.warn(`[rate-limit] ${req.path} blocked for ${key}`);
      return res.status(429).json({ error: "Too many requests, please wait a minute" });
    }
    next();
  };
}

// ─── Shopify Admin GraphQL ────────────────────────────────────────────────────

async function shopifyGraphQL(query, variables = {}, { timeoutMs } = {}) {
  const resp = await fetch(
    `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOP_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
      // Optional: only the gift card balance lookups set a timeout, everything else behaves as before.
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    }
  );
  if (!resp.ok) throw new Error(`Shopify API error: ${resp.status}`);
  const json = await resp.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join(", "));
  return json.data;
}

const CUSTOMER_QUERY = `
  query GetCustomer($id: ID!) {
    customer(id: $id) {
      id
      firstName
      lastName
      defaultEmailAddress { emailAddress }
      defaultPhoneNumber { phoneNumber }
      points: metafield(namespace: "custom", key: "points_balance") { value }
      devices: metafield(namespace: "custom", key: "wallet_devices") { value }
      legacyPushToken: metafield(namespace: "custom", key: "wallet_push_token") { value }
      legacyDeviceId: metafield(namespace: "custom", key: "wallet_device_id") { value }
    }
  }
`;

// Returns a normalised customer object, or null if not found.
// devices = [{ deviceId, pushToken }] — one entry per iPhone / Apple Watch that holds the card.
async function fetchCustomer(customerId) {
  const data = await shopifyGraphQL(CUSTOMER_QUERY, { id: customerGid(customerId) });
  const c = data.customer;
  if (!c) return null;

  let devices = [];
  try {
    const parsed = JSON.parse(c.devices?.value || "[]");
    if (Array.isArray(parsed)) devices = parsed.filter((d) => d && d.pushToken);
  } catch { /* ignore malformed value */ }

  // Older registrations stored a single device in two text metafields
  const legacyPush = c.legacyPushToken?.value;
  if (legacyPush && !devices.some((d) => d.pushToken === legacyPush)) {
    devices.push({ deviceId: c.legacyDeviceId?.value || "", pushToken: legacyPush });
  }

  return {
    id: customerId,
    firstName: c.firstName || "",
    lastName: c.lastName || "",
    email: c.defaultEmailAddress?.emailAddress || null,
    phone: c.defaultPhoneNumber?.phoneNumber || null,
    points: c.points?.value ?? "0",
    devices,
    hasLegacyFields: Boolean(c.legacyPushToken || c.legacyDeviceId),
  };
}

const METAFIELDS_SET = `
  mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

const METAFIELDS_DELETE = `
  mutation DeleteMetafields($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

async function setCustomerMetafield(customerId, key, value, type) {
  const data = await shopifyGraphQL(METAFIELDS_SET, {
    metafields: [{ ownerId: customerGid(customerId), namespace: "custom", key, type, value: String(value) }],
  });
  const errs = data.metafieldsSet?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
}

async function saveDevices(customer, devices) {
  await setCustomerMetafield(customer.id, "wallet_devices", JSON.stringify(devices), "json");
  if (customer.hasLegacyFields) {
    await shopifyGraphQL(METAFIELDS_DELETE, {
      metafields: [
        { ownerId: customerGid(customer.id), namespace: "custom", key: "wallet_push_token" },
        { ownerId: customerGid(customer.id), namespace: "custom", key: "wallet_device_id" },
      ],
    });
    customer.hasLegacyFields = false;
  }
}

async function findCustomerIdByEmail(email) {
  const q = `email:"${email.replace(/["\\]/g, "")}"`;
  const data = await shopifyGraphQL(
    `query FindCustomer($q: String!) { customers(first: 1, query: $q) { nodes { id } } }`,
    { q }
  );
  const gid = data.customers?.nodes?.[0]?.id;
  return gid ? gid.split("/").pop() : null;
}

// ─── Barcode token (unchanged format; stronger version planned for phase 2) ──

function barcodeHmac(customerId, ts) {
  const hex = hmacHex(QR_SECRET, `${customerId}${ts}`);
  return (parseInt(hex.slice(0, 8), 16) % 100000000).toString().padStart(8, "0");
}

function buildToken(customerId) {
  const ts = Date.now().toString().slice(-6);
  return `${customerId}${ts}${barcodeHmac(customerId, ts)}`;
}

function verifyToken(token, customerId) {
  const idLen = customerId.length;
  const ts = token.slice(idLen, idLen + 6);
  const received = token.slice(idLen + 6);
  return safeEqual(received, barcodeHmac(customerId, ts));
}

// ─── Signed, short-lived pass download links ─────────────────────────────────

function signDownload(customerId, exp) {
  return hmacHex(QR_SECRET, `pass-download:${customerId}:${exp}`);
}

function downloadUrl(customerId) {
  const exp = nowSeconds() + DOWNLOAD_TTL_SECONDS;
  return `${PUBLIC_URL}/api/pass/download/${customerId}?exp=${exp}&sig=${signDownload(customerId, exp)}`;
}

// ─── Pass builder ─────────────────────────────────────────────────────────────

async function generatePassBuffer(customerId) {
  const customer = await fetchCustomer(customerId);
  if (!customer) throw new Error("Customer not found");

  const pass = await PKPass.from({
    model: join(__dirname, "passkit/loyalty.pass"),
    certificates: { wwdr, signerCert, signerKey },
  }, {
    serialNumber: `hera-${customerId}`,
    // webServiceURL comes from passkit/loyalty.pass/pass.json — never change it,
    // every card already in customers' Wallets points to that address.
  });

  pass.type = "storeCard";

  pass.setBarcodes({
    message: buildToken(customerId),
    format: "PKBarcodeFormatPDF417",
    messageEncoding: "iso-8859-1",
  });

  pass.primaryFields.push({ key: "points", label: "Points", value: customer.points });
  pass.secondaryFields.push({
    key: "name",
    label: "Member",
    value: `${customer.firstName} ${customer.lastName}`.trim(),
  });

  return pass.getAsBuffer();
}

async function sendPass(res, customerId) {
  try {
    const buffer = await generatePassBuffer(customerId);
    res.set({
      "Content-Type": "application/vnd.apple.pkpass",
      "Content-Length": buffer.length,
      "Cache-Control": "no-store",
      "Last-Modified": new Date().toUTCString(),
    });
    res.send(buffer);
  } catch (err) {
    console.error(`Pass generation failed for customer ${customerId}:`, err.message);
    res.status(err.message === "Customer not found" ? 404 : 500).json({ error: "Pass generation failed" });
  }
}

// ─── APNs push (Apple Wallet update) ──────────────────────────────────────────
// Payload must be "{}". Uses the pass signing cert. Resolves { ok, status, reason }.

function sendPassUpdatePush(pushToken) {
  return new Promise((resolve) => {
    const body = "{}";
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };

    const client = http2.connect("https://api.push.apple.com", { cert: signerCert, key: signerKey });
    client.on("error", (err) => {
      console.error("APNs connection error:", err.message);
      done({ ok: false, status: 0, reason: err.message });
    });

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${pushToken}`,
      "apns-push-type": "background",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    req.setTimeout(15000, () => {
      req.close();
      client.close();
      done({ ok: false, status: 0, reason: "timeout" });
    });

    let status;
    let responseBody = "";
    req.on("response", (headers) => { status = headers[":status"]; });
    req.on("data", (chunk) => { responseBody += chunk; });
    req.on("end", () => {
      client.close();
      let reason = "";
      try { reason = JSON.parse(responseBody || "{}").reason || ""; } catch { reason = responseBody; }
      done({ ok: status === 200, status, reason });
    });
    req.on("error", (err) => {
      client.close();
      done({ ok: false, status: 0, reason: err.message });
    });

    req.end(body);
  });
}

// ─── deviceId → customerId (used when Apple asks which passes changed) ───────
// Filled at registration AND right before every push, so a server restart or
// Render sleep no longer breaks updates: the push itself re-creates the entry.
const deviceToCustomer = new Map();

// ─── CORS (only the POS extension origins need it) ────────────────────────────

const POS_ORIGINS = new Set(["https://cdn.shopify.com", "https://extensions.shopifycdn.com"]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const listed = POS_ORIGINS.has(origin);
    if (listed || POS_AUTH_MODE !== "enforce") {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (!listed && req.path.startsWith("/api/verify")) {
      console.warn(`[cors] request to ${req.path} from unlisted origin ${origin}`);
    }
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── POS session token check ──────────────────────────────────────────────────
// The POS extension sends a Shopify ID token (JWT, HS256, signed with the app secret).

function verifyShopifyIdToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  if (header.alg !== "HS256") throw new Error("unexpected alg");
  const expected = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(`${h}.${p}`).digest("base64url");
  if (!safeEqual(expected, s)) throw new Error("bad signature");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  const now = nowSeconds();
  if (typeof payload.exp !== "number" || payload.exp < now - 10) throw new Error("expired");
  if (typeof payload.nbf === "number" && payload.nbf > now + 10) throw new Error("not yet valid");
  if (payload.aud !== SHOPIFY_API_KEY) throw new Error("wrong audience");
  const destHost = hostOf(payload.dest);
  if (!destHost || destHost !== SHOP_DOMAIN) throw new Error(`wrong shop ${destHost}`);
  if (hostOf(payload.iss) !== destHost) throw new Error("iss/dest mismatch");
  return payload;
}

function requirePosAuth(req, res, next) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  try {
    if (!token) throw new Error("no token");
    const payload = verifyShopifyIdToken(token);
    console.log(`[pos-auth] ok (user ${payload.sub || "?"})`);
    return next();
  } catch (err) {
    if (POS_AUTH_MODE === "enforce") {
      console.warn(`[pos-auth] rejected: ${err.message}`);
      return res.status(401).json({ error: "This POS device is not authorized" });
    }
    console.warn(`[pos-auth] would reject (mode=log): ${err.message}`);
    return next();
  }
}

// ─── POS: verify loyalty card barcode ─────────────────────────────────────────

app.post(
  "/api/verify",
  rateLimit({ windowMs: 60 * 1000, max: 30 }),
  requirePosAuth,
  async (req, res) => {
    const token = String(req.body?.token ?? "").trim();
    if (!/^\d{22,40}$/.test(token)) return res.status(400).json({ error: "Invalid card" });

    const customerId = token.slice(0, -14);
    if (!isCustomerId(customerId) || !verifyToken(token, customerId)) {
      console.warn(`[verify] invalid signature from ${req.ip}`);
      return res.status(401).json({ error: "Invalid card" });
    }

    try {
      const customer = await fetchCustomer(customerId);
      if (!customer) return res.status(404).json({ error: "Customer not found" });
      return res.json({
        customerId,
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        phone: customer.phone,
        loyaltyPoints: customer.points,
      });
    } catch (err) {
      console.error("Customer lookup failed:", err.message);
      return res.status(500).json({ error: "Customer lookup failed" });
    }
  }
);

// ─── POS: physical gift card sale (activation happens after payment) ──────────
// The "Gift Card Sale" POS tile scans the serial printed OUTSIDE the sticker, then adds a custom
// sale line tagged with that serial to the cart. When the order is paid (orders/paid webhook below)
// the card is created in Shopify with the redeem code that belongs to the serial. See giftcard.js.

const GIFT_SECRET = process.env.GIFT_SECRET || "";
const GIFT_MAX_AMOUNT = Number(process.env.GIFT_MAX_AMOUNT) || 2000;
const GIFT_CURRENCY = process.env.GIFT_CURRENCY || "";
// Shopify product "Hera Beauté Physical Gift Card" (numeric id). Excluded from Smile points by product.
// Only needs to be set on Render if the product is ever re-created.
const GIFT_PRODUCT_ID = process.env.GIFT_PRODUCT_ID || "15428034789686";

let giftCards = null;
if (GIFT_SECRET.length >= 32) {
  giftCards = createGiftCardService({
    secret: GIFT_SECRET,
    graphql: (query, variables) => shopifyGraphQL(query, variables, { timeoutMs: 20000 }),
    productId: GIFT_PRODUCT_ID,
    maxAmount: GIFT_MAX_AMOUNT,
    currency: GIFT_CURRENCY,
  });
} else {
  console.warn("[giftcard] GIFT_SECRET is missing or shorter than 32 characters: gift card sales are disabled");
}

// Always enforced, whatever POS_AUTH_MODE says: this endpoint decides whether a card can be sold.
function requirePosAuthStrict(req, res, next) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  try {
    if (!token) throw new Error("no token");
    const payload = verifyShopifyIdToken(token);
    req.posUser = payload.sub || "?";
    return next();
  } catch (err) {
    console.warn(`[pos-auth] rejected (${req.path}): ${err.message}`);
    return res.status(401).json({ error: "This POS device is not authorized" });
  }
}

app.post(
  "/api/giftcard/status",
  rateLimit({ windowMs: 60 * 1000, max: 60 }),
  requirePosAuthStrict,
  async (req, res) => {
    if (!giftCards) return res.status(503).json({ error: "Gift card sales are not configured" });
    try {
      const result = await giftCards.status(req.body?.serial);
      if (!result.valid) {
        console.warn(`[giftcard] invalid serial scanned by POS user ${req.posUser}`);
        return res.status(400).json({ error: "Invalid gift card code" });
      }
      return res.json({ valid: true, active: result.active });
    } catch (err) {
      console.error("[giftcard] status check failed:", err.message);
      return res.status(502).json({ error: "Could not check this card right now, please try again" });
    }
  }
);

// Render -> Shopify connections occasionally hang or reset (the error text is then empty: "request to ... failed, reason: ").
// Balance lookups must answer quickly, so each try is limited to 8 s and a network failure is retried (reads are harmless to repeat).
const describeError = (err) =>
  [err?.name, err?.code || err?.cause?.code, err?.message].filter(Boolean).join(" ") || "unknown error";
const isNetworkError = (err) =>
  ["AbortError", "TimeoutError", "FetchError"].includes(err?.name) || /^request to /.test(err?.message || "");

async function graphqlWithRetry(query, variables, { timeoutMs, attempts }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await shopifyGraphQL(query, variables, { timeoutMs });
    } catch (err) {
      if (attempt >= attempts || !isNetworkError(err)) throw err;
      console.warn(`[shopify] network error (${describeError(err)}), retrying ${attempt}/${attempts - 1}`);
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
}
const balanceGraphQL = (query, variables) => graphqlWithRetry(query, variables, { timeoutMs: 8000, attempts: 3 });

// POS tile: cashier scans the redeem QR (the one under the sticker) to read the balance.
// The response never contains the code, only the last 4 characters.
app.post(
  "/api/giftcard/balance",
  rateLimit({ windowMs: 60 * 1000, max: 60 }),
  requirePosAuthStrict,
  async (req, res) => {
    const started = Date.now();
    try {
      const result = await lookupBalance(balanceGraphQL, req.body?.code);
      if (!result.valid) return res.status(400).json({ error: "This is not a gift card redeem code" });
      if (!result.found) return res.json({ found: false });
      console.log(`[giftcard] balance checked at POS (…${result.lastCharacters}) by ${req.posUser} in ${Date.now() - started} ms`);
      return res.json(result);
    } catch (err) {
      console.error(`[giftcard] POS balance lookup failed after ${Date.now() - started} ms:`, describeError(err));
      // The POS route is staff-only, so it may carry the technical reason (shown in small print on the tile).
      return res.status(502).json({
        error: "Could not check this card right now, please try again",
        detail: describeError(err).slice(0, 160),
      });
    }
  }
);

// ─── POS: Restock Notify (restock.js) ─────────────────────────────────────────
// POS routes always require a valid POS session token (they return customer contact details).

registerRestock(app, {
  graphql: (query, variables) => graphqlWithRetry(query, variables, { timeoutMs: 20000, attempts: 2 }),
  requirePosAuth: requirePosAuthStrict,
  rateLimit,
  safeEqual,
});

// ─── Storefront: App Proxy page  (herabeauty storefront /apps/hera/wallet) ───

function verifyProxySignature(query) {
  const { signature, ...rest } = query;
  if (typeof signature !== "string" || !signature) return false;
  const message = Object.keys(rest)
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}`)
    .sort()
    .join("");
  return safeEqual(hmacHex(SHOPIFY_API_SECRET, message), signature);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function walletPageHtml({ downloadHref, userAgent }) {
  const ua = userAgent || "";
  const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS/.test(ua);
  const showSafariNotice = ua && !isSafari;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Hera Beauté Loyalty Card</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      min-height: 100vh; background: #ffffff; padding: 24px; text-align: center;
    }
    .logo { width: 200px; margin-bottom: 48px; }
    .btn { display: inline-block; margin-top: 24px; }
    .btn img { width: 180px; }
    .notice { font-size: 13px; color: #888; line-height: 1.6; max-width: 280px; margin-bottom: 8px; }
    .arrow { font-size: 28px; position: fixed; top: 12px; right: 16px; animation: bounce 1s infinite; }
    @keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
  </style>
</head>
<body>
  <img class="logo" src="https://cdn.shopify.com/s/files/1/1443/5388/files/Logo_bdd93355-62cf-412d-81f4-6b24fc343bf7.svg?v=1761925608" alt="Hera Beauté">
  ${showSafariNotice ? `
  <div class="arrow">↗</div>
  <p class="notice">
    Please open this page in Safari to add your card.<br>
    Veuillez ouvrir cette page dans Safari pour ajouter votre carte.
  </p>` : ""}
  <a class="btn" href="${escapeHtml(downloadHref)}">
    <img src="https://cdn.shopify.com/s/files/1/1443/5388/files/add_button.png?v=1778255486" alt="Add to Apple Wallet">
  </a>
</body>
</html>`;
}

function loginRedirectHtml(returnUrl) {
  const target = `/account/login?return_url=${encodeURIComponent(returnUrl)}`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=${escapeHtml(target)}"><title>Hera Beauté</title></head>
<body style="font-family:-apple-system,sans-serif;text-align:center;padding:48px 24px">
<p>Please log in to add your loyalty card.<br>Veuillez vous connecter pour ajouter votre carte.</p>
<p style="margin-top:16px"><a href="${escapeHtml(target)}">Log in / Se connecter</a></p>
</body></html>`;
}

app.get(["/proxy", "/proxy/wallet"], (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!verifyProxySignature(req.query)) {
    console.warn(`[proxy] bad signature from ${req.ip}`);
    return res.status(401).send("Unauthorized");
  }
  if (req.query.shop !== SHOP_DOMAIN) return res.status(403).send("Forbidden");
  const ts = Number(req.query.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds() - ts) > 300) {
    return res.status(401).send("Request expired, please reload the page");
  }

  const customerId = String(req.query.logged_in_customer_id || "");
  const pathPrefix = String(req.query.path_prefix || "/apps/hera");

  if (!isCustomerId(customerId)) {
    return res.type("html").send(loginRedirectHtml(`${pathPrefix}/wallet`));
  }

  res.type("html").send(walletPageHtml({
    downloadHref: downloadUrl(customerId),
    userAgent: req.headers["user-agent"],
  }));
});

// ─── Storefront: gift card balance  (herabeauty storefront /apps/hera/giftcard-balance) ───
// GET  /proxy/giftcard-balance            Liquid page, rendered inside the store theme (language follows the storefront)
// GET  /proxy/giftcard-balance/app.js     page script (English / French)
// GET  /proxy/giftcard-balance/jsqr.js    QR decoder used only when the customer taps "Scan"
// POST /proxy/giftcard-balance/lookup     { code } -> { found, balance, currency, ... }

function readStorefrontFile(...parts) {
  try {
    return readFileSync(join(__dirname, "storefront", ...parts));
  } catch (err) {
    console.error(`[giftcard-balance] cannot read storefront/${parts.join("/")}: ${err.message}`);
    return null;
  }
}
const gcbPage = readStorefrontFile("giftcard-balance.liquid");
const gcbScript = readStorefrontFile("giftcard-balance.js");
const gcbJsQr = readStorefrontFile("vendor", "jsQR.js");
const gcbVersion = crypto
  .createHash("sha1")
  .update(gcbPage || "")
  .update(gcbScript || "")
  .digest("hex")
  .slice(0, 8);

// Same checks as the wallet page: Shopify signs every App Proxy request.
function proxyGuard(req, res, next) {
  res.set("Cache-Control", "no-store");
  if (!verifyProxySignature(req.query)) {
    console.warn(`[proxy] bad signature from ${req.ip} (${req.path})`);
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.query.shop !== SHOP_DOMAIN) return res.status(403).json({ error: "Forbidden" });
  const ts = Number(req.query.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds() - ts) > 300) {
    return res.status(401).json({ error: "Request expired, please reload the page" });
  }
  next();
}

app.get("/proxy/giftcard-balance", proxyGuard, (req, res) => {
  if (!gcbPage || !gcbScript) return res.status(503).send("Temporarily unavailable");
  const html = gcbPage.toString("utf8").replaceAll("__ASSET_VERSION__", gcbVersion);
  res.type("application/liquid").send(html); // Shopify renders it inside the theme layout
});

app.get("/proxy/giftcard-balance/app.js", (req, res) => {
  if (!gcbScript) return res.status(503).end();
  res.set("Cache-Control", "public, max-age=3600").type("application/javascript").send(gcbScript);
});

// "Where is the code" pictures: storefront/images/<name>.png|jpg|webp|svg (replace the files, or point the page at a CDN URL).
const GCB_IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };
app.get("/proxy/giftcard-balance/img/:name", (req, res) => {
  const m = /^([a-z0-9_-]{1,60})\.(png|jpe?g|webp|svg)$/i.exec(req.params.name || "");
  if (!m) return res.status(404).end();
  const data = readStorefrontFile("images", req.params.name);
  if (!data) return res.status(404).end();
  res.set("Cache-Control", "public, max-age=300").type(GCB_IMAGE_TYPES[m[2].toLowerCase()]).send(data);
});

app.get("/proxy/giftcard-balance/jsqr.js", (req, res) => {
  if (!gcbJsQr) return res.status(503).end();
  res.set("Cache-Control", "public, max-age=86400").type("application/javascript").send(gcbJsQr);
});

app.post(
  "/proxy/giftcard-balance/lookup",
  proxyGuard,
  rateLimit({ windowMs: 60 * 1000, max: 10 }),
  // The per-IP limit above can be dodged with a forged X-Forwarded-For, so also cap the total.
  rateLimit({ windowMs: 60 * 1000, max: 300, key: () => "all-storefront" }),
  async (req, res) => {
    const started = Date.now();
    try {
      const result = await lookupBalance(balanceGraphQL, req.body?.code);
      if (!result.valid) return res.status(400).json({ error: "invalid" });
      if (!result.found) return res.json({ found: false });
      console.log(`[giftcard] balance checked on storefront (…${result.lastCharacters}) in ${Date.now() - started} ms`);
      return res.json(result);
    } catch (err) {
      console.error(`[giftcard] storefront balance lookup failed after ${Date.now() - started} ms:`, describeError(err));
      return res.status(502).json({ error: "unavailable" });
    }
  }
);

// Signed, 10-minute download link produced by the App Proxy page
app.get("/api/pass/download/:customerId", async (req, res) => {
  const { customerId } = req.params;
  const exp = Number(req.query.exp);
  const sig = String(req.query.sig || "");
  if (!isCustomerId(customerId) || !Number.isFinite(exp)) return res.status(400).send("Invalid link");
  if (exp < nowSeconds()) {
    return res.status(410).send("This link has expired. Please go back and tap the button again.");
  }
  if (!safeEqual(signDownload(customerId, exp), sig)) return res.status(401).send("Invalid link");
  await sendPass(res, customerId);
});

// ─── Legacy storefront links (remove with LEGACY_WALLET_LINKS=off) ───────────

function legacyGuard(req, res, next) {
  if (!LEGACY_WALLET_LINKS) {
    return res.status(410).send("This link is no longer valid. Please use the button in your account.");
  }
  console.warn(`[legacy] ${req.path} used`);
  next();
}

app.get("/wallet/email/:email", legacyGuard, async (req, res) => {
  try {
    const customerId = await findCustomerIdByEmail(decodeURIComponent(req.params.email));
    if (!customerId) return res.status(404).send("Customer not found");
    res.redirect(`/wallet/${customerId}`);
  } catch (err) {
    console.error("Email lookup error:", err.message);
    res.status(500).send("Error");
  }
});

app.get("/wallet/:customerId", legacyGuard, (req, res) => {
  const { customerId } = req.params;
  if (!isCustomerId(customerId)) return res.status(400).send("Invalid link");
  res.type("html").send(walletPageHtml({
    downloadHref: `/api/pass/generate/${customerId}`,
    userAgent: req.headers["user-agent"],
  }));
});

app.get("/api/pass/generate/:customerId", legacyGuard, async (req, res) => {
  const { customerId } = req.params;
  if (!isCustomerId(customerId)) return res.status(400).json({ error: "Invalid customerId" });
  await sendPass(res, customerId);
});

// ─── Apple Wallet web service ─────────────────────────────────────────────────

function appleAuthorized(req) {
  return safeEqual(req.headers["authorization"] || "", `ApplePass ${AUTH_TOKEN}`);
}

// Register a device for push updates
app.post("/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber", async (req, res) => {
  const { deviceId, passTypeId, serialNumber } = req.params;
  if (!appleAuthorized(req)) return res.status(401).send("Unauthorized");
  if (passTypeId !== PASS_TYPE_ID) return res.status(404).send();

  const customerId = customerIdFromSerial(serialNumber);
  const pushToken = req.body?.pushToken;
  if (!customerId || !pushToken) return res.status(400).send("Bad Request");

  try {
    const customer = await fetchCustomer(customerId);
    if (!customer) return res.status(404).send();

    const existing = customer.devices.find((d) => d.deviceId === deviceId);
    const alreadyRegistered = existing && existing.pushToken === pushToken;
    const devices = customer.devices.filter((d) => d.deviceId !== deviceId && d.pushToken !== pushToken);
    devices.push({ deviceId, pushToken });
    await saveDevices(customer, devices);
    deviceToCustomer.set(deviceId, customerId);

    console.log(`Registered device ${deviceId} for customer ${customerId} (${devices.length} device(s))`);

    if (customer.email) {
      updateKlaviyoAppleCard(customer.email).catch((err) =>
        console.error("Klaviyo AppleCard update failed:", err.message)
      );
    }

    res.status(alreadyRegistered ? 200 : 201).send();
  } catch (err) {
    console.error("Register device error:", err.message);
    res.status(500).send();
  }
});

// Unregister a device
app.delete("/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber", async (req, res) => {
  const { deviceId, serialNumber } = req.params;
  if (!appleAuthorized(req)) return res.status(401).send("Unauthorized");

  const customerId = customerIdFromSerial(serialNumber);
  if (!customerId) return res.status(400).send();

  try {
    const customer = await fetchCustomer(customerId);
    if (customer) {
      const devices = customer.devices.filter((d) => d.deviceId !== deviceId);
      await saveDevices(customer, devices);
    }
    deviceToCustomer.delete(deviceId);
    console.log(`Unregistered device ${deviceId} for customer ${customerId}`);
    res.status(200).send();
  } catch (err) {
    console.error("Unregister device error:", err.message);
    res.status(500).send();
  }
});

// Apple asks which passes changed for this device (called after our push)
app.get("/v1/devices/:deviceId/registrations/:passTypeId", (req, res) => {
  const { deviceId } = req.params;
  const customerId = deviceToCustomer.get(deviceId);
  if (!customerId) {
    console.log(`No pending update for device ${deviceId}, returning 204`);
    return res.status(204).send();
  }
  res.json({ serialNumbers: [`hera-${customerId}`], lastUpdated: new Date().toISOString() });
});

// Apple downloads the latest version of a pass
app.get("/v1/passes/:passTypeId/:serialNumber", async (req, res) => {
  if (!appleAuthorized(req)) return res.status(401).send("Unauthorized");
  const customerId = customerIdFromSerial(req.params.serialNumber);
  if (!customerId) return res.status(400).send();
  console.log(`Apple fetching updated pass for customer ${customerId}`);
  await sendPass(res, customerId);
});

// Apple Wallet error log (useful when debugging on a device)
app.post("/v1/log", (req, res) => {
  const logs = Array.isArray(req.body?.logs) ? req.body.logs.slice(0, 20) : [];
  for (const line of logs) console.warn(`[apple-wallet-log] ${String(line).slice(0, 500)}`);
  res.status(200).send();
});

// ─── Klaviyo: mark Apple Wallet card added ────────────────────────────────────

async function updateKlaviyoAppleCard(email) {
  if (!KLAVIYO_API_KEY) {
    console.log("KLAVIYO_API_KEY not set, skipping Klaviyo update");
    return;
  }

  const headers = {
    "Authorization": `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
    "revision": "2026-04-15",
    "Content-Type": "application/json",
  };

  const searchResp = await fetch(
    `https://a.klaviyo.com/api/profiles?filter=${encodeURIComponent(`equals(email,${JSON.stringify(email)})`)}`,
    { headers }
  );
  if (!searchResp.ok) throw new Error(`Klaviyo GET profiles failed: ${searchResp.status}`);
  const searchData = await searchResp.json();
  const profileId = searchData.data?.[0]?.id;
  if (!profileId) {
    console.log("No Klaviyo profile found for this customer, skipping");
    return;
  }

  const updateResp = await fetch(`https://a.klaviyo.com/api/profiles/${profileId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      data: { type: "profile", id: profileId, attributes: { properties: { AppleCard: true } } },
    }),
  });
  if (!updateResp.ok) {
    const errText = await updateResp.text();
    throw new Error(`Klaviyo PATCH profile failed: ${updateResp.status} ${errText}`);
  }
  console.log(`Klaviyo AppleCard=true set (profile ${profileId})`);
}

// ─── Shopify orders/paid webhook → sync Smile points + push update ────────────

app.post("/webhooks/orders", async (req, res) => {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"] || "";
  const digest = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(req.body).digest("base64");
  if (!safeEqual(digest, hmacHeader)) {
    console.warn("Webhook HMAC mismatch");
    return res.status(401).send("Unauthorized");
  }

  let order;
  try {
    order = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  const shopifyCustomerId = order.customer?.id ? String(order.customer.id) : null;
  res.status(200).send("OK");

  // Gift card sale: activate the card behind a paid POS gift card line. Independent of the
  // customer/points logic below (a gift card sale usually has no customer attached).
  if (giftCards) {
    giftCards.activateFromOrder(order).catch((err) => console.error("[giftcard] activation error:", err.message));
  }

  if (!shopifyCustomerId) return;

  syncSmilePoints(shopifyCustomerId).catch((err) => console.error("Smile sync error:", err.message));
});

async function syncSmilePoints(customerId) {
  const customer = await fetchCustomer(customerId);
  if (!customer) return console.log(`Customer ${customerId} not found, skipping Smile sync`);
  if (!customer.email) return console.log(`No email for customer ${customerId}, skipping Smile sync`);

  const smileResp = await fetch(
    `https://api.smile.io/v1/customers?email=${encodeURIComponent(customer.email)}`,
    { headers: { Authorization: `Bearer ${SMILE_API_KEY}` } }
  );
  if (!smileResp.ok) return console.error(`Smile API error: ${smileResp.status}`);

  const smileData = await smileResp.json();
  const smileCustomer = smileData.customers?.[0];
  if (!smileCustomer) return console.log(`No Smile customer for Shopify customer ${customerId}`);

  const pointsBalance = String(smileCustomer.points_balance ?? 0);
  if (pointsBalance === String(customer.points)) {
    return console.log(`Points unchanged (${pointsBalance}) for customer ${customerId}, no push`);
  }

  await setCustomerMetafield(customerId, "points_balance", pointsBalance, "number_integer");
  console.log(`Updated points_balance to ${pointsBalance} for customer ${customerId}`);

  if (!customer.devices.length) return console.log(`No Wallet device for customer ${customerId}, skipping push`);

  const stillValid = [];
  for (const device of customer.devices) {
    if (device.deviceId) deviceToCustomer.set(device.deviceId, customerId);
    const result = await sendPassUpdatePush(device.pushToken);
    if (result.ok) {
      console.log(`Pass update push sent for customer ${customerId}`);
      stillValid.push(device);
    } else if (result.status === 410 || ["BadDeviceToken", "Unregistered"].includes(result.reason)) {
      console.log(`Removing dead device for customer ${customerId} (${result.reason || result.status})`);
      if (device.deviceId) deviceToCustomer.delete(device.deviceId);
    } else {
      console.error(`APNs push failed for customer ${customerId}: ${result.status} ${result.reason}`);
      stillValid.push(device);
    }
  }
  if (stillValid.length !== customer.devices.length || customer.hasLegacyFields) {
    await saveDevices(customer, stillValid);
  }
}

// ─── OAuth (only used when (re)installing the app) ────────────────────────────

const SCOPES = ["read_customers,write_customers,read_orders,write_app_proxy,read_gift_cards,write_gift_cards", ...RESTOCK_SCOPES].join(",");

app.get("/auth", (req, res) => {
  const { shop } = req.query;
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop || "")) return res.status(400).send("Missing shop");
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${PUBLIC_URL}/auth/callback`;
  res.redirect(
    `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`
  );
});

app.get("/auth/callback", async (req, res) => {
  const { shop, code, hmac, ...rest } = req.query;
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop || "")) return res.status(400).send("Invalid shop");
  const params = Object.entries({ shop, code, ...rest })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  if (!safeEqual(hmacHex(SHOPIFY_API_SECRET, params), hmac)) return res.status(403).send("HMAC validation failed");

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code }),
    });
    const { access_token, scope } = await tokenRes.json();
    // The token is intentionally NOT written to the logs. It is shown once to the
    // admin who completed the install so it can be pasted into Render (SHOP_ACCESS_TOKEN).
    console.log(`Installed on ${shop}, scopes: ${scope || "?"}${access_token ? "" : " (no access token returned)"}`);
    res.set("Cache-Control", "no-store");
    res.type("html").send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Hera_POS_aid installed</title></head>
<body style="font-family:-apple-system,sans-serif;padding:32px;max-width:640px">
<h2>Hera_POS_aid installed on ${escapeHtml(shop)}</h2>
<p>Only if you are rotating the token: copy it into Render → Environment → <code>SHOP_ACCESS_TOKEN</code>. It is not stored or logged anywhere.</p>
<pre style="background:#f4f4f4;padding:12px;word-break:break-all;white-space:pre-wrap">${escapeHtml(access_token || "(none)")}</pre>
<p>Scopes: ${escapeHtml(scope || "?")}</p>
<p><a href="https://${escapeHtml(shop)}/admin/apps">Back to Shopify admin</a></p>
</body></html>`);
  } catch (err) {
    console.error("OAuth callback error:", err.message);
    res.status(500).send("Install failed");
  }
});

app.get("/", (req, res) => res.send("Hera_POS_aid OK"));

app.listen(PORT, () => {
  console.log(`Hera_POS_aid running on port ${PORT} (POS_AUTH_MODE=${POS_AUTH_MODE}, legacy links ${LEGACY_WALLET_LINKS ? "on" : "off"})`);
});
