// Unit number check for online orders
// ─────────────────────────────────────────────────────────────────────────────
// Finds Canadian orders shipped to a multi-unit building (apartments, condos, offices) without a unit
// number, and lets the customer fix it on the Thank you / Order status page (extension "unit-check").
//
// 1. orders/paid webhook (server.js → onOrderPaid), orders not from POS:
//    the address needs a unit → tag "Check unit" (unless the customer already answered, or this
//    customer confirmed earlier that this address has no unit).
// 2. Thank you page → POST /api/unit/status: should the block ask for the unit number?
// 3. Customer answers → POST /api/unit/answer:
//      unit given  → written to the order's shipping address line 2, tag "Check unit" → "Unit added by customer"
//      no unit     → tag "Check unit" → "No unit (customer confirmed)" and the customer + address is
//                    remembered (metaobject unit_exemption), so the same customer is not asked again.
//
// "Needs a unit" (nar.js, Statistics Canada National Address Register):
//   multi      the building has 2+ units
//   not-found  NAR does not know the civic address (often a new building)
//   unsure     several buildings share postal code + civic number and the street does not tell which
// A unit counts as given when address line 2 is not empty, or line 1 contains "12-345 …", "#12",
// "apt / app / unit / suite / ste / bureau / logement / log 12" or similar.

import crypto from "crypto";
import { loadNar } from "./nar.js";
import { normPostal, parseCivic } from "./nar-normalize.js";

const UNIT_WORDS = /(^|[\s,])(#\s*\w+|(apt|apartment|app|appartement|unit|unité|unite|suite|ste|bureau|bur|logement|log|room|rm|porte|penthouse|ph)\.?\s*#?\s*\w*\d\w*)/i;
const UNIT_DASH_CIVIC = /^\s*([a-z]?\d+[a-z]?|[a-z])\s*[-–]\s*\d+/i; // "12-345 Main St", "A-345 …", "12 - 345 …"

/** Does the address already carry a unit? */
export function unitGiven(address1, address2) {
  if (String(address2 ?? "").trim()) return { given: true, how: "address line 2" };
  const a1 = String(address1 ?? "");
  if (UNIT_DASH_CIVIC.test(a1)) return { given: true, how: "unit-civic in line 1" };
  if (UNIT_WORDS.test(a1)) return { given: true, how: "unit word in line 1" };
  return { given: false };
}

export const TAG_CHECK = "Check unit";
export const TAG_ADDED = "Unit added by customer";
export const TAG_NONE = "No unit (customer confirmed)";
const ANSWER_TAGS = [TAG_ADDED, TAG_NONE];
const NEEDS_UNIT = new Set(["multi", "not-found", "unsure"]);
const ANSWER_DAYS = 14; // the Order status page can still ask during this time
const OPEN_FULFILLMENT = new Set(["UNFULFILLED", "OPEN", "ON_HOLD", "SCHEDULED", "PENDING_FULFILLMENT", "REQUEST_DECLINED"]);
const EXEMPT_TYPE = "unit_exemption";
const MAX_UNIT = 20;

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const ORDER_QUERY = `
  query UnitOrder($id: ID!) {
    order(id: $id) {
      id
      name
      email
      createdAt
      cancelledAt
      confirmationNumber
      sourceName
      displayFulfillmentStatus
      tags
      shippingAddress { firstName lastName company address1 address2 city provinceCode countryCodeV2 zip phone }
    }
  }
`;

const ORDER_UPDATE = `
  mutation UnitOrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) { order { id } userErrors { field message } }
  }
`;

const TAGS_ADD = `
  mutation UnitTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }
`;

const TAGS_REMOVE = `
  mutation UnitTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
  }
`;

const EXEMPT_DEFINITION_QUERY = `
  query UnitExemptDefinition { metaobjectDefinitionByType(type: "${EXEMPT_TYPE}") { id } }
`;

const EXEMPT_DEFINITION_CREATE = `
  mutation UnitExemptDefinitionCreate($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) { metaobjectDefinition { id } userErrors { field message code } }
  }
`;

const EXEMPT_GET = `
  query UnitExemptGet($handle: MetaobjectHandleInput!) { metaobjectByHandle(handle: $handle) { id } }
`;

const EXEMPT_UPSERT = `
  mutation UnitExemptUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) { metaobject { id } userErrors { field message code } }
  }
`;

const EXEMPT_DEFINITION = {
  type: EXEMPT_TYPE,
  name: "Unit number: customer confirmed none",
  description: "A customer confirmed on the Thank you page that this address has no unit number. Written by Hera_POS_aid; delete an entry to ask this customer again.",
  displayNameKey: "address",
  fieldDefinitions: [
    { key: "email", name: "Customer email", type: "single_line_text_field" },
    { key: "address", name: "Address", type: "single_line_text_field" },
    { key: "postal", name: "Postal code", type: "single_line_text_field" },
    { key: "order", name: "Order", type: "single_line_text_field" },
    { key: "confirmed_at", name: "Confirmed at", type: "date_time" },
  ],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const orderGid = (v) => {
  const m = String(v ?? "").match(/(\d{1,20})$/); // gid://shopify/Order/123, gid://shopify/OrderIdentity/123 or 123
  return m ? `gid://shopify/Order/${m[1]}` : null;
};

function cleanUnit(v) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim(); // kept as typed: "12", "Apt 12", "#12"
  if (!s || s.length > MAX_UNIT || !/^[\p{L}\p{N}#][\p{L}\p{N} #\-\/.]*$/u.test(s) || !/\p{N}|^[\p{L}]{1,3}$/u.test(s)) return "";
  return s;
}

// ─── Module ──────────────────────────────────────────────────────────────────

export function registerAddressCheck(app, { graphql, rateLimit, verifyCheckoutToken }) {
  const nar = loadNar();

  async function gqlChecked(query, variables, field) {
    const data = await graphql(query, variables);
    const errors = data?.[field]?.userErrors || [];
    if (errors.length) throw new Error(`${field}: ${errors.map((e) => e.message).join("; ")}`);
    return data[field];
  }

  // One change at a time per order (webhook and customer answer can arrive together).
  const locks = new Map();
  function withLock(id, fn) {
    const run = (locks.get(id) || Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(id, tail);
    tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return run;
  }

  // ── "Customer confirmed: no unit" memory (customer email + postal code + civic number) ──
  const exemptCache = new Map(); // handle → true/false
  const exemptHandle = (email, a) => {
    const key = [String(email || "").trim().toLowerCase(), normPostal(a.zip), parseCivic(a.address1)].join("|");
    return `u-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
  };
  async function isExempt(email, a) {
    if (!email) return false;
    const handle = exemptHandle(email, a);
    if (exemptCache.has(handle)) return exemptCache.get(handle);
    const data = await graphql(EXEMPT_GET, { handle: { type: EXEMPT_TYPE, handle } });
    const found = Boolean(data?.metaobjectByHandle?.id);
    exemptCache.set(handle, found);
    if (exemptCache.size > 5000) exemptCache.delete(exemptCache.keys().next().value);
    return found;
  }
  async function saveExempt(email, a, orderName) {
    if (!email) return;
    const handle = exemptHandle(email, a);
    await gqlChecked(EXEMPT_UPSERT, {
      handle: { type: EXEMPT_TYPE, handle },
      metaobject: {
        fields: [
          { key: "email", value: String(email).trim().toLowerCase() },
          { key: "address", value: `${a.address1}, ${a.city || ""} ${a.provinceCode || ""}`.trim() },
          { key: "postal", value: normPostal(a.zip) },
          { key: "order", value: orderName || "" },
          { key: "confirmed_at", value: new Date().toISOString() },
        ],
      },
    }, "metaobjectUpsert");
    exemptCache.set(handle, true);
  }

  /** Does this shipping address need a unit number? a = { address1, address2, zip, provinceCode, countryCode } */
  function evaluate(a) {
    if (!a || !String(a.address1 ?? "").trim()) return { status: "skipped", reason: "no shipping address" };
    const country = String(a.countryCode ?? "").toUpperCase();
    if (country && country !== "CA") return { status: "skipped", reason: "not in Canada" };
    const given = unitGiven(a.address1, a.address2);
    if (given.given) return { status: "unit-given", how: given.how };
    if (!nar) return { status: "error", reason: "NAR data missing" };
    const r = nar.lookup({ address1: a.address1, zip: a.zip, province: a.provinceCode });
    if (r.status === "no-civic") return { status: "skipped", reason: "no civic number" };
    return { ...r, needsUnit: NEEDS_UNIT.has(r.status) };
  }

  const describe = (ev) => `${ev.status}${ev.units ? ` (${ev.units} units)` : ""}${ev.how ? ` · ${ev.how}` : ""}${ev.reason ? ` · ${ev.reason}` : ""}`;

  async function fetchOrder(id) {
    const data = await graphql(ORDER_QUERY, { id });
    const o = data?.order;
    if (!o) return null;
    const s = o.shippingAddress || null;
    return { ...o, address: s && { ...s, countryCode: s.countryCodeV2 } };
  }

  // ── 1. orders/paid webhook ──
  async function onOrderPaid(payload) {
    if (!nar || String(payload?.source_name || "") === "pos") return;
    const s = payload?.shipping_address;
    if (!s) return;
    const id = payload.admin_graphql_api_id || orderGid(payload.id);
    const name = payload.name || id;
    const a = { address1: s.address1, address2: s.address2, city: s.city, zip: s.zip, provinceCode: s.province_code, countryCode: s.country_code };
    const ev = evaluate(a);
    if (!ev.needsUnit) {
      if (ev.status !== "skipped" || ev.reason !== "not in Canada") console.log(`[unit] ${name}: ${describe(ev)}`);
      return;
    }
    await withLock(id, async () => {
      const email = payload.email || payload.contact_email || "";
      if (await isExempt(email, a)) return console.log(`[unit] ${name}: ${describe(ev)} · customer confirmed no unit before → not tagged`);
      const o = await fetchOrder(id);
      if (!o) return;
      if (o.tags.some((t) => ANSWER_TAGS.includes(t))) return console.log(`[unit] ${name}: customer already answered`);
      if (!o.tags.includes(TAG_CHECK)) await gqlChecked(TAGS_ADD, { id, tags: [TAG_CHECK] }, "tagsAdd");
      console.log(`[unit] ${name}: ${describe(ev)} → tagged "${TAG_CHECK}"`);
    });
  }

  // ── Thank you / Order status page: the request must come from our checkout extension and name
  // the order by its id AND its confirmation number (which only the buyer sees).
  function auth(req, res) {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    try {
      if (!token) throw new Error("no token");
      verifyCheckoutToken(token);
      return true;
    } catch (err) {
      console.warn(`[unit] request refused: ${err.message}`);
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
  }

  async function orderFor(req, res) {
    const id = orderGid(req.body?.orderId);
    const number = String(req.body?.number ?? "").trim();
    if (!id || !number) { res.status(400).json({ error: "orderId and number are required" }); return null; }
    const o = await fetchOrder(id);
    if (!o) { res.json({ pending: true }); return null; } // Thank you page: the order is still being created
    if (!o.confirmationNumber || o.confirmationNumber !== number) {
      console.warn(`[unit] ${o.name}: confirmation number does not match`);
      res.status(404).json({ error: "Order not found" });
      return null;
    }
    return o;
  }

  function canAnswer(o) {
    if (o.cancelledAt) return "cancelled";
    if (!OPEN_FULFILLMENT.has(o.displayFulfillmentStatus)) return "already fulfilled";
    if (Date.now() - new Date(o.createdAt).getTime() > ANSWER_DAYS * 86400000) return "too old";
    if (o.tags.some((t) => ANSWER_TAGS.includes(t))) return "already answered";
    return "";
  }

  const limiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

  // ── 2. Should the block ask? ──
  app.post("/api/unit/status", limiter, async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const o = await orderFor(req, res);
      if (!o) return;
      const answered = o.tags.includes(TAG_ADDED) ? "unit" : o.tags.includes(TAG_NONE) ? "none" : "";
      if (answered) return res.json({ show: false, answered });
      if (canAnswer(o)) return res.json({ show: false });
      const ev = evaluate(o.address);
      const exempt = ev.needsUnit && await isExempt(o.email, o.address);
      res.json({ show: Boolean(ev.needsUnit && !exempt) });
    } catch (err) {
      console.error("[unit] status error:", err.message);
      res.status(500).json({ error: "Please try again" });
    }
  });

  // ── 3. The customer's answer ──
  app.post("/api/unit/answer", limiter, async (req, res) => {
    if (!auth(req, res)) return;
    const choice = req.body?.choice;
    const unit = cleanUnit(req.body?.unit);
    if (choice !== "unit" && choice !== "none") return res.status(400).json({ error: "Invalid choice" });
    if (choice === "unit" && !unit) return res.status(400).json({ error: "invalid-unit" });
    try {
      const pre = await orderFor(req, res);
      if (!pre) return;
      await withLock(pre.id, async () => {
        const o = await fetchOrder(pre.id); // fresh tags and address inside the lock
        const why = canAnswer(o);
        if (why) return res.status(409).json({ error: why });
        const ev = evaluate(o.address);
        if (!ev.needsUnit) return res.status(409).json({ error: "not needed" });

        if (choice === "unit") {
          const s = o.address;
          await gqlChecked(ORDER_UPDATE, {
            input: {
              id: o.id,
              shippingAddress: {
                firstName: s.firstName, lastName: s.lastName, company: s.company,
                address1: s.address1, address2: unit, city: s.city,
                provinceCode: s.provinceCode, countryCode: s.countryCodeV2, zip: s.zip, phone: s.phone,
              },
            },
          }, "orderUpdate");
          await gqlChecked(TAGS_ADD, { id: o.id, tags: [TAG_ADDED] }, "tagsAdd");
        } else {
          await saveExempt(o.email, o.address, o.name);
          await gqlChecked(TAGS_ADD, { id: o.id, tags: [TAG_NONE] }, "tagsAdd");
        }
        if (o.tags.includes(TAG_CHECK)) await gqlChecked(TAGS_REMOVE, { id: o.id, tags: [TAG_CHECK] }, "tagsRemove");
        console.log(`[unit] ${o.name}: customer ${choice === "unit" ? `added unit "${unit}"` : "confirmed no unit"}`);
        res.json({ ok: true });
      });
    } catch (err) {
      console.error("[unit] answer error:", err.message);
      if (!res.headersSent) res.status(500).json({ error: "Please try again" });
    }
  });

  // ── Start-up: create the "customer confirmed" metaobject definition if missing ──
  (async () => {
    try {
      const data = await graphql(EXEMPT_DEFINITION_QUERY, {});
      if (!data.metaobjectDefinitionByType) {
        await gqlChecked(EXEMPT_DEFINITION_CREATE, { definition: EXEMPT_DEFINITION }, "metaobjectDefinitionCreate");
        console.log(`[unit] created metaobject definition ${EXEMPT_TYPE}`);
      }
      console.log(`[unit] ready${nar ? "" : " (NAR data missing: checks are off)"}`);
    } catch (err) {
      console.error("[unit] setup failed:", err.message);
    }
  })();

  return { onOrderPaid };
}
