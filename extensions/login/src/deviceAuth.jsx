// Backend calls for the Hera POS tiles (identical copy in extensions/login, extensions/giftcard and
// extensions/restock: change all three together).
//
// Deliberately the same plain fetch as the version that worked before the iPad-pairing changes:
// one fetch, then resp.json(); no AbortController, no Promise.race, no extra timers.
//
// Every request carries the Shopify ID token of the account logged in on the POS app. Shopify issues
// it only when that account's role gives access to this app. Without it the backend answers 401 and
// the tile shows NO_ACCESS_MESSAGE.

// Shared Hera_POS_aid backend (Render). Do not change: Apple Wallet cards also point here.
export const SERVER_URL = "https://search-0wf4.onrender.com";

export const NO_ACCESS_MESSAGE =
  'This POS account cannot use this tile. In Shopify admin → Settings → Users, give the role of the account logged in on this iPad access to the app "Hera_POS_aid".';

export class NoAppAccess extends Error {
  constructor() {
    super(NO_ACCESS_MESSAGE);
    this.name = 'NoAppAccess';
  }
}

let tokenState = 'unknown'; // for the server log only

async function authHeaders() {
  // Shopify-signed ID token, fresh for every request (same as before the pairing changes).
  try {
    const token = await shopify.session.getSessionToken();
    tokenState = token ? 'ok' : 'empty';
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch (err) {
    tokenState = `error(${String(err?.message || err).slice(0, 120)})`;
    return {};
  }
}

function sessionInfo() {
  try {
    const s = shopify.session?.currentSession || {};
    return { userId: s.userId ?? null, diag: { token: tokenState, staffMemberId: s.staffMemberId ?? null, locationId: s.locationId ?? null, posVersion: s.posVersion ?? null } };
  } catch {
    return {};
  }
}

// ─── Diagnostics: a few events written to the server log as "[pos-ui] …" (no personal data) ───
let tileName = 'tile';
export function setTileName(name) { tileName = name; }
export function report(event, detail) {
  try {
    const line = `${event}${detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`.slice(0, 500);
    fetch(`${SERVER_URL}/api/pos/clientlog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tile: tileName, line, userId: sessionInfo().userId ?? null }),
    }).then((r) => r.text()).catch(() => {});
  } catch { /* never break the tile for a log line */ }
}

/**
 * POST JSON to the backend with the POS account's Shopify token.
 * Returns { resp, data }. Throws NoAppAccess when the backend refuses the account.
 */
export async function postJson(path, body) {
  const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) };
  let resp;
  try {
    resp = await fetch(`${SERVER_URL}${path}`, {
      method: 'POST',
      headers,
      // userId / diag only help reading the server logs; the server trusts the token, not these values
      body: JSON.stringify({ ...(body ?? {}), ...sessionInfo() }),
    });
  } catch {
    throw new Error('Network error, please try again.');
  }
  let data = null;
  try { data = await resp.json(); } catch { /* non-JSON response */ }
  if (resp.status === 401) throw new NoAppAccess();
  return { resp, data };
}
