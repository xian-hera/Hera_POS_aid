import "@shopify/ui-extensions/preact";
import { render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';

import { postJson } from './deviceAuth.jsx';

export default async () => {
  render(<Extension />, document.body);
};

function errorMessage(status, data) {
  if (status === 401 && data?.error === 'This POS device is not authorized') {
    return 'This POS account cannot use this tile (no access to the app).';
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

  const verifyCustomer = async (scannedValue) => {
    const value = String(scannedValue).trim();
    if (processingRef.current) return;
    if (value === lastScannedRef.current) return;
    processingRef.current = true;
    lastScannedRef.current = value;
    setStatus('verifying');
    setErrorMsg(null);

    try {
      const { resp, data } = await postJson('/api/verify', { token: value });

      if (!resp.ok) throw new Error(errorMessage(resp.status, data));

      await shopify.cart.setCustomer({ id: parseInt(data.customerId, 10) });

      setCustomer(data);
      setStatus('success');
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

  return (
    <s-page heading="Customer Login">
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
