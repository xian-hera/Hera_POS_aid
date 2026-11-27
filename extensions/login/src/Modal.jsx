import "@shopify/ui-extensions/preact";
import { render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { fetchNote, cartCustomerId } from './note.js';

// Shared Hera_POS_aid backend (Render). Do not change: Apple Wallet cards also point here.
const SERVER_URL = "https://search-0wf4.onrender.com";

export default async () => {
  render(<Extension />, document.body);
};

async function authHeaders() {
  // Shopify-signed ID token, lets the backend accept requests only from our POS.
  // Tokens expire after ~1 minute, so fetch a fresh one for every request.
  try {
    const token = await shopify.session.getSessionToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

function errorMessage(status, data) {
  if (status === 401 && data?.error === 'This POS device is not authorized') {
    return 'This POS device is not authorized. Please make sure the staff account is logged in.';
  }
  if (status === 429) return 'Too many scans, please wait a minute and try again.';
  return data?.error || `Verification failed (${status})`;
}

function Extension() {
  const [status, setStatus] = useState('idle');
  const [customer, setCustomer] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const processingRef = useRef(false);
  const lastScannedRef = useRef(null);
  // Customer note: when the customer already in the cart has one, the modal shows only the note
  // ("note" view, no scanning: a customer is already logged in).
  const [view, setView] = useState('scan');
  const viewRef = useRef('scan');
  viewRef.current = view;
  const [note, setNote] = useState(null); // { name, text } of the customer in the cart / just logged in

  useEffect(() => {
    const id = cartCustomerId();
    if (!id) return;
    fetchNote(id)
      .then((data) => {
        if (!data?.hasNote) return;
        setNote({ name: data.name || '', text: String(data.note || '') });
        setView((v) => (v === 'scan' && !processingRef.current ? 'note' : v));
      })
      .catch(() => { /* could not check: stay on scanning */ });
  }, []);

  const verifyCustomer = async (scannedValue) => {
    const value = String(scannedValue).trim();
    if (processingRef.current) return;
    if (value === lastScannedRef.current) return;
    processingRef.current = true;
    lastScannedRef.current = value;
    setStatus('verifying');
    setErrorMsg(null);

    try {
      const resp = await fetch(`${SERVER_URL}/api/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ token: value }),
      });

      let data = null;
      try { data = await resp.json(); } catch { /* non-JSON response */ }

      if (!resp.ok) throw new Error(errorMessage(resp.status, data));

      await shopify.cart.setCustomer({ id: parseInt(data.customerId, 10) });

      setCustomer(data);
      setStatus('success');
      // Logged in: close the modal (the tile then warns if the customer has a note).
      try { window.close(); } catch { /* stays open on the success screen */ }
    } catch (err) {
      setErrorMsg(err.message || 'Network error, please try again.');
      setStatus('error');
    } finally {
      processingRef.current = false;
    }
  };

  useEffect(() => {
    const unsubscribe = shopify.scanner.scannerData.current.subscribe((result) => {
      if (!result?.data) return;
      if (viewRef.current === 'note') return; // a customer is already in the cart
      if (status === 'verifying' || status === 'success') return;
      verifyCustomer(result.data);
    });
    return () => unsubscribe();
  }, [status]);

  const handleReset = () => {
    setStatus('idle');
    setCustomer(null);
    setErrorMsg(null);
    lastScannedRef.current = null;
  };

  if (view === 'note' && note) {
    return (
      <s-page key="note" heading="Customer note">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack direction="block" gap="base">
              {note.name && <s-text type="strong">{note.name}</s-text>}
              <s-stack direction="block" gap="small-200">
                {note.text.split(/\r?\n/).map((line, i) => <s-text key={i}>{line || ' '}</s-text>)}
              </s-stack>
              <s-text type="small" color="subdued">To change this note, edit the customer in POS or in the Shopify admin.</s-text>
            </s-stack>
          </s-box>
        </s-scroll-box>
      </s-page>
    );
  }

  return (
    <s-page key="scan" heading="Customer Login">
      <s-scroll-box>
        <s-box padding="base">

          {status === 'idle' && (
            <s-stack direction="block" gap="base">
              <s-text emphasis="bold">Ready to Scan</s-text>
              <s-text appearance="subdued">
                Ask the customer to open their loyalty card in Apple Wallet and present the barcode.
              </s-text>
              <s-text appearance="subdued">
                Scan the barcode to log in the customer automatically.
              </s-text>
            </s-stack>
          )}

          {status === 'verifying' && (
            <s-stack direction="block" gap="base">
              <s-text appearance="subdued">Verifying customer...</s-text>
            </s-stack>
          )}

          {status === 'success' && customer && (
            <s-stack direction="block" gap="base">
              <s-text emphasis="bold">Customer Logged In</s-text>
              <s-stack direction="block" gap="none">
                <s-text emphasis="bold">{customer.firstName} {customer.lastName}</s-text>
                {customer.email && <s-text appearance="subdued">{customer.email}</s-text>}
                {customer.phone && <s-text appearance="subdued">{customer.phone}</s-text>}
              </s-stack>
              <s-stack direction="block" gap="none">
                <s-text appearance="subdued">Loyalty Points</s-text>
                <s-text emphasis="bold">{customer.loyaltyPoints ?? '0'}</s-text>
              </s-stack>
              <s-button onClick={handleReset}>Scan Another Card</s-button>
            </s-stack>
          )}

          {status === 'error' && (
            <s-stack direction="block" gap="base">
              <s-text appearance="critical" emphasis="bold">Login Failed</s-text>
              <s-text appearance="critical">{errorMsg}</s-text>
              <s-button onClick={handleReset}>Try Again</s-button>
            </s-stack>
          )}

        </s-box>
      </s-scroll-box>
    </s-page>
  );
}
