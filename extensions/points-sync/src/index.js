// Points on receipt: background POS extension (pos.app.ready.data, API 2026-07). No tile, no screen.
//
// When the cart has a customer and items, and has not changed for a moment, the cart is sent to
// the backend (/api/points/preview). The backend reads the customer's Smile balance, estimates
// this sale's points and writes them on the customer; the receipt's custom Liquid block prints them.
// Backend + rules: points.js.
//
// DEBUG = true during tests: short lines in the Render log, "[pos-ui] points …" (no personal data).

const SERVER_URL = "https://search-0wf4.onrender.com";
const DEBUG = true;
const VERSION = "debug 1";
const WAIT_MS = 1200;            // send once the cart has been still this long
const RUN = Math.random().toString(36).slice(2, 7); // a new id means POS restarted this extension

let timer = null;
let lastSent = "";
let sending = Promise.resolve();

function session() {
  try { return shopify.session.currentSession || {}; } catch { return {}; }
}

function log(line) {
  if (!DEBUG) return;
  fetch(`${SERVER_URL}/api/pos/clientlog`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tile: "points", line: `${VERSION} run ${RUN} ${line}`, userId: String(session().userId ?? "") }),
  }).catch(() => {});
}

function payloadOf(cart) {
  const customerId = cart?.customer?.id;
  const lines = cart?.lineItems || [];
  if (!customerId || !lines.length) return null;
  return {
    customerId: String(customerId),
    locationId: String(session().locationId ?? ""),
    lines: lines.map((l) => ({
      variantId: l.variantId ?? null,
      productId: l.productId ?? null,
      quantity: l.quantity,
      price: l.price ?? 0,
      isGiftCard: Boolean(l.isGiftCard),
      allocations: (l.discountAllocations || []).map((a) => Number(a?.allocatedAmount?.amount) || 0),
    })),
    subtotal: cart.subtotal,
    taxTotal: cart.taxTotal,
    grandTotal: cart.grandTotal,
  };
}

async function send(payload) {
  const started = Date.now();
  try {
    let token = null;
    try { token = await shopify.session.getSessionToken(); } catch { /* none */ }
    const resp = await fetch(`${SERVER_URL}/api/points/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ ...payload, seq: Date.now() }),
    });
    let data = null;
    try { data = await resp.json(); } catch { /* not JSON */ }
    if (!resp.ok) {
      lastSent = ""; // try again on the next cart change
      log(`preview failed ${resp.status} ${data?.error ?? ""} token ${token ? "yes" : "no"}`);
      return;
    }
    log(`preview ok in ${Date.now() - started} ms · lines ${payload.lines.length} · total ${payload.grandTotal} · tax ${payload.taxTotal} · earned ${data?.earned ?? "?"}`);
  } catch (e) {
    lastSent = "";
    log(`preview error ${e?.message || e}`);
  }
}

function onCart(cart) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const payload = payloadOf(cart);
    if (!payload) return;
    const key = JSON.stringify(payload);
    if (key === lastSent) return;
    lastSent = key;
    sending = sending.then(() => send(payload)); // one request at a time
  }, WAIT_MS);
}

export default async function extension() {
  const s = session();
  log(`started · location ${s.locationId ?? "?"} · POS ${s.posVersion ?? "?"}`);
  try {
    shopify.cart.current.subscribe(onCart);
    if (shopify.cart.current.value) onCart(shopify.cart.current.value);
  } catch (e) {
    log(`cart subscribe failed: ${e?.message || e}`);
  }
  if (DEBUG) {
    try {
      shopify.addEventListener("transactioncomplete", (event) => {
        log(`transaction complete · ${event?.transactionType ?? "?"}`);
      });
    } catch { /* not available */ }
  }
}
