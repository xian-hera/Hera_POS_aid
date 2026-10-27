import "@shopify/ui-extensions/preact";
import { render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';

import { SERVER_URL, postJson, PairingRequired, PairingScreen, needsPairing } from './deviceAuth.jsx';

// Must match giftcard.js on the server.
const SERIAL_PROPERTY = '_hera_gc_serial';

// The card is sold as the Shopify product "Hera Beauté Physical Gift Card": one variant per amount
// (POS channel only, not taxable). The server only activates cards for lines of that product.
// To add or remove an amount, change the variant list in Shopify and in this list, then run `shopify app deploy`.
const GIFT_VARIANTS = [
  { amount: 5, variantId: 67771738587446 },
  { amount: 10, variantId: 67771738620214 },
  { amount: 15, variantId: 67771738652982 },
  { amount: 20, variantId: 67771738685750 },
  { amount: 25, variantId: 67771738718518 },
  { amount: 30, variantId: 67771738751286 },
  { amount: 35, variantId: 67771738784054 },
  { amount: 40, variantId: 67771738816822 },
  { amount: 45, variantId: 67771738849590 },
  { amount: 50, variantId: 67771738882358 },
  { amount: 55, variantId: 67771738915126 },
  { amount: 60, variantId: 67771738947894 },
  { amount: 65, variantId: 67771738980662 },
  { amount: 70, variantId: 67771739013430 },
  { amount: 75, variantId: 67771739046198 },
  { amount: 80, variantId: 67771739078966 },
  { amount: 85, variantId: 67771739111734 },
  { amount: 90, variantId: 67771739144502 },
  { amount: 95, variantId: 67771739177270 },
  { amount: 100, variantId: 67771739210038 },
  { amount: 150, variantId: 67771739242806 },
  { amount: 180, variantId: 67771739275574 },
  { amount: 200, variantId: 67771739308342 },
];
const BUTTONS_PER_ROW = 4;
const AMOUNT_ROWS = Array.from({ length: Math.ceil(GIFT_VARIANTS.length / BUTTONS_PER_ROW) }, (_, i) =>
  GIFT_VARIANTS.slice(i * BUTTONS_PER_ROW, (i + 1) * BUTTONS_PER_ROW)
);
const LOOKS_LIKE_SERIAL = /^HGB[A-Z0-9]{14}$/;
// Picture shown under the instructions on the scan screen. It is served by the backend, so replacing
// storefront/images/pos-guide.png and pushing to Render is enough: no `shopify app deploy` needed.
// (Any public https image URL works too. Set it to '' to hide the picture.)
const GUIDE_IMAGE_URL = `${SERVER_URL}/proxy/giftcard-balance/img/pos-guide.png`;
const GUIDE_IMAGE_ASPECT_RATIO = '1.6'; // width / height of the picture, e.g. 1600 x 1000

const REDEEM_QR_PREFIX = 'shopify-giftcard-v1-'; // the QR under the sticker: used to check a balance

export default async () => {
  render(<Extension />, document.body);
};

function errorMessage(status, data) {
  if (status === 401) {
    return 'This POS device is not authorized. Pair this iPad again (close and reopen this tile).';
  }
  if (status === 429) return 'Too many scans, please wait a minute and try again.';
  const base = data?.error || `Could not check the card (${status})`;
  return data?.detail ? `${base} [${data.detail}]` : base;
}

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function Extension() {
  // scan | checking | amount | added | active | balance | error | pairing
  const [step, setStep] = useState('scan');
  const [balanceInfo, setBalanceInfo] = useState(null);
  const [serial, setSerial] = useState('');
  const [preset, setPreset] = useState(null);
  const [adding, setAdding] = useState(false);
  const [addedAmount, setAddedAmount] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  const stepRef = useRef('scan');
  const busyRef = useRef(false);
  const lastScanRef = useRef({ value: null, at: 0 });

  const go = (next) => {
    stepRef.current = next;
    setStep(next);
  };

  const checkCard = async (serialValue) => {
    busyRef.current = true;
    setErrorMsg('');
    go('checking');
    try {
      const { resp, data } = await postJson('/api/giftcard/status', { serial: serialValue });
      if (!resp.ok) throw new Error(errorMessage(resp.status, data));

      setSerial(serialValue);
      if (data.active) {
        go('active');
      } else {
        setPreset(null);
        go('amount');
      }
    } catch (err) {
      if (err instanceof PairingRequired) {
        go('pairing');
        return;
      }
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
      const { resp, data } = await postJson('/api/giftcard/balance', { code: qrContent });
      if (!resp.ok) throw new Error(errorMessage(resp.status, data));
      setBalanceInfo(data);
      go('balance');
    } catch (err) {
      if (err instanceof PairingRequired) {
        go('pairing');
        return;
      }
      setErrorMsg(err.message || 'Network error, please try again.');
      go('error');
    } finally {
      busyRef.current = false;
    }
  };

  const handleScan = (raw) => {
    const original = String(raw ?? '').trim();
    if (!original) return;
    if (busyRef.current || stepRef.current === 'checking' || stepRef.current === 'pairing') return;

    // The scanner can report the same code several times: ignore repeats within 1.5 s.
    const now = Date.now();
    const value = original.toUpperCase();
    if (value === lastScanRef.current.value && now - lastScanRef.current.at < 1500) return;
    lastScanRef.current = { value, at: now };

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

  // Ask for pairing as soon as the tile opens on an iPad that cannot authenticate
  useEffect(() => {
    needsPairing().then((need) => { if (need) go('pairing'); });
  }, []);

  useEffect(() => {
    // The subscription may immediately replay the previous scan (even from another tile):
    // ignore anything that arrives in the first moments.
    let ready = false;
    const readyTimer = setTimeout(() => { ready = true; }, 400);
    const unsubscribeData = shopify.scanner.scannerData.current.subscribe((result) => {
      if (!ready || !result?.data) return;
      handleScan(result.data);
    });
    return () => {
      clearTimeout(readyTimer);
      unsubscribeData();
    };
  }, []);

  // `preset` holds the chosen amount (one of GIFT_VARIANTS).
  const chosen = GIFT_VARIANTS.find((v) => v.amount === preset) || null;
  const amount = chosen ? chosen.amount : null;
  const amountValid = Boolean(chosen);

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

      // Returns '' when POS did not add the line (e.g. a dialog was dismissed).
      uuid = await shopify.cart.addLineItem(chosen.variantId, 1);
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
    setErrorMsg('');
    setBalanceInfo(null);
    go('scan');
  };

  const shortId = serial ? `…${serial.slice(-4)}` : '';

  if (step === 'pairing') {
    return <PairingScreen onPaired={handleReset} />;
  }

  return (
    <s-page heading="Sell Gift Card">
      <s-scroll-box>
        <s-box padding="base">

          {step === 'scan' && (
            <s-stack direction="block" gap="base">
              <s-text type="strong" emphasis="bold">Scan now</s-text>
              <s-text color="subdued" appearance="subdued">
                To sell a Gift Card, scan the QR code on the right, without scratch off anything;
              </s-text>
              <s-text color="subdued" appearance="subdued">
                To check balance, scan the QR code on the left, customer needs to scratch it first.
              </s-text>
              {GUIDE_IMAGE_URL && (
                <s-box>
                  <s-image
                    src={GUIDE_IMAGE_URL}
                    alt="Where to scan: the code on the right sells a card, the code on the left checks the balance"
                    aspectRatio={GUIDE_IMAGE_ASPECT_RATIO}
                    objectFit="contain"
                    inlineSize="fill"
                  />
                </s-box>
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

              {AMOUNT_ROWS.map((row) => (
                <s-stack key={row[0].amount} direction="inline" gap="base">
                  {row.map((v) => (
                    <s-button
                      key={v.amount}
                      variant={preset === v.amount ? 'primary' : 'secondary'}
                      onClick={() => setPreset(v.amount)}
                    >
                      {money(v.amount)}
                    </s-button>
                  ))}
                </s-stack>
              ))}

              {amountValid ? (
                <s-button variant="primary" disabled={adding} onClick={handleAdd}>
                  {adding ? 'Adding...' : `Add ${money(amount)} gift card to cart`}
                </s-button>
              ) : (
                <s-text color="subdued" appearance="subdued">Tap an amount above.</s-text>
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
