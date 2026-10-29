// Restock Notify
// ─────────────────────────────────────────────────────────────────────────────
// A customer in store wants a product that is out of stock. The cashier opens the POS tile
// "Restock Notify", picks the variants, checks the customer's email / phone, chooses how the
// customer wants to be told (email or SMS) and confirms.
//
// Storage (both in Shopify, nothing in a separate database):
//   • Metaobject `restock_request` (merchant-owned, so any app on the shop can read it):
//       one entry per customer + variant + location. Never deleted: when the customer is
//       notified, status goes from "pending" to "notified" (kept for analysis).
//   • Customer metafield `custom.restock_requests` (JSON list): only what this customer is
//       still waiting for, so it can be seen on the customer page in the Shopify admin.
//
// Checking stock: a Shopify Flow workflow calls POST /api/restock/run (10:00 and 16:00).
// For every pending request we read "available" at the request's location. When it is
// >= the threshold (RESTOCK_THRESHOLD, or the product type's own value from
// RESTOCK_TYPE_THRESHOLDS, default "WIG=1"), we send a Klaviyo event "Restock Available" (one per customer + store),
// then mark the requests notified and remove them from the customer metafield.
//
// Store names: Location metafield `custom.display_name` (e.g. MTL10 → "Chambly Longueuil").
// Falls back to the Shopify location name (the code) when it is empty.

import crypto from "crypto";
import fetch from "node-fetch";

export const RESTOCK_SCOPES = [
  "read_products",
  "read_inventory",
  "read_locations",
  "read_metaobjects",
  "write_metaobjects",
  "read_metaobject_definitions",
  "write_metaobject_definitions",
];

const TYPE = "restock_request";
const METAFIELD_NS = "custom";
const METAFIELD_KEY = "restock_requests";
const KLAVIYO_METRIC = "Restock Available";
const KLAVIYO_REVISION = "2026-07-15";
const MAX_ITEMS_PER_REQUEST = 30;

const isNumericId = (v) => /^\d{1,20}$/.test(String(v ?? ""));
const gid = (kind, id) => `gid://shopify/${kind}/${id}`;
const idOf = (g) => String(g || "").split("/").pop();
const cleanVariantTitle = (t) => (t && t !== "Default Title" ? t : "");
// Metaobject date_time values: ISO 8601 without milliseconds, explicit UTC offset
const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

// Canadian / US numbers typed at the counter: "514 555 1234" → "+15145551234".
export function normalizePhone(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function parseTypeThresholds(raw) {
  const map = new Map();
  for (const part of String(raw || "").split(",")) {
    const m = /^\s*(.+?)\s*=\s*(\d+)\s*$/.exec(part);
    if (m && Number(m[2]) >= 1) map.set(m[1].toUpperCase(), Number(m[2]));
  }
  return map;
}

// Shopify customer locale → "fr" or "en" (empty or anything else = English)
export function languageOf(locale) {
  return String(locale || "").toLowerCase().startsWith("fr") ? "fr" : "en";
}

// Link for the "View product" button: the product page with this variant selected.
// Products not published on the online store fall back to a store search for the SKU / title.
const STORE_URL = (process.env.STORE_URL || "https://herabeauty.ca").replace(/\/+$/, "");
function productUrl(v) {
  const variantId = String(v.id || "").split("/").pop();
  if (v.product?.onlineStoreUrl) return `${v.product.onlineStoreUrl}?variant=${variantId}`;
  return `${STORE_URL}/search?q=${encodeURIComponent(v.sku || v.product?.title || "")}`;
}

// A consent time for Klaviyo: the Shopify time when it is valid and in the past, otherwise one minute ago
function pastIso(value) {
  const t = Date.parse(value || "");
  const latest = Date.now() - 60 * 1000;
  return new Date(Number.isFinite(t) && t <= latest ? t : latest).toISOString();
}

// "fr" → "fr-CA", "en" → "en-CA" (BCP 47, the format Klaviyo's Locale expects)
export function klaviyoLocale(language) {
  return language === "fr" ? "fr-CA" : "en-CA";
}

// "Product - Shade" for one item
const itemLabel = (i) => [i.product_title, i.variant_title].filter(Boolean).join(" - ");

// Every item, e.g. "Wig Pop Nadia - #1B, Aphogee Shampoo 16oz"
export function itemsText(items) {
  return items.map(itemLabel).join(", ");
}

// Short version for SMS: at most 2 items, then "and 3 more" (French: "et 3 autres"),
// e.g. "Wig Pop Nadia - #1B, Aphogee Shampoo 16oz and 3 more"
export function itemsShort(items, max = 2, language = "en") {
  const shown = items.slice(0, max).map(itemLabel).join(", ");
  const rest = items.length - max;
  if (rest <= 0) return shown;
  return language === "fr" ? `${shown} et ${rest} ${rest === 1 ? "autre" : "autres"}` : `${shown} and ${rest} more`;
}

// Location metafield custom.display_name: single line text. Also accepts a list (uses the first value).
export function displayNameOf(value) {
  const v = String(value ?? "").trim();
  if (v.startsWith("[")) {
    try {
      const arr = JSON.parse(v);
      return Array.isArray(arr) ? String(arr.find((x) => String(x).trim()) ?? "").trim() : "";
    } catch {
      return v;
    }
  }
  return v;
}

// "+14506709777" → "(450) 670-9777"; other formats are returned as they are.
export function formatPhone(raw) {
  const s = String(raw ?? "").trim();
  const m = /^\+?1?(\d{3})(\d{3})(\d{4})$/.exec(s.replace(/[\s().-]/g, ""));
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : s;
}

export function normalizeEmail(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254 ? s : null;
}

// ─── GraphQL documents ────────────────────────────────────────────────────────

const RESTOCK_CUSTOMER_QUERY = `
  query RestockCustomer($id: ID!) {
    customer(id: $id) {
      id
      firstName
      lastName
      locale
      defaultEmailAddress { emailAddress marketingState marketingUpdatedAt }
      defaultPhoneNumber { phoneNumber smsMarketingConsent { state updatedAt } }
      requests: metafield(namespace: "${METAFIELD_NS}", key: "${METAFIELD_KEY}") { value }
    }
  }
`;

const CUSTOMER_UPDATE = `
  mutation RestockCustomerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) { userErrors { field message } }
  }
`;

const EMAIL_CONSENT = `
  mutation RestockEmailConsent($input: CustomerEmailMarketingConsentUpdateInput!) {
    customerEmailMarketingConsentUpdate(input: $input) { userErrors { field message } }
  }
`;

const SMS_CONSENT = `
  mutation RestockSmsConsent($input: CustomerSmsMarketingConsentUpdateInput!) {
    customerSmsMarketingConsentUpdate(input: $input) { userErrors { field message } }
  }
`;

const LOCATION_QUERY = `
  query RestockLocation($id: ID!) {
    location(id: $id) {
      id
      name
      displayName: metafield(namespace: "custom", key: "display_name") { value }
      address { address1 address2 city provinceCode zip countryCode phone }
    }
  }
`;

const VARIANT_FIELDS = `
  id
  sku
  barcodes(first: 1) { nodes { value } }
  title
  price
  media(first: 1) { nodes { preview { image { url } } } }
  product {
    id
    title
    vendor
    productType
    handle
    onlineStoreUrl
    featuredMedia { preview { image { url } } }
  }
`;

const VARIANTS_AT_LOCATION = `
  query RestockVariants($ids: [ID!]!, $loc: ID!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        ${VARIANT_FIELDS}
        inventoryItem {
          tracked
          inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { quantity } }
        }
      }
    }
  }
`;

const VARIANT_SEARCH = `
  query RestockSearch($q: String!, $loc: ID!) {
    productVariants(first: 30, query: $q) {
      nodes {
        ${VARIANT_FIELDS}
        inventoryItem {
          tracked
          inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { quantity } }
        }
      }
    }
  }
`;

const METAFIELDS_SET = `
  mutation RestockMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }
`;

const METAFIELDS_DELETE = `
  mutation RestockMetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) { userErrors { field message } }
  }
`;

const MO_BY_HANDLE = `
  query RestockByHandle($handle: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $handle) { id }
  }
`;

const MO_UPSERT = `
  mutation RestockUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

const MO_UPDATE = `
  mutation RestockUpdate($id: ID!, $metaobject: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

const MO_PENDING = `
  query RestockPending($after: String) {
    metaobjects(type: "${TYPE}", first: 250, after: $after, query: "fields.status:\\"pending\\"") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        fields { key value }
      }
    }
  }
`;

// Pending requests matching a search (one customer, or one variant), with the customer's name and contact
const MO_PENDING_SEARCH = `
  query RestockPendingSearch($q: String!, $after: String) {
    metaobjects(type: "${TYPE}", first: 100, after: $after, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        fields { key value }
        customer: field(key: "customer") {
          reference { ... on Customer { displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } } }
        }
      }
    }
  }
`;

// ─── Definitions (created automatically on start-up when missing) ────────────

const MO_DEFINITION = `
  query RestockDefinition {
    metaobjectDefinitionByType(type: "${TYPE}") {
      id
      fieldDefinitions { key capabilities { adminFilterable { enabled } } }
    }
    metafieldDefinitions(first: 1, ownerType: CUSTOMER, namespace: "${METAFIELD_NS}", key: "${METAFIELD_KEY}") {
      nodes { id }
    }
  }
`;

const MO_DEFINITION_UPDATE = `
  mutation RestockDefinitionUpdate($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
    metaobjectDefinitionUpdate(id: $id, definition: $definition) {
      metaobjectDefinition { id }
      userErrors { field message code }
    }
  }
`;

const MO_DEFINITION_CREATE = `
  mutation RestockDefinitionCreate($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition { id type }
      userErrors { field message code }
    }
  }
`;

const METAFIELD_DEFINITION_CREATE = `
  mutation RestockMetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }
`;

const text = (key, name, { filterable = false, choices = null, description } = {}) => ({
  key,
  name,
  type: "single_line_text_field",
  ...(description ? { description } : {}),
  ...(filterable ? { capabilities: { adminFilterable: { enabled: true } } } : {}),
  ...(choices ? { validations: [{ name: "choices", value: JSON.stringify(choices) }] } : {}),
});

const DEFINITION_INPUT = {
  type: TYPE,
  name: "Restock request",
  description: "Restock Notify (POS): one entry per customer + variant + store. Written by Hera_POS_aid.",
  displayNameKey: "sku",
  fieldDefinitions: [
    text("status", "Status", { filterable: true, choices: ["pending", "notified", "cancelled"] }),
    text("location_code", "Store code", { filterable: true, description: "Shopify location name, e.g. MTL10" }),
    text("location_id", "Location ID"),
    { key: "customer", name: "Customer", type: "customer_reference" },
    text("customer_id", "Customer ID", { filterable: true }),
    { key: "variant", name: "Variant", type: "variant_reference" },
    text("variant_id", "Variant ID", { filterable: true }),
    text("sku", "SKU", { filterable: true }),
    text("product_title", "Product"),
    text("variant_title", "Variant"),
    text("channel", "Notify by", { filterable: true, choices: ["email", "sms"] }),
    text("notified_channel", "Notified by", { filterable: true, choices: ["email", "sms"], description: "Channel actually used (SMS falls back to email when the customer cannot receive texts)" }),
    { key: "requested_at", name: "Requested at", type: "date_time" },
    { key: "notified_at", name: "Notified at", type: "date_time" },
    { key: "available_at_notify", name: "Available when notified", type: "number_integer" },
    text("staff_id", "Staff member ID"),
  ],
};

// ─── Module ──────────────────────────────────────────────────────────────────

export function registerRestock(app, { graphql, requirePosAuth, rateLimit, safeEqual }) {
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY || "";
  // Klaviyo list that SMS subscribers made at POS are added to (default: the list the Shopify integration syncs SMS subscribers to)
  const KLAVIYO_SMS_LIST_ID = (process.env.KLAVIYO_SMS_LIST_ID ?? "UeqRiu").trim();
  const KLAVIYO_EMAIL_LIST_ID = (process.env.KLAVIYO_EMAIL_LIST_ID || "").trim();
  const RUN_KEY = process.env.RESTOCK_RUN_KEY || "";
  const THRESHOLD = Math.max(1, parseInt(process.env.RESTOCK_THRESHOLD || "1", 10) || 1);
  // Per product type exceptions, e.g. "WIG=1" or "WIG=1,MAKEUP=3" (type names are not case-sensitive)
  const TYPE_THRESHOLDS = parseTypeThresholds(process.env.RESTOCK_TYPE_THRESHOLDS ?? "WIG=1");
  const thresholdFor = (variant) => TYPE_THRESHOLDS.get(variant.productType.trim().toUpperCase()) ?? THRESHOLD;

  if (!RUN_KEY || RUN_KEY.length < 24) {
    console.warn("[restock] RESTOCK_RUN_KEY is missing or shorter than 24 characters: /api/restock/run is disabled");
  }

  async function gqlChecked(query, variables, rootField) {
    const data = await graphql(query, variables);
    const errs = data?.[rootField]?.userErrors || [];
    if (errs.length) {
      const err = new Error(errs.map((e) => e.message).join(", "));
      err.userErrors = errs;
      throw err;
    }
    return data[rootField];
  }

  // ── One request at a time per customer, so two cashiers / the Flow run never overwrite
  //    each other's change to the same customer metafield (single Render instance).
  const customerLocks = new Map();
  async function withCustomerLock(customerId, fn) {
    const prev = customerLocks.get(customerId) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const chained = prev.then(() => mine);
    customerLocks.set(customerId, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (customerLocks.get(customerId) === chained) customerLocks.delete(customerId);
    }
  }

  // ── Customer ──────────────────────────────────────────────────────────────

  function parseList(value) {
    try {
      const v = JSON.parse(value || "[]");
      return Array.isArray(v) ? v.filter((x) => x && x.variant_id && x.location) : [];
    } catch {
      return [];
    }
  }

  async function loadCustomer(customerId) {
    const data = await graphql(RESTOCK_CUSTOMER_QUERY, { id: gid("Customer", customerId) });
    const c = data.customer;
    if (!c) return null;
    return {
      id: customerId,
      firstName: c.firstName || "",
      lastName: c.lastName || "",
      locale: c.locale || "",
      email: c.defaultEmailAddress?.emailAddress || null,
      emailState: c.defaultEmailAddress?.marketingState || null,
      emailConsentAt: c.defaultEmailAddress?.marketingUpdatedAt || null,
      phone: c.defaultPhoneNumber?.phoneNumber || null,
      smsState: c.defaultPhoneNumber?.smsMarketingConsent?.state || null,
      smsConsentAt: c.defaultPhoneNumber?.smsMarketingConsent?.updatedAt || null,
      waiting: parseList(c.requests?.value),
    };
  }

  const publicCustomer = (c) => ({
    customerId: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phone,
    emailSubscribed: c.emailState === "SUBSCRIBED",
    emailState: c.emailState,
    smsSubscribed: c.smsState === "SUBSCRIBED",
    smsState: c.smsState,
    waiting: c.waiting,
    locale: c.locale,
    language: languageOf(c.locale),
  });

  // Klaviyo decides whether a text can be sent: a number is only reachable once Klaviyo has it as subscribed
  // (after the customer replied YES when the list uses double opt-in). Shopify may say "subscribed" even when
  // Klaviyo never received it. Returns true / false, or null when Klaviyo could not be asked.
  async function smsSubscribedInKlaviyo(phone) {
    if (!KLAVIYO_API_KEY || !phone) return null;
    try {
      const url = "https://a.klaviyo.com/api/profiles?" + new URLSearchParams({
        filter: `equals(phone_number,"${phone}")`,
        "additional-fields[profile]": "subscriptions",
      });
      const resp = await fetch(url, {
        headers: { Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`, revision: KLAVIYO_REVISION, Accept: "application/vnd.api+json" },
        signal: AbortSignal.timeout(6000),
      });
      if (!resp.ok) {
        console.warn(`[restock] Klaviyo SMS status lookup failed: ${resp.status}`);
        return null;
      }
      const data = await resp.json();
      const profiles = data?.data || [];
      if (!profiles.length) return false;
      return profiles.some((p) => p?.attributes?.subscriptions?.sms?.marketing?.can_receive_sms_marketing === true);
    } catch (err) {
      console.warn(`[restock] Klaviyo SMS status lookup failed: ${err.message}`);
      return null;
    }
  }

  async function saveWaitingList(customerId, list) {
    if (list.length) {
      await gqlChecked(METAFIELDS_SET, {
        metafields: [{
          ownerId: gid("Customer", customerId),
          namespace: METAFIELD_NS,
          key: METAFIELD_KEY,
          type: "json",
          value: JSON.stringify(list),
        }],
      }, "metafieldsSet");
    } else {
      await gqlChecked(METAFIELDS_DELETE, {
        metafields: [{ ownerId: gid("Customer", customerId), namespace: METAFIELD_NS, key: METAFIELD_KEY }],
      }, "metafieldsDelete");
    }
  }

  // ── Locations (cached 10 minutes: names change rarely) ────────────────────

  const locationCache = new Map();
  async function loadLocation(locationId) {
    const hit = locationCache.get(locationId);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    const data = await graphql(LOCATION_QUERY, { id: gid("Location", locationId) });
    const l = data.location;
    const value = l ? {
      id: locationId,
      code: l.name,
      name: displayNameOf(l.displayName?.value) || l.name,
      address1: l.address?.address1 || "",
      address2: l.address?.address2 || "",
      city: l.address?.city || "",
      province: l.address?.provinceCode || "",
      zip: l.address?.zip || "",
      phone: l.address?.phone || "",
      phoneDisplay: formatPhone(l.address?.phone),
      country: l.address?.countryCode || "",
    } : null;
    if (value) {
      value.address = [
        [value.address1, value.address2].filter(Boolean).join(" "),
        value.city,
        [value.province, value.zip].filter(Boolean).join(" "),
      ].filter(Boolean).join(", ");
    }
    locationCache.set(locationId, { at: Date.now(), value });
    return value;
  }

  // ── Variants ──────────────────────────────────────────────────────────────

  function shapeVariant(v) {
    if (!v?.id) return null;
    const level = v.inventoryItem?.inventoryLevel;
    return {
      variantId: idOf(v.id),
      productId: idOf(v.product?.id),
      sku: v.sku || "",
      barcode: v.barcodes?.nodes?.[0]?.value || "",
      productTitle: v.product?.title || "",
      variantTitle: cleanVariantTitle(v.title),
      vendor: v.product?.vendor || "",
      productType: v.product?.productType || "",
      price: v.price || "",
      // First product media (the product's main picture); the variant's own picture when there is no product media
      image: v.product?.featuredMedia?.preview?.image?.url || v.media?.nodes?.[0]?.preview?.image?.url || "",
      variantImage: v.media?.nodes?.[0]?.preview?.image?.url || "",
      url: productUrl(v),
      tracked: Boolean(v.inventoryItem?.tracked),
      // null when the variant is not stocked at this location at all
      available: level ? (level.quantities?.[0]?.quantity ?? 0) : null,
    };
  }

  async function loadVariants(variantIds, locationId) {
    const out = new Map();
    for (let i = 0; i < variantIds.length; i += 100) {
      const ids = variantIds.slice(i, i + 100).map((id) => gid("ProductVariant", id));
      const data = await graphql(VARIANTS_AT_LOCATION, { ids, loc: gid("Location", locationId) });
      for (const node of data.nodes || []) {
        const v = shapeVariant(node);
        if (v) out.set(v.variantId, v);
      }
    }
    return out;
  }

  // ── POS endpoints (always need a valid POS session token: they return personal data) ──

  const posLimit = rateLimit({ windowMs: 60 * 1000, max: 240 });

  const badRequest = (res, msg) => res.status(400).json({ error: msg });
  const fail = (res, where, err) => {
    console.error(`[restock] ${where} failed:`, err.message);
    return res.status(502).json({ error: "Shopify did not respond, please try again", detail: err.message.slice(0, 160) });
  };

  // Customer details + subscription status + what they are already waiting for
  app.post("/api/restock/customer", posLimit, requirePosAuth, async (req, res) => {
    const customerId = String(req.body?.customerId ?? "");
    if (!isNumericId(customerId)) return badRequest(res, "Invalid customer");
    try {
      const c = await loadCustomer(customerId);
      if (!c) return res.status(404).json({ error: "Customer not found" });
      return res.json(publicCustomer(c));
    } catch (err) {
      return fail(res, "customer lookup", err);
    }
  });

  // Add or change the customer's email / phone (the cashier types what the customer wants).
  app.post("/api/restock/contact", posLimit, requirePosAuth, async (req, res) => {
    const customerId = String(req.body?.customerId ?? "");
    if (!isNumericId(customerId)) return badRequest(res, "Invalid customer");
    const wantsEmail = req.body?.email != null && String(req.body.email).trim() !== "";
    const wantsPhone = req.body?.phone != null && String(req.body.phone).trim() !== "";
    const email = wantsEmail ? normalizeEmail(req.body.email) : null;
    const phone = wantsPhone ? normalizePhone(req.body.phone) : null;
    if (wantsEmail && !email) return badRequest(res, "This email address does not look right");
    if (wantsPhone && !phone) return badRequest(res, "Phone number: enter 10 digits, e.g. 514 555 1234");
    if (!email && !phone) return badRequest(res, "Nothing to save");

    try {
      const current = await loadCustomer(customerId);
      if (!current) return res.status(404).json({ error: "Customer not found" });
      const input = { id: gid("Customer", customerId) };
      if (email && email !== (current.email || "").toLowerCase()) input.email = email;
      if (phone && phone !== current.phone) input.phone = phone;
      if (Object.keys(input).length === 1) return res.json(publicCustomer(current)); // nothing changed
      try {
        await gqlChecked(CUSTOMER_UPDATE, { input }, "customerUpdate");
      } catch (err) {
        if (err.userErrors) return res.status(400).json({ error: err.message });
        throw err;
      }
      const changed = Object.keys(input).filter((k) => k !== "id")
        .map((k) => `${k} ${current[k] ? "changed" : "added"}`).join(", ");
      console.log(`[restock] customer ${customerId}: ${changed} at POS by ${req.posUser}`);
      const c = await loadCustomer(customerId);
      return res.json(publicCustomer(c));
    } catch (err) {
      return fail(res, "contact update", err);
    }
  });

  // Subscribe to email or SMS marketing (the cashier confirms the customer agreed)
  app.post("/api/restock/subscribe", posLimit, requirePosAuth, async (req, res) => {
    const customerId = String(req.body?.customerId ?? "");
    const channel = req.body?.channel;
    const locationId = String(req.body?.locationId ?? "");
    if (!isNumericId(customerId)) return badRequest(res, "Invalid customer");
    if (channel !== "email" && channel !== "sms") return badRequest(res, "Invalid channel");

    const consent = {
      marketingState: "SUBSCRIBED",
      marketingOptInLevel: "SINGLE_OPT_IN",
      consentUpdatedAt: new Date().toISOString(),
      ...(isNumericId(locationId) ? { sourceLocationId: gid("Location", locationId) } : {}),
    };
    try {
      if (channel === "email") {
        await gqlChecked(EMAIL_CONSENT, {
          input: { customerId: gid("Customer", customerId), emailMarketingConsent: consent },
        }, "customerEmailMarketingConsentUpdate");
      } else {
        await gqlChecked(SMS_CONSENT, {
          input: { customerId: gid("Customer", customerId), smsMarketingConsent: consent },
        }, "customerSmsMarketingConsentUpdate");
      }
      console.log(`[restock] customer ${customerId} subscribed to ${channel} at POS (location ${locationId || "?"}, staff ${req.posUser})`);
      const c = await loadCustomer(customerId);

      // Also subscribe directly in Klaviyo: Shopify -> Klaviyo consent sync does not always happen.
      // Klaviyo then applies the list's opt-in setting (double opt-in = "Reply YES" text).
      // Not awaited: the POS answer must not wait for Klaviyo; a failure is only logged.
      if (c) {
        subscribeInKlaviyo(channel, c)
          .then((done) => done && console.log(`[restock] customer ${customerId} subscribed to ${channel} in Klaviyo`))
          .catch((err) => console.warn(`[restock] Klaviyo ${channel} subscription failed for customer ${customerId}: ${err.message}`));
      }
      return res.json(publicCustomer(c));
    } catch (err) {
      if (err.userErrors) return res.status(400).json({ error: err.message });
      return fail(res, "subscribe", err);
    }
  });

  // Variant-level search in Shopify (used when the POS device's own search finds nothing)
  app.post("/api/restock/search", posLimit, requirePosAuth, async (req, res) => {
    const q = String(req.body?.query ?? "").trim().slice(0, 100);
    const locationId = String(req.body?.locationId ?? "");
    if (q.length < 2) return res.json({ variants: [] });
    if (!isNumericId(locationId)) return badRequest(res, "Invalid location");
    const safe = q.replace(/["\\]/g, " ").trim();
    const words = safe.split(/\s+/).filter(Boolean);
    const query = [
      `sku:"${safe}"`,
      `barcode:"${safe}"`,
      `(${words.join(" AND ")})`,
    ].join(" OR ");
    try {
      const data = await graphql(VARIANT_SEARCH, { q: query, loc: gid("Location", locationId) });
      const variants = (data.productVariants?.nodes || []).map(shapeVariant).filter(Boolean);
      return res.json({ variants });
    } catch (err) {
      return fail(res, "search", err);
    }
  });

  // Save the request: one metaobject per variant + the customer metafield
  app.post("/api/restock/submit", posLimit, requirePosAuth, async (req, res) => {
    const customerId = String(req.body?.customerId ?? "");
    const locationId = String(req.body?.locationId ?? "");
    const channel = req.body?.channel;
    const variantIds = [...new Set((Array.isArray(req.body?.variantIds) ? req.body.variantIds : []).map(String))];
    const staffId = isNumericId(req.body?.staffId) ? String(req.body.staffId) : "";
    // Language confirmed by the cashier ("en" / "fr"); saved as the customer's Shopify locale
    const language = req.body?.language === "fr" ? "fr" : req.body?.language === "en" ? "en" : null;
    // The cashier tapped SMS "Subscribe" during this request (Klaviyo then waits for the customer's YES)
    const smsJustSubscribed = req.body?.smsJustSubscribed === true;

    if (!isNumericId(customerId)) return badRequest(res, "Invalid customer");
    if (!isNumericId(locationId)) return badRequest(res, "Invalid location");
    if (channel !== "email" && channel !== "sms") return badRequest(res, "Choose email or SMS");
    if (!variantIds.length || variantIds.some((v) => !isNumericId(v))) return badRequest(res, "No products selected");
    if (variantIds.length > MAX_ITEMS_PER_REQUEST) return badRequest(res, `At most ${MAX_ITEMS_PER_REQUEST} products at a time`);

    try {
      const location = await loadLocation(locationId);
      if (!location) return badRequest(res, "Unknown location");
      const variants = await loadVariants(variantIds, locationId);
      const missing = variantIds.filter((id) => !variants.has(id));
      if (missing.length) return badRequest(res, "Some products no longer exist, please search again");

      const result = await withCustomerLock(customerId, async () => {
        const customer = await loadCustomer(customerId);
        if (!customer) return { status: 404, body: { error: "Customer not found" } };
        if (channel === "email" && !customer.email) return { status: 400, body: { error: "Add an email address first" } };
        if (channel === "sms" && !customer.phone) return { status: 400, body: { error: "Add a phone number first" } };

        // Save the confirmed language (only when it differs, so "en-CA" is not replaced by "en")
        if (language && languageOf(customer.locale) !== language) {
          try {
            await gqlChecked(CUSTOMER_UPDATE, { input: { id: gid("Customer", customerId), locale: language } }, "customerUpdate");
            console.log(`[restock] customer ${customerId}: language set to ${language} at POS`);
          } catch (err) {
            console.warn(`[restock] could not save language for customer ${customerId}: ${err.message}`);
          }
        }

        // Also write the language to the Klaviyo profile right away (Shopify does not always re-sync locale changes).
        // Not awaited: the POS answer must not wait for Klaviyo; a failure is only logged.
        if (language) {
          const ident = channel === "sms" ? { phone_number: customer.phone } : { email: customer.email };
          setKlaviyoLocale(ident, language)
            .then(() => console.log(`[restock] Klaviyo locale set to ${klaviyoLocale(language)} for customer ${customerId}`))
            .catch((err) => console.warn(`[restock] could not set Klaviyo locale for customer ${customerId}: ${err.message}`));
        }

        const now = isoNow();
        let added = 0;
        let updated = 0;
        const waiting = customer.waiting.slice();

        for (const variantId of variantIds) {
          const v = variants.get(variantId);
          // Stable handle while pending: the same customer + variant + store is never stored twice.
          const handle = `rs-${customerId}-${variantId}-${locationId}`;
          const existing = await graphql(MO_BY_HANDLE, { handle: { type: TYPE, handle } });
          const fields = existing.metaobjectByHandle
            ? [{ key: "channel", value: channel }]
            : [
                { key: "status", value: "pending" },
                { key: "location_code", value: location.code },
                { key: "location_id", value: locationId },
                { key: "customer", value: gid("Customer", customerId) },
                { key: "customer_id", value: customerId },
                { key: "variant", value: gid("ProductVariant", variantId) },
                { key: "variant_id", value: variantId },
                { key: "sku", value: v.sku },
                { key: "product_title", value: v.productTitle.slice(0, 250) },
                { key: "variant_title", value: v.variantTitle.slice(0, 250) },
                { key: "channel", value: channel },
                { key: "requested_at", value: now },
                ...(staffId ? [{ key: "staff_id", value: staffId }] : []),
              ].filter((f) => f.value !== "");
          await gqlChecked(MO_UPSERT, { handle: { type: TYPE, handle }, metaobject: { fields } }, "metaobjectUpsert");
          if (existing.metaobjectByHandle) updated++; else added++;

          const entry = {
            location: location.code,
            sku: v.sku,
            variant_id: variantId,
            product: [v.productTitle, v.variantTitle].filter(Boolean).join(" - ").slice(0, 200),
            channel,
            requested_at: now,
          };
          const i = waiting.findIndex((w) => w.variant_id === variantId && w.location === location.code);
          if (i >= 0) waiting[i] = { ...waiting[i], channel };
          else waiting.push(entry);
        }

        await saveWaitingList(customerId, waiting);

        // Make Klaviyo's consent match Shopify for the chosen channel (Shopify -> Klaviyo sync is not reliable).
        // Not awaited: the POS answer must not wait for Klaviyo; the result is only logged.
        syncConsentToKlaviyo({ channel, customer, smsJustSubscribed })
          .then((msg) => msg && console.log(`[restock] customer ${customerId}: ${msg}`))
          .catch((err) => console.warn(`[restock] customer ${customerId}: Klaviyo consent update failed: ${err.message}`));

        return { status: 200, body: { ok: true, added, updated, store: location.name, channel, language: language || languageOf(customer.locale) } };
      });

      if (result.status === 200) {
        console.log(`[restock] customer ${customerId} @ ${location.code}: ${result.body.added} added, ${result.body.updated} already waiting (${channel}, staff ${staffId || req.posUser})`);
      }
      return res.status(result.status).json(result.body);
    } catch (err) {
      return fail(res, "submit", err);
    }
  });

  // ── Klaviyo ───────────────────────────────────────────────────────────────

  // Klaviyo "Subscribe Profiles" (bulk job).
  //  historical = false: normal subscription; the list's opt-in setting applies (double opt-in = "Reply YES").
  //  historical = true : the customer already agreed (recorded in Shopify at consentedAt); Klaviyo subscribes
  //                      immediately, without a confirmation message.
  async function klaviyoSubscribe({ channel, customer, listId, historical = false, consentedAt = null }) {
    if (!KLAVIYO_API_KEY) throw new Error("KLAVIYO_API_KEY not set");
    const contact = channel === "sms" ? customer.phone : customer.email;
    if (!contact) throw new Error(`no ${channel === "sms" ? "phone" : "email"} on the customer`);

    const consent = { consent: "SUBSCRIBED", ...(historical ? { consented_at: pastIso(consentedAt) } : {}) };
    const attributes = channel === "sms"
      ? {
          phone_number: customer.phone,
          ...(customer.email ? { email: customer.email } : {}), // keeps the phone on the customer's existing profile
          subscriptions: { sms: { marketing: consent } },
        }
      : { email: customer.email, subscriptions: { email: { marketing: consent } } };

    const resp = await fetch("https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs", {
      method: "POST",
      headers: {
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        revision: KLAVIYO_REVISION,
        "Content-Type": "application/json",
        Accept: "application/vnd.api+json",
      },
      body: JSON.stringify({
        data: {
          type: "profile-subscription-bulk-create-job",
          attributes: {
            custom_source: "Hera POS Restock Notify",
            ...(historical ? { historical_import: true } : {}),
            profiles: { data: [{ type: "profile", attributes }] },
          },
          ...(listId ? { relationships: { list: { data: { type: "list", id: listId } } } } : {}),
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Klaviyo ${resp.status} ${t.slice(0, 300)}`);
    }
  }

  // POS "Subscribe" tap. SMS: normal subscription to the SMS list, Klaviyo sends "Reply YES" (case C).
  // Email: only when KLAVIYO_EMAIL_LIST_ID is set; otherwise the email consent is written at Confirm.
  async function subscribeInKlaviyo(channel, customer) {
    if (channel === "sms") {
      await klaviyoSubscribe({ channel: "sms", customer, listId: KLAVIYO_SMS_LIST_ID });
      return true;
    }
    if (!KLAVIYO_EMAIL_LIST_ID) return false;
    await klaviyoSubscribe({ channel: "email", customer, listId: KLAVIYO_EMAIL_LIST_ID });
    return true;
  }

  // At Confirm: write the customer's Shopify consent for the chosen channel to Klaviyo.
  //  A/B Email subscribed (before, or just now)        -> written as subscribed, no confirmation email
  //  C   SMS subscribed just now at this POS screen     -> nothing: Klaviyo waits for the customer's YES
  //  D   SMS already subscribed in Shopify              -> written as subscribed, no YES needed
  async function syncConsentToKlaviyo({ channel, customer, smsJustSubscribed }) {
    if (!KLAVIYO_API_KEY) return null;
    if (channel === "email") {
      if (customer.emailState !== "SUBSCRIBED" || !customer.email) return null;
      await klaviyoSubscribe({ channel: "email", customer, listId: KLAVIYO_EMAIL_LIST_ID, historical: true, consentedAt: customer.emailConsentAt });
      return "email consent written to Klaviyo";
    }
    if (smsJustSubscribed) return "SMS subscribed at POS just now: Klaviyo waits for the customer's YES";
    if (customer.smsState !== "SUBSCRIBED" || !customer.phone) return null;
    if ((await smsSubscribedInKlaviyo(customer.phone)) === true) return "SMS already subscribed in Klaviyo";
    await klaviyoSubscribe({ channel: "sms", customer, listId: KLAVIYO_SMS_LIST_ID, historical: true, consentedAt: customer.smsConsentAt });
    return "SMS consent from Shopify written to Klaviyo (no YES needed)";
  }

  async function setKlaviyoLocale(identifier, language) {
    if (!KLAVIYO_API_KEY) throw new Error("KLAVIYO_API_KEY not set");
    const resp = await fetch("https://a.klaviyo.com/api/profile-import", {
      method: "POST",
      headers: {
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        revision: KLAVIYO_REVISION,
        "Content-Type": "application/json",
        Accept: "application/vnd.api+json",
      },
      body: JSON.stringify({ data: { type: "profile", attributes: { ...identifier, locale: klaviyoLocale(language) } } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Klaviyo ${resp.status} ${t.slice(0, 200)}`);
    }
  }

  async function sendKlaviyoEvent({ customer, channel, requestedChannel, location, items }) {
    if (!KLAVIYO_API_KEY) throw new Error("KLAVIYO_API_KEY not set");
    const profile = channel === "sms"
      ? { phone_number: customer.phone, first_name: customer.firstName, last_name: customer.lastName }
      : { email: customer.email, first_name: customer.firstName, last_name: customer.lastName };
    // Klaviyo Smart Translations read the profile's Locale: keep it in line with the language confirmed at POS
    profile.locale = klaviyoLocale(languageOf(customer.locale));
    const day = new Date().toISOString().slice(0, 10);
    const uniqueId = crypto
      .createHash("sha256")
      .update(`${customer.id}|${location.id}|${day}|${items.map((i) => i.variant_id).sort().join(",")}`)
      .digest("hex")
      .slice(0, 40);

    const body = {
      data: {
        type: "event",
        attributes: {
          time: new Date().toISOString(),
          unique_id: `restock-${uniqueId}`,
          properties: {
            channel,
            requested_channel: requestedChannel || channel,
            language: languageOf(customer.locale),
            store_code: location.code,
            store_name: location.name,
            store_address: location.address,
            store_address1: [location.address1, location.address2].filter(Boolean).join(" "),
            store_city: location.city,
            store_province: location.province,
            store_zip: location.zip,
            store_phone: location.phoneDisplay,
            store_phone_e164: location.phone,
            item_count: items.length,
            first_product_title: items[0]?.product_title || "",
            first_variant_title: items[0]?.variant_title || "",
            first_image_url: items[0]?.image_url || "",
            // Ready-made text for SMS (SMS templates cannot loop over items)
            items_text: itemsText(items),
            items_short: itemsShort(items, 2, languageOf(customer.locale)),
            items,
            shopify_customer_id: customer.id,
          },
          metric: { data: { type: "metric", attributes: { name: KLAVIYO_METRIC } } },
          profile: { data: { type: "profile", attributes: profile } },
        },
      },
    };

    const resp = await fetch("https://a.klaviyo.com/api/events", {
      method: "POST",
      headers: {
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        revision: KLAVIYO_REVISION,
        "Content-Type": "application/json",
        Accept: "application/vnd.api+json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Klaviyo ${resp.status} ${t.slice(0, 300)}`);
    }
  }

  // ── The check (called by Shopify Flow) ────────────────────────────────────

  const fieldMap = (node) => Object.fromEntries((node.fields || []).map((f) => [f.key, f.value]));

  async function loadPending() {
    const out = [];
    let after = null;
    for (let page = 0; page < 200; page++) {
      const data = await graphql(MO_PENDING, { after });
      const conn = data.metaobjects;
      for (const n of conn?.nodes || []) {
        const f = fieldMap(n);
        if (f.status !== "pending") continue; // the search filter is the first pass, this is the real check
        if (!isNumericId(f.customer_id) || !isNumericId(f.variant_id) || !isNumericId(f.location_id)) continue;
        out.push({ id: n.id, handle: n.handle, ...f });
      }
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    return out;
  }

  let running = null;

  async function runCheck({ dryRun }) {
    const started = Date.now();
    const summary = { dryRun, threshold: THRESHOLD, typeThresholds: Object.fromEntries(TYPE_THRESHOLDS), pending: 0, due: 0, notifiedCustomers: 0, notifiedItems: 0, skipped: [], errors: [], preview: [] };
    const pending = await loadPending();
    summary.pending = pending.length;

    // stock per location
    const byLocation = new Map();
    for (const p of pending) {
      if (!byLocation.has(p.location_id)) byLocation.set(p.location_id, []);
      byLocation.get(p.location_id).push(p);
    }

    const due = []; // { request, variant, location }
    for (const [locationId, list] of byLocation) {
      const location = await loadLocation(locationId);
      if (!location) {
        summary.skipped.push(`location ${locationId} not found (${list.length} requests)`);
        continue;
      }
      const variants = await loadVariants([...new Set(list.map((p) => p.variant_id))], locationId);
      for (const p of list) {
        const v = variants.get(p.variant_id);
        if (!v) {
          // Variant deleted in Shopify: nothing will ever come back in stock
          if (!dryRun) await cancelRequest(p).catch((err) => summary.errors.push(`cancel ${p.handle}: ${err.message}`));
          summary.skipped.push(`variant ${p.variant_id} no longer exists (customer ${p.customer_id}) → cancelled`);
          continue;
        }
        if (v.available !== null && v.available >= thresholdFor(v)) due.push({ request: p, variant: v, location });
      }
    }
    summary.due = due.length;

    // one Klaviyo event per customer + store + channel
    const groups = new Map();
    for (const d of due) {
      const k = `${d.request.customer_id}|${d.location.id}|${d.request.channel}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(d);
    }

    for (const [k, list] of groups) {
      const [customerId, , requestedChannel] = k.split("|");
      const location = list[0].location;
      try {
        await withCustomerLock(customerId, async () => {
          const customer = await loadCustomer(customerId);
          if (!customer) {
            summary.skipped.push(`customer ${customerId} not found`);
            return;
          }
          // Klaviyo only texts customers subscribed to SMS: otherwise notify by email.
          let channel = requestedChannel;
          const smsReachable = customer.smsState === "SUBSCRIBED" && (await smsSubscribedInKlaviyo(customer.phone)) !== false;
          if (channel === "sms" && !smsReachable) {
            if (customer.email) {
              channel = "email";
              summary.skipped.push(`customer ${customerId} not subscribed to SMS (or did not reply YES) → notified by email instead`);
            } else {
              summary.skipped.push(`customer ${customerId} not subscribed to SMS (or did not reply YES) and has no email (kept pending)`);
              return;
            }
          }
          if ((channel === "sms" && !customer.phone) || (channel === "email" && !customer.email)) {
            summary.skipped.push(`customer ${customerId} has no ${channel === "sms" ? "phone" : "email"} (kept pending)`);
            return;
          }
          const items = list.map(({ request, variant }) => ({
            variant_id: request.variant_id,
            sku: variant.sku,
            product_title: variant.productTitle,
            variant_title: variant.variantTitle,
            vendor: variant.vendor,
            price: variant.price,
            price_display: variant.price ? `$${Number(variant.price).toFixed(2)}` : "",
            image_url: variant.image,
            variant_image_url: variant.variantImage,
            url: variant.url,
            available: variant.available,
          }));
          if (dryRun) {
            summary.preview.push({ customerId, channel, requestedChannel, store: location.code, items: items.map((i) => `${i.sku} ${i.product_title} ${i.variant_title} (available ${i.available})`.trim()) });
            return;
          }

          await sendKlaviyoEvent({ customer, channel, requestedChannel, location, items });

          const now = isoNow();
          const stamp = now.replace(/\D/g, "").slice(0, 14);
          for (const { request, variant } of list) {
            await gqlChecked(MO_UPDATE, {
              id: request.id,
              metaobject: {
                // new handle: the pending handle becomes free for a future request of the same product
                handle: `${request.handle}-n${stamp}`,
                fields: [
                  { key: "status", value: "notified" },
                  { key: "notified_at", value: now },
                  { key: "available_at_notify", value: String(variant.available) },
                  { key: "notified_channel", value: channel },
                ],
              },
            }, "metaobjectUpdate");
          }
          const done = new Set(list.map(({ request }) => `${request.variant_id}|${location.code}`));
          const remaining = customer.waiting.filter((w) => !done.has(`${w.variant_id}|${w.location}`));
          if (remaining.length !== customer.waiting.length) await saveWaitingList(customerId, remaining);

          summary.notifiedCustomers += 1;
          summary.notifiedItems += list.length;
          console.log(`[restock] notified customer ${customerId} by ${channel} @ ${location.code}: ${items.map((i) => i.sku || i.variant_id).join(", ")}`);
        });
      } catch (err) {
        summary.errors.push(`customer ${customerId} @ ${location.code}: ${err.message}`);
        console.error(`[restock] notify failed for customer ${customerId} @ ${location.code}:`, err.message);
      }
    }

    summary.ms = Date.now() - started;
    return summary;
  }

  async function cancelRequest(p) {
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    await gqlChecked(MO_UPDATE, {
      id: p.id,
      metaobject: { handle: `${p.handle}-c${stamp}`, fields: [{ key: "status", value: "cancelled" }] },
    }, "metaobjectUpdate");
    await withCustomerLock(p.customer_id, async () => {
      const c = await loadCustomer(p.customer_id);
      if (!c) return;
      const remaining = c.waiting.filter((w) => !(w.variant_id === p.variant_id && w.location === p.location_code));
      if (remaining.length !== c.waiting.length) await saveWaitingList(p.customer_id, remaining);
    });
  }

  // ── POS: what a customer waits for, cancel one, who waits for a product (this store only) ──

  // Pending requests matching `filter` (search syntax on filterable fields), at one store
  async function pendingAt(filter, locationId) {
    const out = [];
    let after = null;
    for (let page = 0; page < 20; page++) {
      const data = await graphql(MO_PENDING_SEARCH, { q: `${filter} AND fields.status:"pending"`, after });
      const conn = data.metaobjects;
      for (const n of conn?.nodes || []) {
        const f = fieldMap(n);
        // the search is a first pass: check status and store exactly
        if (f.status !== "pending" || f.location_id !== locationId) continue;
        out.push({ id: n.id, handle: n.handle, ...f, contact: n.customer?.reference || null });
      }
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    return out.sort((a, b) => String(b.requested_at || "").localeCompare(String(a.requested_at || "")));
  }

  async function waitingItems(customerId, locationId) {
    const list = await pendingAt(`fields.customer_id:"${customerId}"`, locationId);
    const variants = list.length ? await loadVariants([...new Set(list.map((p) => p.variant_id))], locationId) : new Map();
    return list.map((p) => {
      const v = variants.get(p.variant_id);
      return {
        variantId: p.variant_id,
        sku: v?.sku || p.sku || "",
        barcode: v?.barcode || "",
        productTitle: v?.productTitle || p.product_title || "",
        variantTitle: v ? v.variantTitle : (p.variant_title || ""),
        vendor: v?.vendor || "",
        image: v?.image || "",
        tracked: v ? v.tracked : false,
        available: v ? v.available : null,
        deleted: !v,
        channel: p.channel || "",
        requestedAt: p.requested_at || "",
      };
    });
  }

  // Customer page 1: everything this customer waits for at this store
  app.post("/api/restock/waiting", posLimit, requirePosAuth, async (req, res) => {
    const customerId = String(req.body?.customerId ?? "");
    const locationId = String(req.body?.locationId ?? "");
    if (!isNumericId(customerId)) return badRequest(res, "Invalid customer");
    if (!isNumericId(locationId)) return badRequest(res, "Invalid location");
    try {
      return res.json({ items: await waitingItems(customerId, locationId) });
    } catch (err) {
      return fail(res, "waiting", err);
    }
  });

  // Remove one product from the customer's list at this store (status → cancelled, kept for the report)
  app.post("/api/restock/remove", posLimit, requirePosAuth, async (req, res) => {
    const customerId = String(req.body?.customerId ?? "");
    const locationId = String(req.body?.locationId ?? "");
    const variantId = String(req.body?.variantId ?? "");
    if (!isNumericId(customerId) || !isNumericId(locationId) || !isNumericId(variantId)) return badRequest(res, "Invalid request");
    try {
      const list = await pendingAt(`fields.customer_id:"${customerId}" AND fields.variant_id:"${variantId}"`, locationId);
      for (const p of list) await cancelRequest(p);
      if (list.length) console.log(`[restock] removed by POS (${req.posUser || "?"}): customer ${customerId} variant ${variantId} @ ${list[0].location_code}`);
      return res.json({ removed: list.length, items: await waitingItems(customerId, locationId) });
    } catch (err) {
      return fail(res, "remove", err);
    }
  });

  // Check Item: who waits for this product at this store
  app.post("/api/restock/item", posLimit, requirePosAuth, async (req, res) => {
    const locationId = String(req.body?.locationId ?? "");
    const variantId = String(req.body?.variantId ?? "");
    if (!isNumericId(locationId) || !isNumericId(variantId)) return badRequest(res, "Invalid request");
    try {
      const [list, variants] = await Promise.all([
        pendingAt(`fields.variant_id:"${variantId}"`, locationId),
        loadVariants([variantId], locationId),
      ]);
      const v = variants.get(variantId);
      return res.json({
        threshold: v ? thresholdFor(v) : THRESHOLD,
        available: v ? v.available : null,
        customers: list.map((p) => ({
          customerId: p.customer_id,
          name: p.contact?.displayName || `Customer ${p.customer_id}`,
          email: p.contact?.defaultEmailAddress?.emailAddress || "",
          phone: p.contact?.defaultPhoneNumber?.phoneNumber || "",
          channel: p.channel || "",
          requestedAt: p.requested_at || "",
        })),
      });
    } catch (err) {
      return fail(res, "item", err);
    }
  });

  // Shopify Flow → "Send HTTP request" (POST, header X-Restock-Key: <RESTOCK_RUN_KEY>)
  // ?dryRun=1 answers with what WOULD be sent, without sending anything or changing data.
  app.post("/api/restock/run", rateLimit({ windowMs: 60 * 1000, max: 10 }), async (req, res) => {
    if (!RUN_KEY || RUN_KEY.length < 24) return res.status(503).json({ error: "RESTOCK_RUN_KEY is not configured" });
    if (!safeEqual(req.headers["x-restock-key"] || "", RUN_KEY)) {
      console.warn(`[restock] run rejected: bad key from ${req.ip}`);
      return res.status(401).json({ error: "Unauthorized" });
    }
    const dryRun = req.query.dryRun === "1" || req.body?.dryRun === true;

    if (dryRun) {
      try {
        return res.json(await runCheck({ dryRun: true }));
      } catch (err) {
        return fail(res, "dry run", err);
      }
    }

    if (running) return res.status(202).json({ accepted: false, reason: "A check is already running" });
    res.status(202).json({ accepted: true });
    running = runCheck({ dryRun: false })
      .then((s) => console.log(`[restock] run done: ${JSON.stringify({ ...s, preview: undefined })}`))
      .catch((err) => console.error("[restock] run failed:", err.message))
      .finally(() => { running = null; });
  });

  // ── Start-up: create the metaobject + metafield definitions if they are missing ──

  async function ensureSetup() {
    try {
      const data = await graphql(MO_DEFINITION, {});
      const def = data.metaobjectDefinitionByType;
      if (!def) {
        const created = await gqlChecked(MO_DEFINITION_CREATE, { definition: DEFINITION_INPUT }, "metaobjectDefinitionCreate");
        console.log(`[restock] created metaobject definition ${created.metaobjectDefinition?.type}`);
      } else {
        // Fields added after the first release
        const have = new Set(def.fieldDefinitions.map((f) => f.key));
        const missing = DEFINITION_INPUT.fieldDefinitions.filter((f) => !have.has(f.key));
        if (missing.length) {
          await gqlChecked(MO_DEFINITION_UPDATE, {
            id: def.id,
            definition: { fieldDefinitions: missing.map((f) => ({ create: f })) },
          }, "metaobjectDefinitionUpdate");
          console.log(`[restock] added metaobject fields: ${missing.map((f) => f.key).join(", ")}`);
        }
        const status = def.fieldDefinitions.find((f) => f.key === "status");
        if (!status?.capabilities?.adminFilterable?.enabled) {
          console.warn("[restock] metaobject field `status` is not filterable: the stock check may not find pending requests");
        }
      }
      if (!data.metafieldDefinitions?.nodes?.length) {
        await gqlChecked(METAFIELD_DEFINITION_CREATE, {
          definition: {
            ownerType: "CUSTOMER",
            namespace: METAFIELD_NS,
            key: METAFIELD_KEY,
            name: "Restock requests",
            description: "Products this customer is waiting for (Restock Notify). Written by Hera_POS_aid.",
            type: "json",
          },
        }, "metafieldDefinitionCreate");
        console.log("[restock] created customer metafield definition custom.restock_requests");
      }
      console.log(`[restock] ready (threshold ${THRESHOLD}, by product type ${JSON.stringify(Object.fromEntries(TYPE_THRESHOLDS))})`);
    } catch (err) {
      console.error(`[restock] setup check failed (${err.message}). Were the new scopes approved and SHOP_ACCESS_TOKEN replaced?`);
    }
  }

  ensureSetup();

  // Used by the report page (report.js)
  return { loadVariants, thresholdFor };
}
