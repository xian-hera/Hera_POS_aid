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
const KLAVIYO_REVISION = "2026-04-15";
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

// "Product - Shade" for one item
const itemLabel = (i) => [i.product_title, i.variant_title].filter(Boolean).join(" - ");

// Every item, e.g. "Wig Pop Nadia - #1B, Aphogee Shampoo 16oz"
export function itemsText(items) {
  return items.map(itemLabel).join(", ");
}

// Short version for SMS: at most 2 items, then "and 3 more", e.g. "Wig Pop Nadia - #1B, Aphogee Shampoo 16oz and 3 more"
export function itemsShort(items, max = 2) {
  const shown = items.slice(0, max).map(itemLabel).join(", ");
  const rest = items.length - max;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
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
      defaultEmailAddress { emailAddress marketingState }
      defaultPhoneNumber { phoneNumber }
      smsMarketingConsent { marketingState }
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
  barcode
  title
  price
  image { url }
  product {
    id
    title
    vendor
    productType
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
    { key: "requested_at", name: "Requested at", type: "date_time" },
    { key: "notified_at", name: "Notified at", type: "date_time" },
    { key: "available_at_notify", name: "Available when notified", type: "number_integer" },
    text("staff_id", "Staff member ID"),
  ],
};

// ─── Module ──────────────────────────────────────────────────────────────────

export function registerRestock(app, { graphql, requirePosAuth, rateLimit, safeEqual }) {
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY || "";
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
      email: c.defaultEmailAddress?.emailAddress || null,
      emailState: c.defaultEmailAddress?.marketingState || null,
      phone: c.defaultPhoneNumber?.phoneNumber || null,
      smsState: c.smsMarketingConsent?.marketingState || null,
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
  });

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
      barcode: v.barcode || "",
      productTitle: v.product?.title || "",
      variantTitle: cleanVariantTitle(v.title),
      vendor: v.product?.vendor || "",
      productType: v.product?.productType || "",
      price: v.price || "",
      image: v.image?.url || v.product?.featuredMedia?.preview?.image?.url || "",
      url: v.product?.onlineStoreUrl || "",
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

  // Fill in a missing email or phone. Existing values are never replaced from the POS.
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
      if (email) {
        if (current.email) return res.status(409).json({ error: "This customer already has an email address" });
        input.email = email;
      }
      if (phone) {
        if (current.phone) return res.status(409).json({ error: "This customer already has a phone number" });
        input.phone = phone;
      }
      try {
        await gqlChecked(CUSTOMER_UPDATE, { input }, "customerUpdate");
      } catch (err) {
        if (err.userErrors) return res.status(400).json({ error: err.message });
        throw err;
      }
      console.log(`[restock] contact added for customer ${customerId} (${Object.keys(input).filter((k) => k !== "id").join(", ")}) by ${req.posUser}`);
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
        return { status: 200, body: { ok: true, added, updated, store: location.name, channel } };
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

  async function sendKlaviyoEvent({ customer, channel, requestedChannel, location, items }) {
    if (!KLAVIYO_API_KEY) throw new Error("KLAVIYO_API_KEY not set");
    const profile = channel === "sms"
      ? { phone_number: customer.phone, first_name: customer.firstName, last_name: customer.lastName }
      : { email: customer.email, first_name: customer.firstName, last_name: customer.lastName };
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
            items_short: itemsShort(items),
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
          if (channel === "sms" && customer.smsState !== "SUBSCRIBED") {
            if (customer.email) {
              channel = "email";
              summary.skipped.push(`customer ${customerId} not subscribed to SMS → notified by email instead`);
            } else {
              summary.skipped.push(`customer ${customerId} not subscribed to SMS and has no email (kept pending)`);
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
            image_url: variant.image,
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
}
