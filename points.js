// Points on the POS receipt
// ─────────────────────────────────────────────────────────────────────────────
// The background POS extension "points-sync" sends the cart here whenever it changes (customer
// attached, items, discounts). We read the customer's Smile balance, estimate the points this
// cart earns, and write them on the customer, where the receipt's custom Liquid block reads them:
//
//   custom.receipt_points_before    Smile balance when the cart was last changed
//   custom.receipt_points_earned    points this cart should earn
//   custom.receipt_points_total     before + earned  (printed on the receipt)
//   custom.receipt_points_subtotal  the cart's pre-tax amount in cents. The receipt prints the
//                                   total only when this equals the order's subtotal; otherwise
//                                   (an old receipt reprinted, the cart changed at the last second)
//                                   it prints custom.points_balance instead. -1 = "no estimate".
//
// Smile rule (Nov 2026): 1 point per $1 paid before tax, rounded down; products with a
// compare-at price earn nothing; gift cards earn nothing. Multiplier campaigns: POINTS_MULTIPLIER.
// custom.points_balance (Apple Wallet) is never changed here: it stays the real Smile balance.

import fetch from "node-fetch";

const NS = "custom";
const KEYS = {
  before: "receipt_points_before",
  earned: "receipt_points_earned",
  total: "receipt_points_total",
  subtotal: "receipt_points_subtotal",
};
const DEFINITIONS = [
  { key: KEYS.before, name: "Receipt points: balance before", description: "Smile balance read when the POS cart last changed (Hera_POS_aid, receipt only)" },
  { key: KEYS.earned, name: "Receipt points: earned", description: "Estimated points of the POS cart (Hera_POS_aid, receipt only)" },
  { key: KEYS.total, name: "Receipt points: total", description: "Balance before + estimated points, printed on the POS receipt (Hera_POS_aid)" },
  { key: KEYS.subtotal, name: "Receipt points: cart subtotal", description: "Pre-tax amount of that cart in cents; the receipt compares it with the order (Hera_POS_aid)" },
];

const isNumericId = (v) => /^\d{1,20}$/.test(String(v ?? ""));
const gid = (kind, id) => `gid://shopify/${kind}/${id}`;

// "$1,234.56", "1 234,56 $", "CA$12.00" → 1234.56 (null when unreadable)
export function parseMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let s = String(value ?? "").replace(/[^\d.,-]/g, "");
  if (!s || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? "." : ",";
    s = s.split(dec === "." ? "," : ".").join("");
    if (dec === ",") s = s.replace(",", ".");
  } else if (lastComma >= 0) {
    // "12,50" (decimal) vs "1,234" (thousands)
    s = /,\d{1,2}$/.test(s) ? s.replace(/,(?=\d{1,2}$)/, ".").replace(/,/g, "") : s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const cents = (n) => Math.round(n * 100);

/**
 * Points of a cart.
 * lines: [{ variantId, quantity, price, isGiftCard, allocations: [amount...] }]
 * paid:  amount paid before tax (grand total − tax)
 * excluded(line) → true when the line earns nothing (compare-at price, gift card)
 */
export function estimatePoints({ lines, paid, excluded, multiplier = 1 }) {
  const gross = lines.map((l) => Math.max(0, (Number(l.price) || 0) * (Number(l.quantity) || 0)));
  const grossTotal = gross.reduce((a, b) => a + b, 0);
  const discountTotal = Math.max(0, grossTotal - paid);
  // Discounts POS already split per line; the rest is shared in proportion to the line amounts.
  const allocated = lines.map((l) => (l.allocations || []).reduce((a, b) => a + (Number(b) || 0), 0));
  const allocatedTotal = allocated.reduce((a, b) => a + b, 0);
  const rest = Math.max(0, discountTotal - allocatedTotal);
  let eligible = 0;
  lines.forEach((l, i) => {
    const share = grossTotal > 0 ? rest * (gross[i] / grossTotal) : 0;
    const net = Math.max(0, gross[i] - allocated[i] - share);
    if (!excluded(l)) eligible += net;
  });
  eligible = Math.min(eligible, Math.max(0, paid));
  return { eligible, points: Math.floor(eligible + 1e-6) * multiplier };
}

export function registerPoints(app, { graphql, requirePosAuth, rateLimit, smileApiKey, giftProductId }) {
  const MULTIPLIER = Math.max(1, Number(process.env.POINTS_MULTIPLIER || "1") || 1);

  async function gqlChecked(query, variables, rootField) {
    const data = await graphql(query, variables);
    const errs = data?.[rootField]?.userErrors || [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
    return data[rootField];
  }

  // Compare-at prices change rarely: cached 10 minutes per variant.
  const variantCache = new Map();
  async function loadVariants(ids) {
    const out = new Map();
    const missing = [];
    for (const id of ids) {
      const hit = variantCache.get(id);
      if (hit && Date.now() - hit.at < 10 * 60 * 1000) out.set(id, hit.value);
      else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100);
      const data = await graphql(
        `query PointsVariants($ids: [ID!]!) {
          nodes(ids: $ids) { ... on ProductVariant { id compareAtPrice product { id } } }
        }`,
        { ids: chunk.map((id) => gid("ProductVariant", id)) }
      );
      for (const n of data.nodes || []) {
        if (!n?.id) continue;
        const id = n.id.split("/").pop();
        const compareAt = n.compareAtPrice == null ? null : Number(n.compareAtPrice);
        const value = { hasCompareAt: compareAt !== null && compareAt > 0, productId: n.product?.id?.split("/").pop() || "" };
        variantCache.set(id, { at: Date.now(), value });
        out.set(id, value);
      }
    }
    return out;
  }

  async function smileBalance(email) {
    const resp = await fetch(`https://api.smile.io/v1/customers?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${smileApiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`Smile API ${resp.status}`);
    const data = await resp.json();
    const c = data.customers?.[0];
    return c ? Math.max(0, parseInt(c.points_balance ?? 0, 10) || 0) : 0; // not in Smile yet = 0
  }

  async function writeReceipt(customerId, values) {
    await gqlChecked(
      `mutation PointsReceipt($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
      }`,
      {
        metafields: Object.entries(values).map(([k, v]) => ({
          ownerId: gid("Customer", customerId), namespace: NS, key: KEYS[k], type: "number_integer", value: String(v),
        })),
      },
      "metafieldsSet"
    );
  }

  // One request at a time per customer, newest cart wins (two iPads, quick cart changes).
  const chains = new Map();
  const latestSeq = new Map();
  function perCustomer(customerId, fn) {
    const prev = chains.get(customerId) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    chains.set(customerId, tail);
    tail.then(() => { if (chains.get(customerId) === tail) chains.delete(customerId); });
    return run;
  }

  app.post("/api/points/preview", rateLimit({ windowMs: 60 * 1000, max: 240 }), requirePosAuth, async (req, res) => {
    const b = req.body || {};
    const customerId = String(b.customerId ?? "");
    if (!isNumericId(customerId)) return res.status(400).json({ error: "Invalid customer" });
    if (!Array.isArray(b.lines) || b.lines.length > 300) return res.status(400).json({ error: "Invalid cart" });
    const seq = Number(b.seq) || Date.now();
    if (seq > (latestSeq.get(customerId) || 0)) latestSeq.set(customerId, seq);
    if (!smileApiKey) return res.status(503).json({ error: "SMILE_API_KEY is missing" });

    try {
      const result = await perCustomer(customerId, async () => {
        if (seq < (latestSeq.get(customerId) || 0)) return { skipped: "newer cart" };

        const lines = b.lines.slice(0, 300).map((l) => ({
          variantId: isNumericId(l?.variantId) ? String(l.variantId) : "",
          productId: isNumericId(l?.productId) ? String(l.productId) : "",
          quantity: Math.max(0, Math.min(10000, Number(l?.quantity) || 0)),
          price: Math.max(0, Number(l?.price) || 0),
          isGiftCard: Boolean(l?.isGiftCard),
          allocations: Array.isArray(l?.allocations) ? l.allocations.slice(0, 20).map((a) => Math.max(0, Number(a) || 0)) : [],
        }));
        const grand = parseMoney(b.grandTotal);
        const tax = parseMoney(b.taxTotal) ?? 0;
        if (grand === null) throw new Error(`unreadable total "${String(b.grandTotal).slice(0, 20)}"`);
        const paid = Math.max(0, grand - tax);

        const [customerData, variants] = await Promise.all([
          graphql(`query PointsCustomer($id: ID!) { customer(id: $id) { defaultEmailAddress { emailAddress } } }`, { id: gid("Customer", customerId) }),
          loadVariants([...new Set(lines.map((l) => l.variantId).filter(Boolean))]),
        ]);
        const email = customerData.customer?.defaultEmailAddress?.emailAddress;

        const excluded = (l) => {
          if (l.isGiftCard) return true;
          const v = l.variantId ? variants.get(l.variantId) : null;
          if (v?.hasCompareAt) return true;
          const productId = l.productId || v?.productId || "";
          return Boolean(giftProductId && productId === String(giftProductId));
        };
        const { eligible, points } = estimatePoints({ lines, paid, excluded, multiplier: MULTIPLIER });

        if (!email) {
          await writeReceipt(customerId, { subtotal: -1 });
          return { noEmail: true, earned: points };
        }
        const before = await smileBalance(email);
        if (seq < (latestSeq.get(customerId) || 0)) return { skipped: "newer cart" };
        const values = { before, earned: points, total: before + points, subtotal: cents(paid) };
        await writeReceipt(customerId, values);
        console.log(
          `[points] customer ${customerId}: ${before} + ${points} = ${before + points} ` +
          `(paid before tax ${paid.toFixed(2)}, earning ${eligible.toFixed(2)}, ${lines.length} lines, ` +
          `${lines.filter(excluded).length} excluded${MULTIPLIER > 1 ? `, x${MULTIPLIER}` : ""}) at location ${b.locationId ?? "?"}`
        );
        return values;
      });
      return res.json(result);
    } catch (err) {
      console.error(`[points] customer ${customerId} failed: ${err.message}`);
      // No estimate: the receipt then prints custom.points_balance
      if (seq >= (latestSeq.get(customerId) || 0)) writeReceipt(customerId, { subtotal: -1 }).catch(() => {});
      return res.status(502).json({ error: "Could not estimate points" });
    }
  });

  // Start-up: customer metafield definitions (so they show in the admin; created once)
  (async () => {
    try {
      for (const d of DEFINITIONS) {
        const data = await graphql(
          `query PointsDef($key: String!) { metafieldDefinitions(first: 1, ownerType: CUSTOMER, namespace: "${NS}", key: $key) { nodes { id } } }`,
          { key: d.key }
        );
        if (data.metafieldDefinitions?.nodes?.length) continue;
        await gqlChecked(
          `mutation PointsDefCreate($definition: MetafieldDefinitionInput!) {
            metafieldDefinitionCreate(definition: $definition) { createdDefinition { id } userErrors { field message code } }
          }`,
          { definition: { ownerType: "CUSTOMER", namespace: NS, key: d.key, name: d.name, description: d.description, type: "number_integer" } },
          "metafieldDefinitionCreate"
        );
        console.log(`[points] created customer metafield definition ${NS}.${d.key}`);
      }
      console.log(`[points] ready (multiplier x${MULTIPLIER})`);
    } catch (err) {
      console.error("[points] setup failed:", err.message);
    }
  })();
}
