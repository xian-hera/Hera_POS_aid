// Backend calls for the Hera POS tiles (identical copy in extensions/login, extensions/giftcard and
// extensions/restock: change all three together).
//
// Every request carries the Shopify ID token of the account logged in on the POS app. Shopify issues
// it only when that account's role gives access to this app (Shopify admin → Settings → Users →
// the user's role → Apps). Without it the backend answers 401 and the tile shows NO_ACCESS_MESSAGE.

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

// POS calls can stay unanswered: never wait for ever.
function withTimeout(call, ms, fallback) {
  return Promise.race([
    Promise.resolve().then(call).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// Requests made at the same time share one token request.
// tokenState (sent to the server logs): ok | empty (Shopify gave none) | error (Shopify refused) | timeout
let tokenInFlight = null;
let tokenState = 'unknown';
function sessionToken() {
  if (!tokenInFlight) {
    tokenInFlight = new Promise((resolve) => {
      const timer = setTimeout(() => { tokenState = 'timeout'; resolve(null); }, 8000);
      Promise.resolve()
        .then(() => shopify.session.getSessionToken())
        .then((t) => {
          clearTimeout(timer);
          const ok = typeof t === 'string' && t.length > 0;
          tokenState = ok ? 'ok' : `empty(${t === undefined ? 'undefined' : t === null ? 'null' : typeof t})`;
          resolve(ok ? t : null);
        })
        .catch((err) => {
          clearTimeout(timer);
          tokenState = `error(${String(err?.message || err).slice(0, 120)})`;
          resolve(null);
        });
    }).finally(() => { tokenInFlight = null; });
  }
  return tokenInFlight;
}

function diagnostics() {
  const s = (() => { try { return shopify.session?.currentSession || {}; } catch { return {}; } })();
  return { token: tokenState, staffMemberId: s.staffMemberId ?? null, locationId: s.locationId ?? null, posVersion: s.posVersion ?? null };
}

function currentUserId() {
  try { return shopify.session?.currentSession?.userId ?? null; } catch { return null; }
}

async function send(path, body, headers) {
  // Hard 20-second limit, so a tile never shows "Loading…" for ever.
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { controller?.abort(); } catch { /* ignore */ }
      reject(new Error('The server did not answer, please try again.'));
    }, 20000);
  });
  const request = fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
    ...(controller ? { signal: controller.signal } : {}),
  }).catch((err) => {
    throw new Error(err?.name === 'AbortError' ? 'The server did not answer, please try again.' : 'Network error, please try again.');
  });
  request.catch(() => {}); // a late failure after the time limit is not reported twice
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST JSON to the backend with the POS account's Shopify token.
 * Returns { resp, data }. Throws NoAppAccess when the backend refuses the account.
 */
export async function postJson(path, body) {
  const token = await sessionToken();
  // userId / diag only help reading the server logs; the server trusts the token, not these values
  const resp = await send(path, { ...(body ?? {}), userId: currentUserId(), diag: diagnostics() }, token ? { Authorization: `Bearer ${token}` } : {});
  let data = null;
  try { data = await withTimeout(() => resp.json(), 20000, null); } catch { /* non-JSON response */ }
  if (resp.status === 401) throw new NoAppAccess();
  return { resp, data };
}
