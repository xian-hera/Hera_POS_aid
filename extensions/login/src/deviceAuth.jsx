// Device pairing (identical copy in extensions/login, extensions/giftcard and extensions/restock).
//
// Shopify only gives a session token to POS accounts that have this app in their permissions, and
// the app cannot be picked there. So an iPad can instead be "paired" once: a manager types the store
// pairing code, the backend answers with a signed device key, and the key is kept in this
// extension's storage on the iPad (Shopify keeps each extension's storage separate, so every tile
// is paired on its own). Every request then carries the key in the X-Hera-Device header.
// The pairing code itself is never stored, and nothing secret is written in this file.
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

async function storedKey() {
  try {
    const key = await shopify.storage.get(STORAGE_KEY);
    return typeof key === 'string' && key ? key : null;
  } catch {
    return null;
  }
}

async function forgetKey() {
  try { await shopify.storage.delete(STORAGE_KEY); } catch { /* nothing stored */ }
}

async function tokenHeader() {
  // Shopify-signed ID token (only for accounts that have the app permission). Fresh for every request.
  try {
    const token = await shopify.session.getSessionToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/**
 * POST JSON to the backend with this iPad's credentials.
 * Returns { resp, data }. Throws PairingRequired when the backend asks for pairing.
 */
export async function postJson(path, body) {
  const send = (auth) =>
    fetch(`${SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(body ?? {}),
    });

  const key = await storedKey();
  // A paired iPad sends only its key, so POS does not show "does not have access" messages.
  let resp = await send(key ? { 'X-Hera-Device': key } : await tokenHeader());
  if (resp.status === 401 && key) {
    // The key was revoked (secret changed on the server): forget it, try the Shopify token once.
    await forgetKey();
    resp = await send(await tokenHeader());
  }
  let data = null;
  try { data = await resp.json(); } catch { /* non-JSON response */ }
  if (resp.status === 401 && data?.code === 'PAIRING_REQUIRED') throw new PairingRequired();
  return { resp, data };
}

/** Called when a tile opens: resolves true when this iPad must be paired first. Network errors → false. */
export async function needsPairing() {
  try {
    await postJson('/api/device/status', {});
    return false;
  } catch (err) {
    return err instanceof PairingRequired;
  }
}

async function pairDevice(code) {
  const locationId = shopify.session?.currentSession?.locationId ?? null;
  const resp = await fetch(`${SERVER_URL}/api/device/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, locationId }),
  });
  let data = null;
  try { data = await resp.json(); } catch { /* non-JSON response */ }
  if (!resp.ok || !data?.deviceKey) {
    throw new Error(data?.error || `Pairing failed (${resp.status})`);
  }
  await shopify.storage.set(STORAGE_KEY, data.deviceKey);
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
              A manager enters the store pairing code once. After that, everyone can use this tile on this iPad.
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
