// Points on the POS receipt (Hera Points)
// ─────────────────────────────────────────────────────────────────────────────
// The background POS extension "points-sync" sends the cart here whenever it changes (customer
// attached, items, discounts). For customers handled by Hera Points (all of them once
// POINTS_SOURCE=hc; before that only HC_TEST_CUSTOMER_IDS) we read the balance and ask Hera Points
// to estimate the points of this cart, then write them on the customer, where the receipt's custom
// Liquid block reads them:
//
//   custom.receipt_points_before    balance when the cart was last changed
//   custom.receipt_points_earned    points this cart should earn (Hera Points estimate)
//   custom.receipt_points_total     before + earned  (printed on the receipt)
//   custom.receipt_points_subtotal  the cart's pre-tax amount in cents (-1 = "no estimate")
//   custom.receipt_points_paid      the same amount as text, e.g. "18.98", and
//   custom.receipt_points_paid_num  as a decimal number: the receipt prints the total only when one
//                                   of them equals {{ order.subtotal_price }} (prints "18.98");
//                                   otherwise (old receipt reprinted, cart changed at the last
//                                   second) it prints nothing.
//
// All earning rules (discounts, no tax, compare-at prices, gift cards, campaigns, rounding) are
// applied by Hera Points: we only send each line's unit price, quantity and discount total.
// Other customers are skipped. custom.points_balance is never written here.

const NS = "custom";
const KEYS = {
  before: "receipt_points_before",
  earned: "receipt_points_earned",
  total: "receipt_points_total",
  subtotal: "receipt_points_subtotal",
  paid: "receipt_points_paid",
  paidNum: "receipt_points_paid_num",
};
const TYPES = { paid: "single_line_text_field", paidNum: "number_decimal" }; // the others: number_integer
const DEFINITIONS = [
  { key: KEYS.before, name: "Receipt points: balance before", description: "Points balance read when the POS cart last changed (Hera_POS_aid, receipt only)" },
  { key: KEYS.earned, name: "Receipt points: earned", description: "Estimated points of the POS cart (Hera_POS_aid, receipt only)" },
  { key: KEYS.total, name: "Receipt points: total", description: "Balance before + estimated points, printed on the POS receipt (Hera_POS_aid)" },
  { key: KEYS.subtotal, name: "Receipt points: cart subtotal", description: "Pre-tax amount of that cart in cents; the receipt compares it with the order (Hera_POS_aid)" },
  { key: KEYS.paid, type: TYPES.paid, name: "Receipt points: cart subtotal (text)", description: "Pre-tax amount of that cart, e.g. 18.98; the receipt compares it with the order (Hera_POS_aid)" },
  { key: KEYS.paidNum, type: TYPES.paidNum, name: "Receipt points: cart subtotal (number)", description: "Pre-tax amount of that cart as a number; the receipt compares it with the order (Hera_POS_aid)" },
];
// "No estimate": nothing on the receipt can match any order
const NO_ESTIMATE = { subtotal: -1, paid: "none", paidNum: "-1" };

const isNumericId = (v) => /^\d{1,20}$/.test(String(v ?? ""));
const gid = (kind, id) => `gid://shopify/${kind}/${id}`;
const round2 = (n) => Math.round(n * 100) / 100;
const cents = (n) => Math.round(n * 100);

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

/**
 * Discount total of each line, for the Hera Points estimate.
 * lines: [{ quantity, price, allocations: [amount...] }], paid = amount before tax (grand total − tax).
 * Discounts POS already split per line are used as they are; the rest (e.g. an order discount)
 * is shared between the lines in proportion to their amounts.
 */
export function lineDiscounts(lines, paid) {
  const gross = lines.map((l) => Math.max(0, (Number(l.price) || 0) * (Number(l.quantity) || 0)));
  const grossTotal = gross.reduce((a, b) => a + b, 0);
  const allocated = lines.map((l) => (l.allocations || []).reduce((a, b) => a + (Number(b) || 0), 0));
  const allocatedTotal = allocated.reduce((a, b) => a + b, 0);
  const rest = Math.max(0, Math.max(0, grossTotal - paid) - allocatedTotal);
  return lines.map((l, i) => {
    const share = grossTotal > 0 ? rest * (gross[i] / grossTotal) : 0;
    return round2(Math.min(gross[i], allocated[i] + share));
  });
}

export function registerPoints(app, { graphql, requirePosAuth, rateLimit, hp }) {
  async function gqlChecked(query, variables, rootField) {
    const data = await graphql(query, variables);
    const errs = data?.[rootField]?.userErrors || [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
    return data[rootField];
  }

  async function writeReceipt(customerId, values) {
    await gqlChecked(
      `mutation PointsReceipt($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
      }`,
      {
        metafields: Object.entries(values).map(([k, v]) => ({
          ownerId: gid("Customer", customerId), namespace: NS, key: KEYS[k], type: TYPES[k] || "number_integer", value: String(v),
        })),
      },
      "metafieldsSet"
    );
  }

  // One request at a time per customer, newest cart wins (two iPads, quick cart changes).
  const chains = new Map();
  const latestSeq = new Map();
  const lastEstimate = new Map(); // customerId → { sig (items of the cart), paid, at }
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
    if (!hp.usesHC(customerId)) return res.json({ skipped: "receipt points not enabled for this customer" });
    const seq = Number(b.seq) || Date.now();
    if (seq > (latestSeq.get(customerId) || 0)) latestSeq.set(customerId, seq);

    try {
      const result = await perCustomer(customerId, async () => {
        if (seq < (latestSeq.get(customerId) || 0)) return { skipped: "newer cart" };

        const lines = b.lines.slice(0, 300).map((l) => ({
          variantId: isNumericId(l?.variantId) ? String(l.variantId) : "",
          quantity: Math.max(0, Math.min(10000, Number(l?.quantity) || 0)),
          price: Math.max(0, Number(l?.price) || 0),
          allocations: Array.isArray(l?.allocations) ? l.allocations.slice(0, 20).map((a) => Math.max(0, Number(a) || 0)) : [],
        }));
        const grand = parseMoney(b.grandTotal);
        const tax = parseMoney(b.taxTotal) ?? 0;
        if (grand === null) throw new Error(`unreadable total "${String(b.grandTotal).slice(0, 20)}"`);
        const paid = Math.max(0, grand - tax);
        // When a payment is taken (store credit, cash, card…), POS reports the amount still due as the
        // cart total: it drops to 0 (below the tax) although the items are unchanged. The cart
        // "subtotal" can't be used instead (it is before some discounts: 3.99 for a 3.60 sale).
        // So keep the estimate written for these same items; if there is none, clear it.
        const gross = lines.reduce((a, l) => a + l.price * l.quantity, 0);
        const allocated = lines.reduce((a, l) => a + l.allocations.reduce((x, y) => x + y, 0), 0);
        const sig = JSON.stringify(lines);
        const paymentApplied = grand + 0.005 < tax || (paid < 0.005 && gross >= 0.01 && allocated < 0.005);
        if (paymentApplied) {
          const last = lastEstimate.get(customerId);
          if (last && last.sig === sig) {
            console.log(`[points] customer ${customerId}: payment in progress, estimate for these items kept (paid before tax ${last.paid})`);
            return { skipped: "payment in progress" };
          }
          console.log(`[points] customer ${customerId}: payment in progress but no estimate for these items, receipt points cleared · grand ${String(b.grandTotal).slice(0, 20)} · tax ${String(b.taxTotal).slice(0, 20)} · subtotal ${String(b.subtotal).slice(0, 20)}`);
          lastEstimate.delete(customerId);
          await writeReceipt(customerId, NO_ESTIMATE);
          return { skipped: "payment in progress, no estimate" };
        }
        const discounts = lineDiscounts(lines, paid);

        // Custom sales (no variant) are not sent: Hera Points needs a product variant.
        const hcLines = lines
          .map((l, i) => ({ variantId: Number(l.variantId), quantity: l.quantity, price: l.price, discount: discounts[i] }))
          .filter((l) => l.variantId && l.quantity > 0)
          .slice(0, 250);

        const [before, est] = await Promise.all([
          hp.getBalance(customerId),
          hcLines.length ? hp.estimate({ customerId, channel: "pos", lines: hcLines }) : Promise.resolve({ points: 0, eligibleAmount: 0 }),
        ]);
        if (seq < (latestSeq.get(customerId) || 0)) return { skipped: "newer cart" };
        const values = {
          before, earned: est.points, total: before + est.points,
          subtotal: cents(paid), paid: paid.toFixed(2), paidNum: paid.toFixed(2),
        };
        await writeReceipt(customerId, values);
        lastEstimate.set(customerId, { sig, paid: values.paid, at: Date.now() });
        console.log(
          `[points] customer ${customerId}: ${before} + ${est.points} = ${before + est.points} ` +
          `(paid before tax ${paid.toFixed(2)}, eligible ${est.eligibleAmount.toFixed(2)}, ${hcLines.length}/${lines.length} lines sent) at location ${b.locationId ?? "?"}`
        );
        return values;
      });
      return res.json(result);
    } catch (err) {
      console.error(`[points] customer ${customerId} failed: ${err.message}`);
      // No estimate: the receipt prints nothing for points
      if (seq >= (latestSeq.get(customerId) || 0)) writeReceipt(customerId, NO_ESTIMATE).catch(() => {});
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
          { definition: { ownerType: "CUSTOMER", namespace: NS, key: d.key, name: d.name, description: d.description, type: d.type || "number_integer" } },
          "metafieldDefinitionCreate"
        );
        console.log(`[points] created customer metafield definition ${NS}.${d.key}`);
      }
      console.log("[points] receipt points ready (Hera Points)");
    } catch (err) {
      console.error("[points] setup failed:", err.message);
    }
  })();
}
