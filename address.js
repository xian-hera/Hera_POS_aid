// Unit number check for online orders
// ─────────────────────────────────────────────────────────────────────────────
// Finds Canadian orders shipped to a multi-unit building (apartments, condos, offices) without a unit
// number, and lets the customer fix it on the Thank you / Order status page (extension "unit-check").
//
// 1. orders/paid webhook (server.js → onOrderPaid), orders not from POS:
//    the address needs a unit → tag "Check unit" (unless the customer already answered, or this
//    customer confirmed earlier that this address has no unit).
// 2. Thank you page → POST /api/unit/status: should the block ask for the unit number?
// Texts of the block: metaobject "Unit No. Alert texts" (Content → Metaobjects), English + French.
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

// Texts of the Thank you page block: one metaobject "unit_alert_text" (handle "default"), edited in
// Shopify admin → Content → Metaobjects. An empty field = the built-in text of the extension (locales/).
const TEXT_TYPE = "unit_alert_text";
const TEXT_HANDLE = "default";
const TEXT_CACHE_MS = 60 * 1000;
const TEXT_KEYS = [
  ["pill", "Pill"],
  ["heading", "Title"],
  ["body", "Text", true],
  ["unit_label", "Unit number field (label)"],
  ["save", "Button: save unit number"],
  ["no_unit", "Button: my address has no unit number"],
  ["confirm_heading", "Confirmation step: title"],
  ["disclaimer", "Confirmation step: text (disclaimer)", true],
  ["confirm", "Confirmation step: confirm button"],
  ["back", "Confirmation step: back button"],
  ["done_unit", "Done: unit saved ({{unit}} = the unit typed)", true],
  ["done_none", "Done: no unit confirmed", true],
  ["invalid_unit", "Error: invalid unit number"],
  ["error", "Error: something went wrong", true],
];
const TEXT_DEFAULTS = {
  pill_en: "Action needed", pill_fr: "Action requise",
  heading_en: "Is your unit number missing?", heading_fr: "Votre numéro d'unité est-il manquant?",
  body_en: "Your shipping address looks like a building with several units (apartment, condo or office). Without a unit number, Canada Post may not be able to deliver your order and it could be returned to us.",
  body_fr: "Votre adresse de livraison semble correspondre à un immeuble à plusieurs unités (appartement, condo ou bureau). Sans numéro d'unité, Postes Canada pourrait ne pas pouvoir livrer votre commande, qui risque alors de nous être retournée.",
  unit_label_en: "Apartment, suite or unit number", unit_label_fr: "Numéro d'appartement, de bureau ou d'unité",
  save_en: "Save unit number", save_fr: "Enregistrer le numéro",
  no_unit_en: "My address has no unit number", no_unit_fr: "Mon adresse n'a pas de numéro d'unité",
  confirm_heading_en: "Please confirm", confirm_heading_fr: "Veuillez confirmer",
  disclaimer_en: "I confirm that my shipping address has no apartment, suite or unit number. I understand that Hera Beauté is not responsible for delays, returns, losses or additional shipping costs resulting from an incomplete address.",
  disclaimer_fr: "Je confirme que mon adresse de livraison n'a pas de numéro d'appartement, de bureau ou d'unité. Je comprends que Hera Beauté n'est pas responsable des retards, retours, pertes ou frais d'expédition supplémentaires résultant d'une adresse incomplète.",
  confirm_en: "Confirm", confirm_fr: "Confirmer",
  back_en: "Back", back_fr: "Retour",
  done_unit_en: "Thank you! Unit {{unit}} was added to your shipping address.", done_unit_fr: "Merci! L'unité {{unit}} a été ajoutée à votre adresse de livraison.",
  done_none_en: "Thank you, your answer was saved. We will ship to the address as entered.", done_none_fr: "Merci, votre réponse a été enregistrée. Nous expédierons à l'adresse telle qu'inscrite.",
  invalid_unit_en: "Please enter a unit number (letters and numbers, 20 characters max).", invalid_unit_fr: "Veuillez entrer un numéro d'unité (lettres et chiffres, 20 caractères maximum).",
  error_en: "Something went wrong. Please try again, or contact us if the problem continues.", error_fr: "Une erreur est survenue. Veuillez réessayer ou nous contacter si le problème persiste.",
};
const TEXT_DEFINITION = {
  type: TEXT_TYPE,
  name: "Unit No. Alert texts",
  description: "Texts of the Thank you / Order status page block \"Unit No. Alert\" (Hera_POS_aid). Edit the entry \"default\". An empty field uses the built-in text. Changes show within a minute.",
  displayNameKey: "heading_en",
  fieldDefinitions: TEXT_KEYS.flatMap(([key, name, multi]) => ["en", "fr"].map((lang) => ({
    key: `${key}_${lang}`,
    name: `${name} (${lang === "en" ? "English" : "French"})`,
    type: multi ? "multi_line_text_field" : "single_line_text_field",
  }))),
};

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

const TEXT_DEFINITION_QUERY = `
  query UnitTextDefinition { metaobjectDefinitionByType(type: "${TEXT_TYPE}") { id fieldDefinitions { key } } }
`;

const TEXT_GET = `
  query UnitTextGet($handle: MetaobjectHandleInput!) { metaobjectByHandle(handle: $handle) { id fields { key value } } }
`;

const DEFINITION_UPDATE = `
  mutation UnitDefinitionUpdate($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
    metaobjectDefinitionUpdate(id: $id, definition: $definition) { metaobjectDefinition { id } userErrors { field message code } }
  }
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

  // ── Block texts (metaobject unit_alert_text / default), cached one minute ──
  let textCache = { at: 0, value: null };
  let textEntryId = "";
  // Shopify admin page of the texts entry (shown under the block preview in the checkout editor).
  const textEditUrl = () => {
    const store = String(process.env.SHOP_DOMAIN || "").replace(/\.myshopify\.com$/, "");
    if (!store) return "";
    return textEntryId
      ? `https://admin.shopify.com/store/${store}/content/metaobjects/entries/${TEXT_TYPE}/${textEntryId}`
      : `https://admin.shopify.com/store/${store}/content/metaobjects/entries/${TEXT_TYPE}`;
  };
  async function blockTexts() {
    if (textCache.value && Date.now() - textCache.at < TEXT_CACHE_MS) return textCache.value;
    try {
      const data = await graphql(TEXT_GET, { handle: { type: TEXT_TYPE, handle: TEXT_HANDLE } });
      const fields = data?.metaobjectByHandle?.fields || [];
      textEntryId = String(data?.metaobjectByHandle?.id || "").split("/").pop();
      const value = { en: {}, fr: {} };
      for (const f of fields) {
        const m = f.key.match(/^(.*)_(en|fr)$/);
        if (m && String(f.value || "").trim()) value[m[2]][m[1]] = String(f.value).trim();
      }
      textCache = { at: Date.now(), value };
    } catch (err) {
      console.warn("[unit] could not read the block texts:", err.message);
      if (!textCache.value) return { en: {}, fr: {} };
    }
    return textCache.value;
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
      const show = Boolean(ev.needsUnit && !exempt);
      res.json({ show, ...(show ? { text: await blockTexts() } : {}) });
    } catch (err) {
      console.error("[unit] status error:", err.message);
      res.status(500).json({ error: "Please try again" });
    }
  });

  // ── Checkout editor preview: only the texts (there is no real order there) ──
  app.post("/api/unit/texts", limiter, async (req, res) => {
    if (!auth(req, res)) return;
    const text = await blockTexts();
    res.json({ text, editUrl: textEditUrl() });
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

  // Texts definition + the "default" entry, filled with the built-in texts the first time.
  async function setupTexts() {
    const data = await graphql(TEXT_DEFINITION_QUERY, {});
    const def = data.metaobjectDefinitionByType;
    if (!def) {
      await gqlChecked(EXEMPT_DEFINITION_CREATE, { definition: TEXT_DEFINITION }, "metaobjectDefinitionCreate");
      console.log(`[unit] created metaobject definition ${TEXT_TYPE}`);
    } else {
      const have = new Set(def.fieldDefinitions.map((f) => f.key));
      const missing = TEXT_DEFINITION.fieldDefinitions.filter((f) => !have.has(f.key));
      if (missing.length) {
        await gqlChecked(DEFINITION_UPDATE, { id: def.id, definition: { fieldDefinitions: missing.map((f) => ({ create: f })) } }, "metaobjectDefinitionUpdate");
        console.log(`[unit] added text fields: ${missing.map((f) => f.key).join(", ")}`);
      }
    }
    const entry = await graphql(TEXT_GET, { handle: { type: TEXT_TYPE, handle: TEXT_HANDLE } });
    if (!entry?.metaobjectByHandle) {
      await gqlChecked(EXEMPT_UPSERT, {
        handle: { type: TEXT_TYPE, handle: TEXT_HANDLE },
        metaobject: { fields: Object.entries(TEXT_DEFAULTS).map(([key, value]) => ({ key, value })) },
      }, "metaobjectUpsert");
      console.log(`[unit] created the texts entry ${TEXT_TYPE}/${TEXT_HANDLE} (edit it in Content → Metaobjects)`);
    }
  }

  // ── Start-up: create the "customer confirmed" metaobject definition if missing ──
  (async () => {
    try {
      const data = await graphql(EXEMPT_DEFINITION_QUERY, {});
      if (!data.metaobjectDefinitionByType) {
        await gqlChecked(EXEMPT_DEFINITION_CREATE, { definition: EXEMPT_DEFINITION }, "metaobjectDefinitionCreate");
        console.log(`[unit] created metaobject definition ${EXEMPT_TYPE}`);
      }
      await setupTexts();
      console.log(`[unit] ready${nar ? "" : " (NAR data missing: checks are off)"}`);
    } catch (err) {
      console.error("[unit] setup failed:", err.message);
    }
  })();

  return { onOrderPaid };
}
