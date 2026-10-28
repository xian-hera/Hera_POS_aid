// Device pairing (identical copy in extensions/login, extensions/giftcard and extensions/restock).
//
// Shopify only gives a session token to POS accounts that have this app in their permissions, and
// the app cannot be picked there. So an iPad is "paired" once: a manager types the store pairing
// code and the backend registers the iPad's POS device id. Every request carries that id
// (X-Hera-Device-Id), so one pairing covers every tile and every account logged in on the iPad.
// The backend also returns a signed device key, kept in this tile's storage as a second way in
// (X-Hera-Device). The pairing code itself is never stored, and nothing secret is written in this file.
import { useState } from 'preact/hooks';

// Shared Hera_POS_aid backend (Render). Do not change: Apple Wallet cards also point here.
export const SERVER_URL = "https://search-0wf4.onrender.com";
const STORAGE_KEY = 'hera_device_key';

export class PairingRequired extends Error {
  constructor() {
    super('This iPad is not paired yet.');
    this.name = 'PairingRequired';
  }
}

// POS calls can stay unanswered (e.g. a session token for an account without the app permission):
// never wait for ever, fall back after a few seconds.
function withTimeout(call, ms, fallback) {
  return Promise.race([
    Promise.resolve().then(call).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function storedKey() {
  const key = await withTimeout(() => shopify.storage.get(STORAGE_KEY), 3000, null);
  return typeof key === 'string' && key ? key : null;
}

async function forgetKey() {
  await withTimeout(() => shopify.storage.delete(STORAGE_KEY), 3000, null);
}

// Shopify deletes extension storage after 30 days without a write: write the key again
// (once per opening of the tile) so a paired iPad stays paired.
let keyRefreshed = false;
function refreshKey(key) {
  if (keyRefreshed) return;
  keyRefreshed = true;
  withTimeout(() => shopify.storage.set(STORAGE_KEY, key), 3000, null);
}

// Once Shopify refuses a token (account without the app permission), do not ask again while the
// tile is open: every refusal shows a "does not have access" message on the iPad.
let tokenRefusedFor = undefined; // POS account that was refused
let tokenInFlight = null;
async function tokenHeader() {
  const user = shopify.session?.currentSession?.userId ?? null;
  if (tokenRefusedFor !== undefined && tokenRefusedFor === user) return {};
  // Requests made at the same time share one token request (one message on the iPad at most)
  if (!tokenInFlight) {
    tokenInFlight = withTimeout(() => shopify.session.getSessionToken(), 4000, null)
      .finally(() => { tokenInFlight = null; });
  }
  const token = await tokenInFlight;
  if (!token) {
    tokenRefusedFor = user;
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}

// The POS device id (the same for every tile and every account on this iPad)
let deviceIdPromise = null;
function deviceId() {
  deviceIdPromise ||= withTimeout(() => shopify.device.getDeviceId(), 3000, null)
    .then((id) => (id == null || id === '' ? null : String(id)));
  return deviceIdPromise;
}

function who() {
  const s = shopify.session?.currentSession || {};
  return { userId: s.userId ?? null, staffMemberId: s.staffMemberId ?? null, locationId: s.locationId ?? null };
}

async function send(path, body, auth) {
  // Hard 20-second limit: if POS holds the request (it can, for accounts without the app permission),
  // the tile shows an error instead of loading for ever. Does not rely on AbortController alone.
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
    headers: { 'Content-Type': 'application/json', ...auth },
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
 * POST JSON to the backend with this iPad's credentials.
 * Returns { resp, data }. Throws PairingRequired when the backend asks for pairing.
 */
export async function postJson(path, body) {
  const [key, id] = await Promise.all([storedKey(), deviceId()]);
  const idHeader = id ? { 'X-Hera-Device-Id': id } : {};
  let resp;
  if (deviceOnlyRefused) {
    // Already known while this tile is open: the iPad alone is not enough, send the token right away.
    resp = await send(path, body, { ...idHeader, ...(await tokenHeader()) });
  } else {
    // First try as a paired iPad only, so POS does not show "does not have access" messages.
    resp = await send(path, body, { ...idHeader, ...(key ? { 'X-Hera-Device': key } : {}) });
    if (resp.status === 401) {
      deviceOnlyRefused = true;
      // Not paired (or un-paired): forget an old key, try the Shopify session token once.
      if (key) await forgetKey();
      const token = await tokenHeader();
      if (token.Authorization) {
        await discard(resp); // read the refused answer to the end before the next request
        resp = await send(path, body, { ...idHeader, ...token });
      }
    } else if (key && resp.ok) {
      refreshKey(key);
    }
  }
  let data = null;
  try { data = await withTimeout(() => resp.json(), 20000, null); } catch { /* non-JSON response */ }
  if (resp.status === 401 && data?.code === 'PAIRING_REQUIRED') throw new PairingRequired();
  return { resp, data };
}

// The iPad alone (device id / key) was refused once while this tile is open
let deviceOnlyRefused = false;

// Read an unused answer to the end: an unread answer can keep the connection busy, and the
// next requests to the server would then wait for ever.
async function discard(resp) {
  await withTimeout(() => resp.text(), 3000, null);
}

/** Called when a tile opens: resolves true when this iPad must be paired first. Network errors → false. */
export async function needsPairing() {
  try {
    await postJson('/api/device/status', who());
    return false;
  } catch (err) {
    return err instanceof PairingRequired;
  }
}

async function pairDevice(code) {
  const id = await deviceId();
  let deviceName = '';
  try { deviceName = String(shopify.device?.name || ''); } catch { /* not available */ }
  const resp = await send('/api/device/pair', { code, deviceId: id, deviceName, ...who() }, {});
  let data = null;
  try { data = await resp.json(); } catch { /* non-JSON response */ }
  if (!resp.ok || !data?.deviceKey) {
    throw new Error(data?.error || `Pairing failed (${resp.status})`);
  }
  await shopify.storage.set(STORAGE_KEY, data.deviceKey);
  keyRefreshed = true;
  deviceOnlyRefused = false;
}

/** Full-screen pairing form. onPaired() runs after the key is saved; onCancel() is optional. */
export function PairingScreen({ onPaired, onCancel }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    const clean = code.replace(/\s+/g, '');
    if (!clean) {
      setError('Enter the pairing code.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await pairDevice(clean);
      setCode('');
      try { shopify.toast.show('This iPad is paired'); } catch { /* toast not available */ }
      onPaired?.();
    } catch (err) {
      setError(err.message || 'Network error, please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <s-page heading="Set up this iPad">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-banner tone="warning" heading="This iPad is not paired yet">
              Ask a manager to enter the store pairing code. After that, every account can use all Hera tiles on this iPad.
            </s-banner>
            <s-text-field
              label="Pairing code"
              value={code}
              error={error || undefined}
              disabled={busy}
              onInput={(e) => setCode(e.currentTarget.value)}
            />
            <s-button variant="primary" disabled={busy} onClick={submit}>
              {busy ? 'Pairing…' : 'Pair this iPad'}
            </s-button>
            {onCancel && (
              <s-button variant="secondary" disabled={busy} onClick={onCancel}>Back</s-button>
            )}
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}
