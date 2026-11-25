import "@shopify/ui-extensions/preact";
import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';

// Demo Wig Discount
// ─────────────────────────────────────────────────────────────────────────────
// A button in the cart line item menu, only for products whose Product type is WIG (any case).
// POS shows the extension's description ("Demo Wig -10%") as the button label: the label cannot
// change, so the same button applies AND cancels; a toast says which one happened.
//
//   Apply  → 10% off ONE unit of this line. POS item discounts always cover the whole line, so:
//            • quantity 1: a 10% discount;
//            • quantity 2+: a fixed amount per unit whose total equals 10% of one unit
//              (e.g. $200 × 2 → $10.00 per unit = $20 in total). It must be re-applied if the
//              quantity changes afterwards.
//            A manual item discount already on the line is kept: both become one discount with the
//            same effect, titled "Demo Wig -10% + <old title>". Order (cart) discounts stack normally.
//            (Splitting one unit into its own line did not work: POS merged it back, debug 1.)
//   Cancel → when the line has the hidden property `_demo_wig`: puts back the previous item discount
//            (or none). Underscore properties are not printed on receipts.
//
// DEBUG = true while testing: short lines in the Render log, "[pos-ui] demo-wig …" (no customer data).

const SERVER_URL = "https://search-0wf4.onrender.com";
const DEBUG = true;
const TITLE = 'Demo Wig -10%';
const PERCENT = 10;
const PROP = '_demo_wig';

export default async () => {
  render(<Extension />, document.body);
};

function log(line) {
  if (!DEBUG) return;
  let userId = '';
  try { userId = String(shopify.session.currentSession.userId ?? ''); } catch { /* ignore */ }
  fetch(`${SERVER_URL}/api/pos/clientlog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tile: 'demo-wig', line: String(line).slice(0, 480), userId }),
  }).catch(() => {});
}

const round2 = (n) => Math.round(n * 100) / 100;

// The current state of the selected line (it changes after our own updates).
function currentLine(uuid) {
  try {
    return shopify.cart.current.value?.lineItems?.find((l) => l.uuid === uuid) || shopify.cartLineItem;
  } catch {
    return shopify.cartLineItem;
  }
}

// The manual item discount already on the line, if any: { type, amount, title }
function manualDiscountOf(line) {
  const d = (line?.discounts || []).find((x) => x && (x.type === 'Percentage' || x.type === 'FixedAmount'));
  if (!d) return null;
  return { type: d.type, amount: Number(d.amount) || 0, title: d.discountDescription || '' };
}

// Demo Wig (10% off one unit) on top of the previous manual discount, as ONE line discount.
export function demoDiscount(prev, unitPrice, quantity) {
  const price = Number(unitPrice) || 0;
  const qty = Math.max(1, Number(quantity) || 1);
  const hasPrev = Boolean(prev && prev.amount > 0);
  const title = (hasPrev ? `${TITLE} + ${prev.title || 'discount'}` : TITLE).slice(0, 60);
  if (qty === 1) {
    if (!hasPrev) return { type: 'Percentage', amount: String(PERCENT), title };
    if (prev.type === 'Percentage') {
      const pct = 100 - (100 - Math.min(prev.amount, 100)) * (1 - PERCENT / 100);
      return { type: 'Percentage', amount: String(round2(pct)), title };
    }
  }
  // Fixed amount per unit (POS applies it to every unit of the line)
  const prevPerUnit = !hasPrev ? 0
    : prev.type === 'Percentage' ? price * Math.min(prev.amount, 100) / 100
    : Math.min(prev.amount, price);
  const demoTotal = Math.max(0, price - prevPerUnit) * (PERCENT / 100); // 10% of ONE unit
  const perUnit = Math.min(price, prevPerUnit + demoTotal / qty);
  return { type: 'FixedAmount', amount: round2(perUnit).toFixed(2), title };
}

function Extension() {
  const uuid = shopify.cartLineItem?.uuid;
  const [line, setLine] = useState(() => currentLine(uuid));
  const [isWig, setIsWig] = useState(null); // null = still checking
  const [busy, setBusy] = useState(false);

  // Keep the line up to date (quantity, discounts, properties change after taps).
  useEffect(() => {
    let unsubscribe = () => {};
    try {
      unsubscribe = shopify.cart.current.subscribe(() => setLine(currentLine(uuid)));
    } catch { /* ignore */ }
    return () => unsubscribe();
  }, [uuid]);

  // Product type = WIG (any case)?
  useEffect(() => {
    const productId = shopify.cartLineItem?.productId;
    if (!productId || !shopify.cartLineItem?.variantId) { setIsWig(false); return; }
    shopify.productSearch.fetchProductWithId(productId)
      .then((p) => setIsWig(String(p?.productType || '').trim().toLowerCase() === 'wig'))
      .catch((e) => { log(`product lookup failed: ${e?.message || e}`); setIsWig(false); });
  }, []);

  if (!isWig || !line) return null;
  const applied = Boolean(line.properties?.[PROP]);

  async function apply() {
    const l = currentLine(uuid);
    const prev = manualDiscountOf(l);
    const disc = demoDiscount(prev, l.price, l.quantity);
    const memo = JSON.stringify(prev ? { t: prev.type, a: String(prev.amount), d: prev.title, q: l.quantity } : { q: l.quantity });
    log(`apply · qty ${l.quantity} · price ${l.price} · discounts ${JSON.stringify(l.discounts || [])} · allocations ${JSON.stringify(l.discountAllocations || [])} → ${disc.type} ${disc.amount}`);
    await shopify.cart.addLineItemProperties(l.uuid, { [PROP]: memo });
    await shopify.cart.setLineItemDiscount(l.uuid, disc.type, disc.title, disc.amount);
    shopify.toast.show(`${TITLE} applied to 1 unit`);
  }

  async function cancel() {
    const l = currentLine(uuid);
    let prev = {};
    try { prev = JSON.parse(l.properties?.[PROP] || '{}') || {}; } catch { prev = {}; }
    log(`cancel · qty ${l.quantity} · discounts ${JSON.stringify(l.discounts || [])} · previous ${JSON.stringify(prev)}`);
    if (prev.t && prev.a) await shopify.cart.setLineItemDiscount(l.uuid, prev.t, prev.d || 'Discount', prev.a);
    else await shopify.cart.removeLineItemDiscount(l.uuid);
    await shopify.cart.removeLineItemProperties(l.uuid, [PROP]);
    shopify.toast.show('Demo Wig discount cancelled');
  }

  async function onClick() {
    if (busy) return;
    setBusy(true);
    try {
      if (applied) await cancel();
      else await apply();
    } catch (e) {
      log(`error: ${e?.message || e}`);
      shopify.toast.show(`${TITLE}: ${e?.message || 'something went wrong'}`);
    } finally {
      setBusy(false);
    }
  }

  // The label comes from the extension description ("Demo Wig -10%"); the text here is not shown.
  return <s-button disabled={busy} onClick={onClick}>{applied ? 'Cancel Demo Wig' : TITLE}</s-button>;
}
