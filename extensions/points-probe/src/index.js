// Points probe (test only, "probe 1").
// Background POS extension (pos.app.ready.data, API 2026-07): no tile, no screen.
// It answers three questions in the Render log, lines start with "[pos-ui] bg-probe":
//   1. Does it start by itself on each iPad after deploy?      -> "started" line
//   2. Does it see the cart (customer, lines, discounts)?       -> "cart" lines
//   3. Does it survive lock / POS in background, or restart?    -> same or new "run" id
// It also checks that a session token is available here (needed later for the real feature).
// Nothing is written anywhere. Remove this extension after the test.

const SERVER_URL = "https://search-0wf4.onrender.com";
const PROBE = "probe 1";
const RUN = Math.random().toString(36).slice(2, 7); // new id = new runtime (restart)
const T0 = Date.now();

function userId() {
  try { return String(shopify.session.currentSession.userId ?? ""); } catch { return ""; }
}

function send(line) {
  const secs = Math.round((Date.now() - T0) / 1000);
  fetch(`${SERVER_URL}/api/pos/clientlog`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tile: "bg-probe", line: `${PROBE} run ${RUN} +${secs}s ${line}`, userId: userId() }),
  }).catch(() => {});
}

function cartSummary(cart) {
  if (!cart) return "no cart";
  const lines = cart.lineItems || [];
  const first = lines[0];
  const firstInfo = first
    ? ` · line1 price ${first.price} qty ${first.quantity} variant ${first.variantId ?? "-"} giftcard ${first.isGiftCard} discounts ${(first.discounts || []).length} allocations ${(first.discountAllocations || []).length}`
    : "";
  return `customer ${cart.customer?.id ?? "none"} · lines ${lines.length} · subtotal ${cart.subtotal} · tax ${cart.taxTotal} · total ${cart.grandTotal} · cart discounts ${(cart.cartDiscounts || []).length}${firstInfo}`;
}

export default async function extension() {
  let session = {};
  try { session = shopify.session.currentSession || {}; } catch {}
  let token = "no";
  try { token = (await shopify.session.getSessionToken()) ? "yes" : "empty"; } catch (e) { token = `error ${e?.message || e}`; }
  send(`started · location ${session.locationId ?? "?"} · staff ${session.staffMemberId ?? "?"} · POS ${session.posVersion ?? "?"} · token ${token}`);

  // Cart: report once it has been still for 1.5 s (adding items fires many updates).
  let timer = null;
  try {
    shopify.cart.current.subscribe((cart) => {
      clearTimeout(timer);
      timer = setTimeout(() => send(`cart · ${cartSummary(cart)}`), 1500);
    });
  } catch (e) {
    send(`cart subscribe failed: ${e?.message || e}`);
  }

  // Sale finished: shows how soon after payment this fires (the receipt prints about then).
  try {
    shopify.addEventListener("transactioncomplete", (event) => {
      send(`transaction complete · type ${event?.transactionType ?? "?"} · keys ${Object.keys(event || {}).join(",").slice(0, 200)}`);
    });
  } catch (e) {
    send(`transaction listener failed: ${e?.message || e}`);
  }
}
