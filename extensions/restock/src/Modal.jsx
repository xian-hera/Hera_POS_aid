import "@shopify/ui-extensions/preact";
import { render } from 'preact';
import { useState, useEffect, useRef, useErrorBoundary } from 'preact/hooks';

// Shared Hera_POS_aid backend (Render). Do not change: Apple Wallet cards also point here.
const SERVER_URL = "https://search-0wf4.onrender.com";

const MAX_ITEMS = 30;          // same limit as the server
const MAX_ROWS = 60;           // search results shown at once
const SEARCH_DELAY_MS = 350;   // wait for the cashier to stop typing

export default async () => {
  render(<Boundary><Extension /></Boundary>, document.body);
};

// A screen error is shown (and written to the server log) instead of leaving a frozen page.
function Boundary({ children }) {
  const [error, resetError] = useErrorBoundary((err) => report('render-error', String(err?.stack || err).slice(0, 400)));
  if (error) {
    return (
      <s-page heading="Restock Notify">
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-banner tone="critical" heading="Something went wrong">{String(error?.message || error)}</s-banner>
            <s-button onClick={resetError}>Try again</s-button>
          </s-stack>
        </s-box>
      </s-page>
    );
  }
  return children;
}

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

// One backend request at a time. The version that always worked made a single request at a time;
// the customer's list made two at once when the tile opened, and after that the answer for the
// customer page never reached the tile. So every call waits for the previous one to finish.
let apiQueue = Promise.resolve();
function api(path, body) {
  const run = apiQueue.then(() => apiNow(path, body));
  apiQueue = run.catch(() => {});
  return run;
}

async function apiNow(path, body) {
  // TEMPORARY trace (server log "[pos-ui] restock trace …"): where a request stops on the iPad
  // Each trace line is sent (and awaited) before the next step, so the last line in the log shows
  // the step that never finished, and there is still only one request at a time.
  const t0 = Date.now();
  const trace = (step) => sendLog(`trace ${path} ${step} +${Date.now() - t0}ms`);
  await trace('start');
  const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) };
  await trace(headers.Authorization ? 'token-ok' : 'token-none');
  const resp = await fetch(`${SERVER_URL}/api/restock/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  await trace(`answer-${resp.status}`);
  let data = null;
  try { data = await resp.json(); } catch (err) { await trace(`body-error ${err?.message || err}`); }
  await trace('body-read');
  if (!resp.ok) {
    if (resp.status === 401) throw new Error('This POS account cannot use this tile: in Shopify admin → Settings → Users, the role of the account logged in on this iPad needs access to the app Hera_POS_aid.');
    if (resp.status === 429) throw new Error('Too many requests, please wait a minute and try again.');
    throw new Error(data?.error || `Request failed (${resp.status})`);
  }
  return data;
}

// Send one log line now and wait for it (used inside the request queue).
async function sendLog(line) {
  try {
    const r = await fetch(`${SERVER_URL}/api/pos/clientlog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tile: 'restock', line: String(line).slice(0, 500), userId: shopify.session?.currentSession?.userId ?? null }),
    });
    await r.text();
  } catch { /* never break the tile for a log line */ }
}

// Diagnostics: short events in the server log as "[pos-ui] restock …" (no personal data).
// Log lines join the same queue as the backend calls: still only one request at a time.
function report(event, detail) {
  let line = '';
  let userId = null;
  try {
    line = `${event} ${detail ?? ''}`.slice(0, 500);
    userId = shopify.session?.currentSession?.userId ?? null;
  } catch { /* ignore */ }
  apiQueue = apiQueue
    .then(() => fetch(`${SERVER_URL}/api/pos/clientlog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tile: 'restock', line, userId }),
    }))
    .then((r) => r.text())
    .catch(() => {});
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

// ─── Search state (used by "Add Notify" and by "Check Item") ─────────────────

function useVariantSearch(locationId) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [state, setState] = useState('idle'); // idle | searching | done | error
  const [error, setError] = useState('');
  const seq = useRef(0);
  const timer = useRef(null);
  // After a pick, the search field must lose focus so the iPad keyboard closes.
  const fieldRef = useRef(null);
  const [fieldKey, setFieldKey] = useState(0);

  const run = async (text, onSingle) => {
    const q = text.trim();
    const mySeq = ++seq.current;
    if (q.length < 2) {
      setResults([]);
      setState('idle');
      return;
    }
    setState('searching');
    setError('');
    try {
      const rows = await searchVariants(q, locationId);
      if (mySeq !== seq.current) return; // a newer search started
      setResults(rows.slice(0, MAX_ROWS));
      setState('done');
      if (onSingle && rows.length === 1) onSingle(rows[0]);
    } catch (err) {
      if (mySeq !== seq.current) return;
      setResults([]);
      setError(err.message || 'Search failed, please try again.');
      setState('error');
    }
  };

  const clearTimer = () => { if (timer.current) clearTimeout(timer.current); };

  return {
    query, results, state, error, fieldRef, fieldKey,
    onInput(value) {
      setQuery(value);
      clearTimer();
      timer.current = setTimeout(() => run(value), SEARCH_DELAY_MS);
    },
    onChange(value) {
      clearTimer();
      run(value);
    },
    // A scanned barcode: search it; onSingle(row) runs when exactly one variant matches
    scan(value, onSingle) {
      clearTimer();
      setQuery(value);
      run(value, onSingle);
    },
    // Take the focus away from the search field (closes the on-screen keyboard).
    // blur() is the normal way; re-creating the field (new key) guarantees it on devices
    // where blur() is not passed on to the native field. The typed text and results stay.
    dismissKeyboard() {
      try { fieldRef.current?.blur?.(); } catch { /* not supported */ }
      setFieldKey((k) => k + 1);
    },
    reset() {
      clearTimer();
      seq.current += 1;
      setQuery('');
      setResults([]);
      setState('idle');
      setError('');
    },
  };
}

function SearchBlock({ search, placeholder, renderAction }) {
  return (
    <s-stack direction="block" gap="base">
      <s-search-field
        key={search.fieldKey}
        ref={search.fieldRef}
        placeholder={placeholder}
        value={search.query}
        onInput={(e) => search.onInput(e.currentTarget.value)}
        onChange={(e) => search.onChange(e.currentTarget.value)}
      />
      {search.state === 'searching' && <s-text color="subdued">Searching...</s-text>}
      {search.state === 'error' && <s-banner tone="critical" heading="Search failed">{search.error}</s-banner>}
      {search.state === 'done' && search.results.length === 0 && (
        <s-text color="subdued">No product found. Check the spelling or try the SKU.</s-text>
      )}
      {search.results.length > 0 && (
        <s-section heading={`Results (${search.results.length})`}>
          <s-stack direction="block" gap="base">
            {search.results.map((row) => (
              <VariantLine key={row.variantId} row={row} action={renderAction(row)} />
            ))}
          </s-stack>
        </s-section>
      )}
    </s-stack>
  );
}

// "Add Notify" | "Check Item"
function TabBar({ tab, onChange }) {
  return (
    <s-stack direction="inline" gap="base">
      <ChoiceButton selected={tab === 'add'} onClick={() => onChange('add')}>Add Notify</ChoiceButton>
      <ChoiceButton selected={tab === 'check'} onClick={() => onChange('check')}>Check Item</ChoiceButton>
    </s-stack>
  );
}

const fmtDate = (iso) => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return String(iso).slice(0, 10);
  }
};
const channelName = (ch) => (ch === 'sms' ? 'SMS' : 'Email');

// ─── Modal ───────────────────────────────────────────────────────────────────

function Extension() {
  const session = shopify.session.currentSession;
  const locationId = session?.locationId;
  const staffId = session?.staffMemberId;

  const [customerId, setCustomerId] = useState(() => {
    try {
      const id = shopify.cart.current.value?.customer?.id;
      return id ? String(id) : null;
    } catch {
      return null;
    }
  });

  const [tab, setTab] = useState('add'); // add | check
  // Add Notify steps: list (what the customer already waits for here) | products | customer | done
  const [step, setStep] = useState(customerId ? 'list' : 'products');

  // customer's list (this store)
  const [listItems, setListItems] = useState([]);
  const [listState, setListState] = useState('idle'); // idle | loading | ready | error
  const [listError, setListError] = useState('');
  const [listName, setListName] = useState('');
  const [removing, setRemoving] = useState('');       // variantId being removed
  const [confirmRemove, setConfirmRemove] = useState(''); // variantId waiting for the second tap
  const listSeq = useRef(0);

  // products page
  const addSearch = useVariantSearch(locationId);
  const [selected, setSelected] = useState([]);
  const selectedRef = useRef([]);
  const stepRef = useRef(step);
  const tabRef = useRef(tab);

  // Check Item
  const checkSearch = useVariantSearch(locationId);
  const [checkRow, setCheckRow] = useState(null);
  const [checkData, setCheckData] = useState(null);
  const [checkState, setCheckState] = useState('idle'); // idle | loading | ready | error
  const [checkError, setCheckError] = useState('');
  const checkSeq = useRef(0);

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
  tabRef.current = tab;

  // TEMPORARY trace: every screen change after it is shown on the iPad
  useEffect(() => {
    report('trace', `screen ${tab}/${step} customer=${customerState} list=${listState}`);
  }, [tab, step, customerState, listState]);

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

  // ── customer's list at this store ──
  // skipWhenEmpty: on opening, an empty list goes straight to the products page
  const loadList = async ({ skipWhenEmpty = false } = {}) => {
    if (!customerId) return;
    const mySeq = ++listSeq.current;
    setListState('loading');
    setListError('');
    setConfirmRemove('');
    try {
      // one after the other (see api())
      const data = await api('waiting', { customerId, locationId: String(locationId) });
      const c = await api('customer', { customerId }).catch(() => null);
      if (mySeq !== listSeq.current) return;
      const items = data?.items || [];
      setListItems(items);
      setListName(c ? `${c.firstName || ''} ${c.lastName || ''}`.trim() : '');
      setListState('ready');
      if (skipWhenEmpty && !items.length && stepRef.current === 'list') setStep('products');
    } catch (err) {
      if (mySeq !== listSeq.current) return;
      setListError(err.message || 'Could not load the list.');
      setListState('error');
    }
  };

  const removeFromList = async (item) => {
    if (confirmRemove !== item.variantId) {
      setConfirmRemove(item.variantId); // first tap: ask to tap again
      return;
    }
    setConfirmRemove('');
    setRemoving(item.variantId);
    try {
      const data = await api('remove', { customerId, locationId: String(locationId), variantId: item.variantId });
      setListItems(data?.items || []);
      shopify.toast.show(`Removed ${item.sku || item.productTitle}`);
    } catch (err) {
      shopify.toast.show(err.message || 'Could not remove, please try again.');
    } finally {
      setRemoving('');
    }
  };

  // ── Add Notify: pick products ──
  const isSelected = (variantId) => selected.some((s) => s.variantId === variantId);
  const alreadyWaiting = (variantId) => listItems.some((i) => i.variantId === variantId);
  const alreadyWaitingRef = useRef(alreadyWaiting);
  alreadyWaitingRef.current = alreadyWaiting;

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
    addSearch.dismissKeyboard();
  };

  const removeItem = (variantId) => {
    const next = selectedRef.current.filter((s) => s.variantId !== variantId);
    selectedRef.current = next;
    setSelected(next);
  };

  // ── Check Item ──
  const openCheck = async (row) => {
    const mySeq = ++checkSeq.current;
    checkSearch.dismissKeyboard();
    setCheckRow(row);
    setCheckData(null);
    setCheckState('loading');
    setCheckError('');
    try {
      const data = await api('item', { locationId: String(locationId), variantId: row.variantId });
      if (mySeq !== checkSeq.current) return;
      setCheckData(data);
      setCheckState('ready');
    } catch (err) {
      if (mySeq !== checkSeq.current) return;
      setCheckError(err.message || 'Could not load the list.');
      setCheckState('error');
    }
  };

  const closeCheck = () => {
    checkSeq.current += 1;
    setCheckRow(null);
    setCheckData(null);
    setCheckState('idle');
  };

  // Scanning a product barcode: on "Add Notify" it adds the product (one match),
  // on "Check Item" it opens the list of waiting customers (one match).
  const scanHandler = useRef(null);
  scanHandler.current = (value) => {
    if (tabRef.current === 'check') {
      closeCheck();
      checkSearch.scan(value, openCheck);
    } else if (stepRef.current === 'products' || stepRef.current === 'list') {
      // scanning on the customer's list goes straight to adding that product
      if (stepRef.current === 'list') setStep('products');
      addSearch.scan(value, (row) => { if (!alreadyWaitingRef.current(row.variantId)) addItem(row); });
    }
  };
  useEffect(() => {
    let ready = false;
    const readyTimer = setTimeout(() => { ready = true; }, 400); // ignore a replayed previous scan
    const unsubscribe = shopify.scanner.scannerData.current.subscribe((result) => {
      if (!ready || !result?.data) return;
      const value = String(result.data).trim();
      if (value) scanHandler.current(value);
    });
    return () => {
      clearTimeout(readyTimer);
      unsubscribe();
    };
  }, []);

  // ── customer ──
  const applyCustomer = (data) => setCustomer(data);

  const loadCustomer = async () => {
    if (!customerId) return;
    setCustomerState('loading');
    setCustomerError('');
    try {
      const data = await api('customer', { customerId });
      report('trace', `page2 got customer data (${data ? 'yes' : 'no'})`);
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
    // Another customer was logged in while the modal is open
    resetCustomerChoices();
    setListItems([]);
    setListName('');
    setListState('idle');
    if (step === 'customer') {
      setCustomer(null);
      if (customerId) loadCustomer(); else setCustomerState('idle');
    } else if (step === 'list' || step === 'products') {
      if (customerId) {
        setStep('list');
        loadList({ skipWhenEmpty: true });
      } else {
        setStep('products');
      }
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
    // Just subscribed here: Klaviyo only confirms after the customer replies YES, so trust the tap (+ YES reminder)
    if (channel === 'sms' && !c.smsSubscribed && !smsJustSubscribed) return 'Text messages need an SMS subscription: tap Subscribe above if the customer agrees, or choose Email.';
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
        // Case C: SMS subscribed on this screen -> Klaviyo must wait for the customer's YES
        smsJustSubscribed: channel === 'sms' && smsJustSubscribed,
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
    addSearch.reset();
    setCustomer(null);
    setDoneInfo(null);
    resetCustomerChoices();
    setStep(customerId ? 'list' : 'products');
    if (customerId) loadList();
  };

  const switchTab = (next) => {
    if (next === tab) return;
    setTab(next);
    if (next === 'add' && step === 'list' && customerId) loadList(); // the list may have changed
  };

  // ─── Check Item: who waits for a product at this store ─────────────────────
  if (tab === 'check') {
    const list = checkData?.customers || [];
    return (
      <s-page heading="Restock Notify" subheading="Check Item · this store">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack direction="block" gap="base">
              <TabBar tab={tab} onChange={switchTab} />
              {!checkRow ? (
                <>
                  <s-text color="subdued">
                    Search or scan a product to see which customers are waiting for it at this store.
                  </s-text>
                  <SearchBlock
                    search={checkSearch}
                    placeholder="Search name, SKU, or scan directly."
                    renderAction={(row) => <s-button variant="primary" onClick={() => openCheck(row)}>Check</s-button>}
                  />
                </>
              ) : (
                <>
                  <s-button onClick={closeCheck}>Back to search</s-button>
                  <VariantLine row={{ ...checkRow, available: checkData?.available ?? checkRow.available }} />
                  {checkState === 'loading' && <s-text color="subdued">Loading...</s-text>}
                  {checkState === 'error' && (
                    <s-stack direction="block" gap="base">
                      <s-banner tone="critical" heading="Could not load the list">{checkError}</s-banner>
                      <s-button onClick={() => openCheck(checkRow)}>Try again</s-button>
                    </s-stack>
                  )}
                  {checkState === 'ready' && (
                    <s-section heading={`${list.length} customer${list.length === 1 ? '' : 's'} waiting at this store`}>
                      <s-stack direction="block" gap="base">
                        {list.length === 0 && <s-text color="subdued">Nobody is waiting for this product at this store.</s-text>}
                        {list.length > 0 && checkData?.threshold != null && (
                          <s-text type="small" color="subdued">
                            They are notified at the next check (10:00 or 16:00) once stock here reaches {checkData.threshold}.
                          </s-text>
                        )}
                        {list.map((p) => (
                          <s-stack key={p.customerId} direction="block" gap="none">
                            <s-text type="strong">{p.name}</s-text>
                            {p.phone && <s-text>{p.phone}</s-text>}
                            {p.email && <s-text>{p.email}</s-text>}
                            <s-text type="small" color="subdued">
                              Since {fmtDate(p.requestedAt)} · by {channelName(p.channel)}
                            </s-text>
                          </s-stack>
                        ))}
                      </s-stack>
                    </s-section>
                  )}
                </>
              )}
            </s-stack>
          </s-box>
        </s-scroll-box>
      </s-page>
    );
  }

  // ─── Customer's list (before adding) ───────────────────────────────────────
  if (step === 'list') {
    return (
      <s-page heading="Restock Notify" subheading="Customer's list · this store">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack direction="block" gap="base">
              <TabBar tab={tab} onChange={switchTab} />
              <s-button variant="primary" onClick={() => setStep('products')}>Add</s-button>
              {listState === 'loading' && <s-text color="subdued">Loading the customer's list...</s-text>}
              {listState === 'error' && (
                <s-stack direction="block" gap="base">
                  <s-banner tone="critical" heading="Could not load the list">{listError}</s-banner>
                  <s-button onClick={() => loadList()}>Try again</s-button>
                </s-stack>
              )}
              {listState === 'ready' && (
                <s-section heading={`${listName || 'Customer'} is waiting for (${listItems.length})`}>
                  <s-stack direction="block" gap="base">
                    {listItems.length === 0 && <s-text color="subdued">Nothing waiting at this store.</s-text>}
                    {listItems.map((item) => (
                      <s-stack key={item.variantId} direction="block" gap="none">
                        <VariantLine
                          row={item}
                          action={
                            <s-button
                              tone="critical"
                              variant={confirmRemove === item.variantId ? 'primary' : 'secondary'}
                              disabled={Boolean(removing)}
                              onClick={() => removeFromList(item)}
                            >
                              {removing === item.variantId ? 'Removing...' : confirmRemove === item.variantId ? 'Tap again to remove' : 'Remove'}
                            </s-button>
                          }
                        />
                        <s-text type="small" color="subdued">
                          {item.deleted ? 'Product no longer in Shopify · ' : ''}Since {fmtDate(item.requestedAt)} · by {channelName(item.channel)}
                        </s-text>
                      </s-stack>
                    ))}
                  </s-stack>
                </s-section>
              )}
            </s-stack>
          </s-box>
        </s-scroll-box>
      </s-page>
    );
  }

  // ─── Page 1: products ──────────────────────────────────────────────────────
  if (step === 'products') {
    return (
      <s-page heading="Restock Notify" subheading="1 of 2 · Products">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack direction="block" gap="base">
              <TabBar tab={tab} onChange={switchTab} />
              {customerId && listItems.length > 0 && (
                <s-button onClick={() => { setStep('list'); loadList(); }}>
                  Back to the customer's list ({listItems.length})
                </s-button>
              )}
              {!customerId && (
                <s-banner tone="warning" heading="No customer logged in">
                  You can pick the products now, but log in the customer (Customer Login tile or cart) before going to the next step.
                </s-banner>
              )}
              <s-text color="subdued">
                Search by name, SKU or scan the product. Tap Add for each product the customer wants.
              </s-text>

              <SearchBlock
                search={addSearch}
                placeholder="Search name, SKU, or scan directly."
                renderAction={(row) =>
                  isSelected(row.variantId)
                    ? <s-button disabled>Added</s-button>
                    : alreadyWaiting(row.variantId)
                      ? <s-button disabled>Already waiting</s-button>
                      : <s-button variant="primary" onClick={() => addItem(row)}>Add</s-button>
                }
              />

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
    const subscribed = isEmail ? c.emailSubscribed : (c.smsSubscribed || smsJustSubscribed);
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
