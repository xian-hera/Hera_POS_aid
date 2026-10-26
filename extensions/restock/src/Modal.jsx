import "@shopify/ui-extensions/preact";
import { render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';

// Shared Hera_POS_aid backend (Render). Do not change: Apple Wallet cards also point here.
const SERVER_URL = "https://search-0wf4.onrender.com";

const MAX_ITEMS = 30;          // same limit as the server
const MAX_ROWS = 60;           // search results shown at once
const SEARCH_DELAY_MS = 350;   // wait for the cashier to stop typing

export default async () => {
  render(<Extension />, document.body);
};

// ─── Backend calls ───────────────────────────────────────────────────────────

async function authHeaders() {
  // Shopify-signed ID token (expires after ~1 minute, so a fresh one for every request).
  try {
    const token = await shopify.session.getSessionToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function api(path, body) {
  const resp = await fetch(`${SERVER_URL}/api/restock/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await resp.json(); } catch { /* non-JSON response */ }
  if (!resp.ok) {
    if (resp.status === 401) throw new Error('This POS device is not authorized. Please make sure the staff account is logged in.');
    if (resp.status === 429) throw new Error('Too many requests, please wait a minute and try again.');
    throw new Error(data?.error || `Request failed (${resp.status})`);
  }
  return data;
}

// ─── Search (variant level) ──────────────────────────────────────────────────
// POS search returns products. We split every product into its variants and keep only the
// variants that match what was typed, so a SKU or barcode gives exactly one line.

const cleanVariantTitle = (t) => (t && t !== 'Default Title' ? t : '');

function rowFromPos(product, v) {
  return {
    variantId: String(v.id),
    sku: v.sku || '',
    barcode: v.barcode || '',
    productTitle: product?.title || v.product?.title || '',
    variantTitle: cleanVariantTitle(v.title),
    image: v.image || product?.featuredImage || '',
    available: v.inventoryIsTracked === false ? null : (v.inventoryAtLocation ?? null),
    tracked: v.inventoryIsTracked !== false,
    vendor: product?.vendor || '',
  };
}

function rowFromServer(v) {
  return {
    variantId: String(v.variantId),
    sku: v.sku || '',
    barcode: v.barcode || '',
    productTitle: v.productTitle || '',
    variantTitle: v.variantTitle || '',
    image: v.image || '',
    available: v.tracked ? v.available : null,
    tracked: Boolean(v.tracked),
    vendor: v.vendor || '',
  };
}

function filterRows(rows, query) {
  const q = query.trim().toLowerCase();
  const exact = rows.filter((r) => r.sku.toLowerCase() === q || (r.barcode && r.barcode.toLowerCase() === q));
  if (exact.length) return exact;
  const words = q.split(/\s+/).filter(Boolean);
  const matched = rows.filter((r) => {
    const hay = `${r.productTitle} ${r.variantTitle} ${r.sku} ${r.barcode} ${r.vendor}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  // POS sometimes matches on fields we cannot see (tags, description): then show all its variants.
  return matched.length ? matched : rows;
}

async function searchOnDevice(query) {
  const result = await shopify.productSearch.searchProducts({ queryString: query, first: 25 });
  const rows = [];
  for (const product of result?.items || []) {
    let variants = product.variants || [];
    if (!variants.length && product.numVariants > 0) {
      try { variants = await shopify.productSearch.fetchProductVariantsWithProductId(product.id); } catch { variants = []; }
    }
    for (const v of variants) rows.push(rowFromPos(product, v));
  }
  return rows;
}

async function searchVariants(query, locationId) {
  let rows = [];
  try {
    rows = await searchOnDevice(query);
  } catch {
    rows = [];
  }
  if (rows.length) return filterRows(rows, query);
  // Nothing on the device (e.g. product not on the POS channel): ask Shopify directly.
  const data = await api('search', { query, locationId: String(locationId) });
  return filterRows((data?.variants || []).map(rowFromServer), query);
}

// ─── Small UI pieces ─────────────────────────────────────────────────────────

// Klaviyo asks every new SMS subscriber to confirm by replying YES (double opt-in).
// Without that reply no restock text can be sent, so the cashier must tell the customer
// and tap the button below before the request can be saved.
function ReplyYesWarning({ acknowledged, onAcknowledge }) {
  return (
    <s-stack direction="block" gap="small">
      <s-banner tone="critical" heading="IMPORTANT: Remind Customer to reply YES.">
        After subscribing to SMS, customer receives a text from Hera Beauté asking to reply YES.
        Ask customer to check their phone and reply YES now. Without YES, the restock text cannot be sent.
      </s-banner>
      {acknowledged ? (
        <s-button disabled>✓ Customer reminded to reply YES</s-button>
      ) : (
        <s-button variant="primary" tone="critical" onClick={onAcknowledge}>
          I reminded the customer to reply YES
        </s-button>
      )}
    </s-stack>
  );
}

const LANGUAGE_NAMES = { en: 'English', fr: 'Français' };

// A choice where exactly one option is selected: the selected one is filled (primary) with a ✓,
// the other one is plain, so the cashier always sees which one is active.
function ChoiceButton({ selected, disabled, onClick, children }) {
  return (
    <s-button variant={selected ? 'primary' : 'secondary'} disabled={disabled} onClick={onClick}>
      {selected ? '✓ ' : ''}{children}
    </s-button>
  );
}

function stockLabel(row) {
  if (!row.tracked || row.available === null) return 'Stock: not tracked here';
  return `In stock here: ${row.available}`;
}

function VariantLine({ row, action }) {
  return (
    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-box inlineSize="56px" blockSize="56px">
          {row.image ? (
            <s-image src={row.image} alt={row.productTitle} objectFit="contain" inlineSize="fill" />
          ) : (
            <s-box inlineSize="56px" blockSize="56px" />
          )}
        </s-box>
        <s-stack direction="block" gap="none">
          <s-text color="subdued">{row.sku || 'No SKU'}</s-text>
          <s-text type="strong">{row.productTitle}</s-text>
          {row.variantTitle && <s-text>{row.variantTitle}</s-text>}
          <s-text type="small" color="subdued">{stockLabel(row)}</s-text>
        </s-stack>
      </s-stack>
      {action}
    </s-stack>
  );
}

// ─── Modal ───────────────────────────────────────────────────────────────────

function Extension() {
  const session = shopify.session.currentSession;
  const locationId = session?.locationId;
  const staffId = session?.staffMemberId;

  const [step, setStep] = useState('products'); // products | customer | done
  const [customerId, setCustomerId] = useState(() => {
    try {
      const id = shopify.cart.current.value?.customer?.id;
      return id ? String(id) : null;
    } catch {
      return null;
    }
  });

  // products page
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searchState, setSearchState] = useState('idle'); // idle | searching | done | error
  const [searchError, setSearchError] = useState('');
  const [selected, setSelected] = useState([]);
  const searchSeq = useRef(0);
  const searchTimer = useRef(null);
  // After Add, the search field must lose focus so the iPad keyboard closes.
  const searchFieldRef = useRef(null);
  const [searchFieldKey, setSearchFieldKey] = useState(0);
  const selectedRef = useRef([]);
  const stepRef = useRef('products');

  // customer page
  const [customer, setCustomer] = useState(null);
  const [customerState, setCustomerState] = useState('idle'); // idle | loading | ready | error
  const [customerError, setCustomerError] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [fieldError, setFieldError] = useState({ email: '', phone: '' });
  const [busy, setBusy] = useState(''); // '' | 'email' | 'phone' | 'sub-email' | 'sub-sms' | 'confirm'
  const [channel, setChannel] = useState(null);
  const [confirmError, setConfirmError] = useState('');
  const [doneInfo, setDoneInfo] = useState(null);
  const [language, setLanguage] = useState(null); // 'en' | 'fr', confirmed by the cashier
  const [editing, setEditing] = useState({ email: false, phone: false }); // changing an existing value
  // SMS subscribed from this screen just now: the customer still has to reply YES to Klaviyo's text
  const [smsJustSubscribed, setSmsJustSubscribed] = useState(false);
  // The cashier tapped "I reminded the customer to reply YES"
  const [yesAck, setYesAck] = useState(false);

  selectedRef.current = selected;
  stepRef.current = step;

  // Follow the customer attached to the cart (it can change while the modal is open)
  useEffect(() => {
    let unsubscribe = null;
    try {
      unsubscribe = shopify.cart.current.subscribe((cart) => {
        const id = cart?.customer?.id ? String(cart.customer.id) : null;
        setCustomerId(id);
      });
    } catch { /* cart not available */ }
    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, []);

  // ── search ──
  const runSearch = async (text, { autoAdd = false } = {}) => {
    const q = text.trim();
    const seq = ++searchSeq.current;
    if (q.length < 2) {
      setResults([]);
      setSearchState('idle');
      return;
    }
    setSearchState('searching');
    setSearchError('');
    try {
      const rows = await searchVariants(q, locationId);
      if (seq !== searchSeq.current) return; // a newer search started
      setResults(rows.slice(0, MAX_ROWS));
      setSearchState('done');
      if (autoAdd && rows.length === 1) addItem(rows[0]);
    } catch (err) {
      if (seq !== searchSeq.current) return;
      setResults([]);
      setSearchError(err.message || 'Search failed, please try again.');
      setSearchState('error');
    }
  };

  const onQueryInput = (value) => {
    setQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => runSearch(value), SEARCH_DELAY_MS);
  };

  // Scanning a product barcode searches it and adds it when there is exactly one match
  useEffect(() => {
    let ready = false;
    const readyTimer = setTimeout(() => { ready = true; }, 400); // ignore a replayed previous scan
    const unsubscribe = shopify.scanner.scannerData.current.subscribe((result) => {
      if (!ready || !result?.data || stepRef.current !== 'products') return;
      const value = String(result.data).trim();
      if (!value) return;
      if (searchTimer.current) clearTimeout(searchTimer.current);
      setQuery(value);
      runSearch(value, { autoAdd: true });
    });
    return () => {
      clearTimeout(readyTimer);
      unsubscribe();
    };
  }, []);

  const isSelected = (variantId) => selected.some((s) => s.variantId === variantId);

  const addItem = (row) => {
    const current = selectedRef.current;
    if (current.some((s) => s.variantId === row.variantId)) return;
    if (current.length >= MAX_ITEMS) {
      shopify.toast.show(`At most ${MAX_ITEMS} products at a time`);
      return;
    }
    const next = [...current, row];
    selectedRef.current = next;
    setSelected(next);
    shopify.toast.show(`Added ${row.sku || row.productTitle}`);
    dismissKeyboard();
  };

  // Take the focus away from the search field (closes the on-screen keyboard).
  // blur() is the normal way; re-creating the field (new key) guarantees it on devices
  // where blur() is not passed on to the native field. The typed text and results stay.
  const dismissKeyboard = () => {
    try { searchFieldRef.current?.blur?.(); } catch { /* not supported */ }
    setSearchFieldKey((k) => k + 1);
  };

  const removeItem = (variantId) => {
    const next = selectedRef.current.filter((s) => s.variantId !== variantId);
    selectedRef.current = next;
    setSelected(next);
  };

  // ── customer ──
  const applyCustomer = (data) => setCustomer(data);

  const loadCustomer = async () => {
    if (!customerId) return;
    setCustomerState('loading');
    setCustomerError('');
    try {
      const data = await api('customer', { customerId });
      applyCustomer(data);
      // Pre-select the language from the Shopify profile (empty = English); the cashier confirms it
      setLanguage(data.language === 'fr' ? 'fr' : 'en');
      setCustomerState('ready');
    } catch (err) {
      setCustomerError(err.message || 'Could not load the customer.');
      setCustomerState('error');
    }
  };

  const resetCustomerChoices = () => {
    setChannel(null);
    setLanguage(null);
    setEditing({ email: false, phone: false });
    setEmailInput('');
    setPhoneInput('');
    setFieldError({ email: '', phone: '' });
    setSmsJustSubscribed(false);
    setYesAck(false);
    setConfirmError('');
  };

  const goToCustomer = () => {
    resetCustomerChoices();
    setStep('customer');
    loadCustomer();
  };

  useEffect(() => {
    // Customer changed while on the customer page: start the page again
    resetCustomerChoices();
    if (step === 'customer') {
      setCustomer(null);
      if (customerId) loadCustomer(); else setCustomerState('idle');
    }
  }, [customerId]);

  const chooseChannel = (next) => {
    if (busy) return;
    setChannel(next);
    setYesAck(false);
    setConfirmError('');
  };

  const startEdit = (kind) => {
    setFieldError((e) => ({ ...e, [kind]: '' }));
    if (kind === 'email') setEmailInput(customer?.email || ''); else setPhoneInput(customer?.phone || '');
    setEditing((e) => ({ ...e, [kind]: true }));
  };

  const cancelEdit = (kind) => {
    setFieldError((e) => ({ ...e, [kind]: '' }));
    setEditing((e) => ({ ...e, [kind]: false }));
  };

  const saveContact = async (kind) => {
    const value = kind === 'email' ? emailInput : phoneInput;
    if (!value.trim()) {
      setFieldError((e) => ({ ...e, [kind]: kind === 'email' ? 'Enter an email address' : 'Enter a phone number' }));
      return;
    }
    setBusy(kind);
    setFieldError((e) => ({ ...e, [kind]: '' }));
    try {
      const before = kind === 'email' ? customer?.email : customer?.phone;
      const data = await api('contact', { customerId, [kind]: value });
      applyCustomer(data);
      setEditing((e) => ({ ...e, [kind]: false }));
      if (kind === 'email') setEmailInput(''); else setPhoneInput('');
      if (kind === 'phone' && data.phone !== before) {
        // New number: any earlier SMS subscription / reminder was for the old number
        setSmsJustSubscribed(false);
        setYesAck(false);
      }
      shopify.toast.show(kind === 'email' ? 'Email saved' : 'Phone number saved');
    } catch (err) {
      setFieldError((e) => ({ ...e, [kind]: err.message }));
    } finally {
      setBusy('');
    }
  };

  const subscribe = async (kind) => {
    setBusy(`sub-${kind}`);
    setConfirmError('');
    try {
      const data = await api('subscribe', { customerId, channel: kind, locationId: String(locationId) });
      applyCustomer(data);
      shopify.toast.show(kind === 'email' ? 'Subscribed to email' : 'Subscribed to SMS');
      if (kind === 'sms' && data.smsSubscribed) {
        setSmsJustSubscribed(true);
        setYesAck(false);
      }
    } catch (err) {
      setConfirmError(err.message);
    } finally {
      setBusy('');
    }
  };

  // What still blocks Confirm (null = ready)
  const blocker = (() => {
    const c = customer;
    if (!c || !channel || !language || !selected.length) return 'incomplete';
    const kind = channel === 'email' ? 'email' : 'phone';
    if (editing[kind]) return channel === 'email' ? 'Save or cancel the email change above.' : 'Save or cancel the phone number change above.';
    if (channel === 'email' && !c.email) return "Add the customer's email address above.";
    if (channel === 'email' && !c.emailSubscribed) return 'The customer must be subscribed to email: tap Subscribe above if the customer agrees, or choose SMS.';
    if (channel === 'sms' && !c.phone) return "Add the customer's mobile number above.";
    if (channel === 'sms' && !c.smsSubscribed) return 'Text messages need an SMS subscription: tap Subscribe above if the customer agrees, or choose Email.';
    if (channel === 'sms' && smsJustSubscribed && !yesAck) return 'Tap "I reminded the customer to reply YES" above to continue.';
    return null;
  })();

  // Tapping Confirm while something is missing turns the "what is missing" message red
  // (remembers which message was tapped, so it goes back to grey as soon as the missing step changes)
  const [blockerTapped, setBlockerTapped] = useState(null);
  const blockerShown = Boolean(blocker) && blockerTapped === blocker;

  const confirm = async () => {
    if (blocker || busy) return;
    setBusy('confirm');
    setConfirmError('');
    try {
      const data = await api('submit', {
        customerId,
        locationId: String(locationId),
        channel,
        language,
        variantIds: selected.map((s) => s.variantId),
        staffId: staffId ? String(staffId) : undefined,
      });
      setDoneInfo({ ...data, count: selected.length });
      setStep('done');
    } catch (err) {
      setConfirmError(err.message);
    } finally {
      setBusy('');
    }
  };

  // "OK" on the done screen closes the modal (back to the POS home screen)
  const closeModal = () => {
    try {
      window.close();
    } catch {
      startOver();
    }
  };

  const startOver = () => {
    selectedRef.current = [];
    setSelected([]);
    setQuery('');
    setResults([]);
    setSearchState('idle');
    setCustomer(null);
    setDoneInfo(null);
    resetCustomerChoices();
    setStep('products');
  };

  // ─── Page 1: products ──────────────────────────────────────────────────────
  if (step === 'products') {
    return (
      <s-page heading="Restock Notify" subheading="1 of 2 · Products">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack direction="block" gap="base">
              {!customerId && (
                <s-banner tone="warning" heading="No customer logged in">
                  You can pick the products now, but log in the customer (Customer Login tile or cart) before going to the next step.
                </s-banner>
              )}
              <s-text color="subdued">
                Search by name, SKU or scan the product. Tap Add for each product the customer wants.
              </s-text>

              <s-search-field
                key={searchFieldKey}
                ref={searchFieldRef}
                placeholder="Search name, SKU, or scan directly."
                value={query}
                onInput={(e) => onQueryInput(e.currentTarget.value)}
                onChange={(e) => {
                  if (searchTimer.current) clearTimeout(searchTimer.current);
                  runSearch(e.currentTarget.value);
                }}
              />

              {searchState === 'searching' && <s-text color="subdued">Searching...</s-text>}
              {searchState === 'error' && <s-banner tone="critical" heading="Search failed">{searchError}</s-banner>}
              {searchState === 'done' && results.length === 0 && (
                <s-text color="subdued">No product found. Check the spelling or try the SKU.</s-text>
              )}

              {results.length > 0 && (
                <s-section heading={`Results (${results.length})`}>
                  <s-stack direction="block" gap="base">
                    {results.map((row) => (
                      <VariantLine
                        key={row.variantId}
                        row={row}
                        action={
                          isSelected(row.variantId)
                            ? <s-button disabled>Added</s-button>
                            : <s-button variant="primary" onClick={() => addItem(row)}>Add</s-button>
                        }
                      />
                    ))}
                  </s-stack>
                </s-section>
              )}

              <s-section heading={`Notify list (${selected.length})`}>
                {selected.length === 0 ? (
                  <s-text color="subdued">No product yet.</s-text>
                ) : (
                  <s-stack direction="block" gap="base">
                    {selected.map((row) => (
                      <VariantLine
                        key={row.variantId}
                        row={row}
                        action={<s-button tone="critical" onClick={() => removeItem(row.variantId)}>Remove</s-button>}
                      />
                    ))}
                  </s-stack>
                )}
              </s-section>

              <s-button
                variant="primary"
                disabled={!selected.length || !customerId}
                onClick={goToCustomer}
              >
                {!customerId ? 'Log in the customer to continue' : `Next: customer details (${selected.length})`}
              </s-button>
            </s-stack>
          </s-box>
        </s-scroll-box>
      </s-page>
    );
  }

  // ─── Done ──────────────────────────────────────────────────────────────────
  if (step === 'done') {
    return (
      <s-page heading="Restock Notify">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack direction="block" gap="base">
              <s-banner tone="success" heading="Saved">
                {doneInfo?.count} product{doneInfo?.count === 1 ? '' : 's'} on the notify list for {doneInfo?.store}.
              </s-banner>
              <s-text>
                The customer will receive {doneInfo?.channel === 'sms' ? 'a text message' : 'an email'} in {LANGUAGE_NAMES[doneInfo?.language] || 'English'} when the product is back in stock at this store.
              </s-text>
              {doneInfo?.updated > 0 && (
                <s-text color="subdued">
                  {doneInfo.updated} of them {doneInfo.updated === 1 ? 'was' : 'were'} already on the list: only the notification method was updated.
                </s-text>
              )}
              <s-button variant="primary" onClick={closeModal}>OK</s-button>
            </s-stack>
          </s-box>
        </s-scroll-box>
      </s-page>
    );
  }

  // ─── Page 2: customer ──────────────────────────────────────────────────────
  // Shown step by step: 1. channel → then 2. language + 3. contact for that channel → Confirm
  const c = customer;
  const waitingHere = c?.waiting?.length || 0;
  const contactKind = channel === 'sms' ? 'phone' : 'email';

  const contactSection = () => {
    if (!c || !channel) return null;
    const isEmail = channel === 'email';
    const value = isEmail ? c.email : c.phone;
    const subscribed = isEmail ? c.emailSubscribed : c.smsSubscribed;
    const isEditing = editing[contactKind];

    if (!value || isEditing) {
      return (
        <s-stack direction="block" gap="small">
          {isEmail ? (
            <s-email-field
              label={value ? 'New email address' : 'Email address'}
              placeholder="name@example.com"
              value={emailInput}
              error={fieldError.email || undefined}
              onInput={(e) => setEmailInput(e.currentTarget.value)}
            />
          ) : (
            <s-text-field
              label={value ? 'New mobile number' : 'Mobile number'}
              placeholder="514 555 1234"
              value={phoneInput}
              error={fieldError.phone || undefined}
              onInput={(e) => setPhoneInput(e.currentTarget.value)}
            />
          )}
          {value && (
            <s-text type="small" color="subdued">
              Saving replaces {value} in the customer's Shopify profile.
            </s-text>
          )}
          <s-stack direction="inline" gap="base">
            <s-button variant="primary" disabled={Boolean(busy)} onClick={() => saveContact(contactKind)}>
              {busy === contactKind ? 'Saving...' : isEmail ? 'Save email' : 'Save phone'}
            </s-button>
            {value && <s-button disabled={Boolean(busy)} onClick={() => cancelEdit(contactKind)}>Cancel</s-button>}
          </s-stack>
        </s-stack>
      );
    }

    return (
      <s-stack direction="block" gap="small">
        {/* One line: value · Edit · green "Subscribed" pill or Subscribe button */}
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text type="strong">{value}</s-text>
          <s-button disabled={Boolean(busy)} onClick={() => startEdit(contactKind)}>Edit</s-button>
          {subscribed ? (
            <s-badge tone="success">Subscribed</s-badge>
          ) : (
            <s-button variant="primary" disabled={Boolean(busy)} onClick={() => subscribe(channel)}>
              {busy === `sub-${channel}` ? 'Subscribing...' : 'Subscribe'}
            </s-button>
          )}
        </s-stack>
        {!subscribed && (
          <s-text type="small" color="subdued">Only tap Subscribe with customer's consent.</s-text>
        )}
      </s-stack>
    );
  };

  return (
    <s-page heading="Restock Notify" subheading="2 of 2 · Customer">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-button onClick={() => setStep('products')}>Back to products ({selected.length})</s-button>

            {!customerId && (
              <s-banner tone="warning" heading="No customer logged in">
                Log in the customer, then come back to this screen.
              </s-banner>
            )}
            {customerState === 'loading' && <s-text color="subdued">Loading customer...</s-text>}
            {customerState === 'error' && (
              <s-stack direction="block" gap="base">
                <s-banner tone="critical" heading="Could not load the customer">{customerError}</s-banner>
                <s-button onClick={loadCustomer}>Try again</s-button>
              </s-stack>
            )}

            {c && customerState === 'ready' && (
              <>
                <s-text type="strong">{`${c.firstName} ${c.lastName}`.trim() || 'Customer'}</s-text>

                <s-section heading="1. How does the customer want to be notified?">
                  <s-stack direction="block" gap="small">
                    <s-stack direction="inline" gap="base">
                      <ChoiceButton selected={channel === 'email'} disabled={Boolean(busy)} onClick={() => chooseChannel('email')}>
                        Email
                      </ChoiceButton>
                      <ChoiceButton selected={channel === 'sms'} disabled={Boolean(busy)} onClick={() => chooseChannel('sms')}>
                        SMS (text message)
                      </ChoiceButton>
                    </s-stack>
                    {!channel && <s-text color="subdued">Ask the customer: email or text message?</s-text>}
                  </s-stack>
                </s-section>

                {channel && (
                  <>
                    <s-section heading="2. Confirm customer's language">
                      <s-stack direction="block" gap="small">
                        <s-stack direction="inline" gap="base">
                          <ChoiceButton selected={language === 'en'} disabled={Boolean(busy)} onClick={() => setLanguage('en')}>
                            English
                          </ChoiceButton>
                          <ChoiceButton selected={language === 'fr'} disabled={Boolean(busy)} onClick={() => setLanguage('fr')}>
                            Français
                          </ChoiceButton>
                        </s-stack>
                        <s-text type="strong">Selected: {LANGUAGE_NAMES[language] || '—'}</s-text>
                        <s-text type="small" color="subdued">
                          Change the language if customer speaking the other one than selected.
                        </s-text>
                      </s-stack>
                    </s-section>

                    <s-section heading={channel === 'email' ? '3. Email' : '3. Mobile number (SMS)'}>
                      {contactSection()}
                    </s-section>

                    {channel === 'sms' && smsJustSubscribed && (
                      <ReplyYesWarning acknowledged={yesAck} onAcknowledge={() => setYesAck(true)} />
                    )}

                    {waitingHere > 0 && (
                      <s-text type="small" color="subdued">
                        This customer is already waiting for {waitingHere} product{waitingHere === 1 ? '' : 's'} (all stores).
                      </s-text>
                    )}

                    {confirmError && <s-banner tone="critical" heading="Not saved">{confirmError}</s-banner>}

                    <s-stack direction="block" gap="small">
                      {blocker && blocker !== 'incomplete' && (
                        blockerShown
                          ? <s-banner tone="critical">{blocker}</s-banner>
                          : <s-text color="subdued">{blocker}</s-text>
                      )}
                      {/* While something is missing the button looks inactive (secondary); tapping it only
                          turns the message above red, it never saves. */}
                      <s-button
                        variant={blocker ? 'secondary' : 'primary'}
                        disabled={Boolean(busy)}
                        onClick={() => (blocker ? setBlockerTapped(blocker) : confirm())}
                      >
                        {busy === 'confirm' ? 'Saving...' : `Confirm (${selected.length} product${selected.length === 1 ? '' : 's'})`}
                      </s-button>
                    </s-stack>
                  </>
                )}
              </>
            )}
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}
