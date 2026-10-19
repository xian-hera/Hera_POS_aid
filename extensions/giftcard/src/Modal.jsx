import "@shopify/ui-extensions/preact";
import { render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';

// Shared Hera_POS_aid backend (Render).
const SERVER_URL = "https://search-0wf4.onrender.com";

// These two must match giftcard.js on the server.
const GIFT_LINE_TITLE = 'Hera Gift Card';
const SERIAL_PROPERTY = '_hera_gc_serial';

const PRESET_AMOUNTS = [25, 50, 75, 100, 150, 200];
const MAX_AMOUNT = 500; // sanity limit in the UI; the server has its own limit (GIFT_MAX_AMOUNT)
const LOOKS_LIKE_SERIAL = /^HGB[A-Z0-9]{14}$/;
const REDEEM_QR_PREFIX = 'shopify-giftcard-v1-'; // the QR under the sticker: used to check a balance

export default async () => {
  render(<Extension />, document.body);
};

async function authHeaders() {
  // Shopify-signed ID token: the backend only accepts gift card requests from our POS.
  // Tokens expire after ~1 minute, so fetch a fresh one for every request.
  try {
    const token = await shopify.session.getSessionToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

function errorMessage(status, data) {
  if (status === 401) {
    return 'This POS device is not authorized. Please make sure the staff account is logged in.';
  }
  if (status === 429) return 'Too many scans, please wait a minute and try again.';
  return data?.error || `Could not check the card (${status})`;
}

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function Extension() {
  // scan | checking | amount | added | active | balance | error
  const [step, setStep] = useState('scan');
  const [balanceInfo, setBalanceInfo] = useState(null);
  const [serial, setSerial] = useState('');
  const [preset, setPreset] = useState(null);
  const [custom, setCustom] = useState('');
  const [adding, setAdding] = useState(false);
  const [addedAmount, setAddedAmount] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [hasCamera, setHasCamera] = useState(false);

  const stepRef = useRef('scan');
  const busyRef = useRef(false);
  const lastScanRef = useRef({ value: null, at: 0 });

  const go = (next) => {
    stepRef.current = next;
    setStep(next);
  };

  const hideCamera = () => {
    try {
      if (typeof shopify.scanner.hideCameraScanner === 'function') shopify.scanner.hideCameraScanner();
    } catch { /* not open */ }
  };

  const showCamera = () => {
    try {
      if (typeof shopify.scanner.showCameraScanner === 'function') shopify.scanner.showCameraScanner();
    } catch { /* camera not available */ }
  };

  const checkCard = async (serialValue) => {
    busyRef.current = true;
    setErrorMsg('');
    go('checking');
    try {
      const resp = await fetch(`${SERVER_URL}/api/giftcard/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ serial: serialValue }),
      });
      let data = null;
      try { data = await resp.json(); } catch { /* non-JSON response */ }
      if (!resp.ok) throw new Error(errorMessage(resp.status, data));

      setSerial(serialValue);
      if (data.active) {
        go('active');
      } else {
        setPreset(null);
        setCustom('');
        go('amount');
      }
    } catch (err) {
      setErrorMsg(err.message || 'Network error, please try again.');
      go('error');
    } finally {
      busyRef.current = false;
    }
  };

  // The customer shows a card (sticker already removed) and the cashier scans the redeem QR to read the balance.
  const checkBalance = async (qrContent) => {
    busyRef.current = true;
    setErrorMsg('');
    go('checking');
    try {
      const resp = await fetch(`${SERVER_URL}/api/giftcard/balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ code: qrContent }),
      });
      let data = null;
      try { data = await resp.json(); } catch { /* non-JSON response */ }
      if (!resp.ok) throw new Error(errorMessage(resp.status, data));
      setBalanceInfo(data);
      go('balance');
    } catch (err) {
      setErrorMsg(err.message || 'Network error, please try again.');
      go('error');
    } finally {
      busyRef.current = false;
    }
  };

  const handleScan = (raw) => {
    const original = String(raw ?? '').trim();
    if (!original) return;
    if (busyRef.current || stepRef.current === 'checking') return;

    // The scanner can report the same code several times: ignore repeats within 1.5 s.
    const now = Date.now();
    const value = original.toUpperCase();
    if (value === lastScanRef.current.value && now - lastScanRef.current.at < 1500) return;
    lastScanRef.current = { value, at: now };

    hideCamera();

    if (original.toLowerCase().startsWith(REDEEM_QR_PREFIX)) {
      // Redeem code scanned: only ever used to show the balance, never to sell.
      checkBalance(original);
      return;
    }
    if (!LOOKS_LIKE_SERIAL.test(value)) {
      setErrorMsg('This is not a Hera gift card activation code.');
      go('error');
      return;
    }
    checkCard(value);
  };

  useEffect(() => {
    // The subscription may immediately replay the previous scan (even from another tile):
    // ignore anything that arrives in the first moments.
    let ready = false;
    const readyTimer = setTimeout(() => { ready = true; }, 400);
    const unsubscribeData = shopify.scanner.scannerData.current.subscribe((result) => {
      if (!ready || !result?.data) return;
      handleScan(result.data);
    });
    let unsubscribeSources = () => {};
    try {
      unsubscribeSources = shopify.scanner.sources.current.subscribe((sources) => {
        setHasCamera(Array.isArray(sources) && sources.includes('camera'));
      });
    } catch { /* sources not available */ }
    return () => {
      clearTimeout(readyTimer);
      unsubscribeData();
      unsubscribeSources();
      hideCamera();
    };
  }, []);

  // Amount: a typed custom amount wins over a preset button.
  const customValue = custom.trim() === '' ? null : Number(custom);
  const amount = customValue !== null ? customValue : preset;
  const amountValid =
    Number.isFinite(amount) &&
    amount >= 1 &&
    amount <= MAX_AMOUNT &&
    Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6; // at most 2 decimals

  const handleAdd = async () => {
    if (!amountValid || adding) return;
    setAdding(true);
    let uuid = '';
    try {
      // One card, one line: refuse if this card is already in the cart.
      let alreadyInCart = false;
      try {
        const lines = shopify.cart.current.value?.lineItems ?? [];
        alreadyInCart = lines.some((li) => li?.properties?.[SERIAL_PROPERTY] === serial);
      } catch { /* cart not readable: the server still activates each card only once */ }
      if (alreadyInCart) throw new Error('This card is already in the cart.');

      uuid = await shopify.cart.addCustomSale({
        title: GIFT_LINE_TITLE,
        price: Number(amount).toFixed(2),
        quantity: 1,
        taxable: false,
      });
      if (!uuid) throw new Error('POS did not confirm the new line.');
      await shopify.cart.addLineItemProperties(uuid, { [SERIAL_PROPERTY]: serial });

      setAddedAmount(Number(amount));
      go('added');
    } catch (err) {
      // Never leave an untagged gift card line in the cart: it would take payment without activating a card.
      if (uuid) {
        try { await shopify.cart.removeLineItem(uuid); } catch { /* ignore */ }
      }
      setErrorMsg(`Could not add the gift card to the cart. ${err.message || ''}`.trim());
      go('error');
    } finally {
      setAdding(false);
    }
  };

  const handleReset = () => {
    lastScanRef.current = { value: null, at: 0 };
    setSerial('');
    setPreset(null);
    setCustom('');
    setErrorMsg('');
    setBalanceInfo(null);
    go('scan');
  };

  const shortId = serial ? `…${serial.slice(-4)}` : '';

  return (
    <s-page heading="Gift Card Sale">
      <s-scroll-box>
        <s-box padding="base">

          {step === 'scan' && (
            <s-stack direction="block" gap="base">
              <s-text type="strong" emphasis="bold">Ready to Scan</s-text>
              <s-text color="subdued" appearance="subdued">
                To sell a card, scan the QR code on the front of the card. Leave the sticker on: the customer removes it themselves.
              </s-text>
              <s-text color="subdued" appearance="subdued">
                To check a balance, scan the QR code under the sticker (the customer peels it).
              </s-text>
              {hasCamera && (
                <s-button onClick={showCamera}>Scan with camera</s-button>
              )}
            </s-stack>
          )}

          {step === 'checking' && (
            <s-stack direction="block" gap="base">
              <s-text color="subdued" appearance="subdued">Checking the card...</s-text>
            </s-stack>
          )}

          {step === 'amount' && (
            <s-stack direction="block" gap="base">
              <s-text type="strong" emphasis="bold">New card {shortId}</s-text>
              <s-text color="subdued" appearance="subdued">Not activated yet. Choose the amount the customer is paying.</s-text>

              <s-stack direction="inline" gap="base">
                {PRESET_AMOUNTS.slice(0, 3).map((v) => (
                  <s-button
                    key={v}
                    variant={custom.trim() === '' && preset === v ? 'primary' : 'secondary'}
                    onClick={() => { setPreset(v); setCustom(''); }}
                  >
                    {money(v)}
                  </s-button>
                ))}
              </s-stack>
              <s-stack direction="inline" gap="base">
                {PRESET_AMOUNTS.slice(3).map((v) => (
                  <s-button
                    key={v}
                    variant={custom.trim() === '' && preset === v ? 'primary' : 'secondary'}
                    onClick={() => { setPreset(v); setCustom(''); }}
                  >
                    {money(v)}
                  </s-button>
                ))}
              </s-stack>

              <s-number-field
                label="Other amount ($)"
                value={custom}
                min={1}
                max={MAX_AMOUNT}
                onInput={(e) => { setCustom(e.currentTarget.value); setPreset(null); }}
              />

              {amountValid ? (
                <s-button variant="primary" disabled={adding} onClick={handleAdd}>
                  {adding ? 'Adding...' : `Add ${money(amount)} gift card to cart`}
                </s-button>
              ) : (
                <s-text color="subdued" appearance="subdued">Pick an amount from $1 to ${MAX_AMOUNT} (cents allowed).</s-text>
              )}
              <s-button onClick={handleReset}>Scan a different card</s-button>
            </s-stack>
          )}

          {step === 'added' && (
            <s-stack direction="block" gap="base">
              <s-text type="strong" emphasis="bold">Added to the cart</s-text>
              <s-text>
                {money(addedAmount)} gift card {shortId}. Complete the checkout now.
              </s-text>
              <s-text color="subdued" appearance="subdued">
                The card is activated automatically once the order is paid. Scan the card again afterwards:
                it should say "Activated". Hand it to the customer only after that.
              </s-text>
              <s-button onClick={handleReset}>Scan another card</s-button>
            </s-stack>
          )}

          {step === 'active' && (
            <s-stack direction="block" gap="base">
              <s-text type="strong" emphasis="bold">Activated: card {shortId}</s-text>
              <s-text color="subdued" appearance="subdued">
                If you just completed the payment, the card is loaded and can be handed to the customer.
                If you are trying to sell it, it is already sold: do not sell it again.
              </s-text>
              <s-button onClick={handleReset}>Scan another card</s-button>
            </s-stack>
          )}

          {step === 'balance' && (
            <s-stack direction="block" gap="base">
              {balanceInfo?.found ? (
                <>
                  <s-text type="strong" emphasis="bold">Card …{String(balanceInfo.lastCharacters || '').toUpperCase()}</s-text>
                  <s-text type="strong" emphasis="bold">Balance: {money(balanceInfo.balance)} {balanceInfo.currency}</s-text>
                  {balanceInfo.enabled === false && (
                    <s-text tone="critical" appearance="critical">This card is disabled and cannot be used.</s-text>
                  )}
                  {balanceInfo.expired && (
                    <s-text tone="critical" appearance="critical">This card has expired.</s-text>
                  )}
                </>
              ) : (
                <>
                  <s-text type="strong" emphasis="bold">Card not found</s-text>
                  <s-text color="subdued" appearance="subdued">
                    The code is wrong, or the card has not been activated (sold) yet.
                  </s-text>
                </>
              )}
              <s-button onClick={handleReset}>Scan another card</s-button>
            </s-stack>
          )}

          {step === 'error' && (
            <s-stack direction="block" gap="base">
              <s-text tone="critical" type="strong" appearance="critical" emphasis="bold">Could not continue</s-text>
              <s-text tone="critical" appearance="critical">{errorMsg}</s-text>
              <s-button onClick={handleReset}>Try Again</s-button>
            </s-stack>
          )}

        </s-box>
      </s-scroll-box>
    </s-page>
  );
}
