import "@shopify/ui-extensions/preact";
import { render } from 'preact';
import { useState, useEffect, useErrorBoundary } from 'preact/hooks';

// Shared Hera_POS_aid backend (Render). Do not change: Apple Wallet cards also point here.
const SERVER_URL = "https://search-0wf4.onrender.com";

// IMPORTANT (lesson from Restock Notify, Oct 2026): never change page by itself in a modal.
// A page change that happened on its own after a network answer froze every later screen update
// on the iPad. Here every page change happens inside the cashier's tap. Saving and deleting are
// "optimistic": the list is updated at once and the server is asked afterwards; if the server
// says no, a banner explains it (and a failed text can be reopened).

const UNLOCK_STORAGE_KEY = 'memo-global-unlock';
const MAX_TITLE = 80;
const MAX_BODY = 4000;
const PILL_RE = /\[([^\[\]\n]{1,40})\]/g;

export default async () => {
  render(<Boundary><Extension /></Boundary>, document.body);
};

// A screen error is shown (and written to the server log) instead of leaving a frozen page.
function Boundary({ children }) {
  const [error, resetError] = useErrorBoundary((err) => report('render-error', String(err?.stack || err).slice(0, 400)));
  if (error) {
    return (
      <s-page heading="MEMO">
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
  try {
    const token = await shopify.session.getSessionToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

// One backend request at a time (same rule as the other tiles).
let apiQueue = Promise.resolve();
function api(path, body) {
  const run = apiQueue.then(() => apiNow(path, body));
  apiQueue = run.catch(() => {});
  return run;
}

async function apiNow(path, body) {
  const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) };
  const resp = await fetch(`${SERVER_URL}/api/memo/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await resp.json(); } catch { /* non-JSON response */ }
  if (!resp.ok) {
    let message = data?.error || `Request failed (${resp.status})`;
    if (resp.status === 401 && !data?.wrongPassword) message = 'This POS account cannot use this tile: in Shopify admin → Settings → Users, the role of the account logged in on this iPad needs access to the app Hera_POS_aid.';
    if (resp.status === 429 && !data?.error) message = 'Too many requests, please wait a minute and try again.';
    const err = new Error(message);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Diagnostics: short events in the server log as "[pos-ui] memo …" (no memo text).
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
      body: JSON.stringify({ tile: 'memo', line, userId }),
    }))
    .then((r) => r.text())
    .catch(() => {});
}

function sessionInfo() {
  try {
    const s = shopify.session.currentSession || {};
    return { locationId: String(s.locationId ?? ''), staffId: String(s.staffMemberId ?? '') };
  } catch {
    return { locationId: '', staffId: '' };
  }
}

// ─── Text display ────────────────────────────────────────────────────────────
// The memo text is shown line by line, exactly as typed. An empty line adds space.
// [Name] is shown as a pill, e.g. "[Chambly] 450 555 1234".

const clip = (s, n) => (n && s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

function splitPills(line) {
  const parts = [];
  let last = 0;
  for (const m of line.matchAll(PILL_RE)) {
    if (m.index > last) parts.push({ text: line.slice(last, m.index) });
    parts.push({ pill: m[1].trim() });
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push({ text: line.slice(last) });
  return parts.filter((p) => p.pill || p.text.trim());
}

function MemoText({ text, maxLines, maxChars }) {
  const lines = String(text || '').split('\n');
  if (!text) return null;
  const shown = maxLines ? lines.slice(0, maxLines) : lines;
  const more = maxLines && lines.length > maxLines;
  return (
    <s-stack direction="block" gap="small-300">
      {shown.map((line, i) => {
        if (!line.trim()) return <s-box key={i} paddingBlock="small-200" />;
        const parts = splitPills(line);
        if (!parts.some((p) => p.pill)) return <s-text key={i}>{clip(line, maxChars)}</s-text>;
        return (
          <s-stack key={i} direction="inline" gap="small-200" alignItems="center">
            {parts.map((p, j) => (p.pill
              ? <s-badge key={j}>{clip(p.pill, maxChars)}</s-badge>
              : <s-text key={j}>{clip(p.text.trim(), maxChars)}</s-text>))}
          </s-stack>
        );
      })}
      {more && <s-text color="subdued">…</s-text>}
    </s-stack>
  );
}

// ─── Cards ───────────────────────────────────────────────────────────────────
// Grid: cards wrap in rows. Small = 1/5 of the width, Large = 2/5.
// Fewer cards = taller cards with more text; many cards = short cards (title + a few lines).

function tierFor(count) {
  if (count <= 5) return { height: '240px', lines: 12 };
  if (count <= 10) return { height: '170px', lines: 7 };
  return { height: '120px', lines: 3 };
}

function sortMemos(list) {
  return [...list].sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || a.title.localeCompare(b.title));
}

function MemoCard({ memo, tier, onOpen }) {
  const wide = memo.size === 'L';
  return (
    <s-box inlineSize={wide ? '39%' : '19%'} minBlockSize={tier.height}>
      <s-clickable onClick={onOpen}>
        <s-section>
          <s-stack direction="block" gap="small-200">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              {memo.pinned && <s-text tone="critical">●</s-text>}
              <s-text type="strong">{clip(memo.title, wide ? 64 : 28)}</s-text>
            </s-stack>
            <MemoText text={memo.body} maxLines={tier.lines} maxChars={wide ? 60 : 26} />
            {memo.saving && <s-text type="small" color="subdued">Saving...</s-text>}
          </s-stack>
        </s-section>
      </s-clickable>
    </s-box>
  );
}

// A choice where exactly one option is selected (same look as Restock Notify).
function ChoiceButton({ selected, disabled, onClick, children }) {
  return (
    <s-button variant={selected ? 'primary' : 'secondary'} disabled={disabled} onClick={onClick}>
      {selected ? '✓ ' : ''}{children}
    </s-button>
  );
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ─── Main ────────────────────────────────────────────────────────────────────

function Extension() {
  const [page, setPage] = useState('list');        // list | detail | edit | unlock
  const [tab, setTab] = useState('local');         // local | global
  const [data, setData] = useState(null);          // { locationName, local, global, unlockAvailable }
  const [loadState, setLoadState] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState(null);      // { tone, text, draft? }
  const [openId, setOpenId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState('');
  const [busy, setBusy] = useState(null);          // 'pin' while pin/unpin is saving
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [unlock, setUnlock] = useState(null);      // { token, expiresAt }
  const [now, setNow] = useState(Date.now());
  const [password, setPassword] = useState('');
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState('');

  const { locationId, staffId } = sessionInfo();
  const globalUnlocked = Boolean(unlock && unlock.expiresAt > now);
  const minutesLeft = globalUnlocked ? Math.max(1, Math.ceil((unlock.expiresAt - now) / 60000)) : 0;
  const unlockToken = globalUnlocked ? unlock.token : undefined;
  const locationName = data?.locationName || 'This store';
  const canEditScope = (scope) => scope !== 'global' || globalUnlocked;

  // Start: load the memos and a still-valid unlock of this iPad. No page change here.
  useEffect(() => {
    loadList();
    try {
      shopify.storage.get(UNLOCK_STORAGE_KEY)
        .then((v) => { if (v?.token && v.expiresAt > Date.now()) setUnlock(v); })
        .catch(() => {});
    } catch { /* storage not available */ }
    const timer = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(timer);
  }, []);

  function loadList() {
    setLoadState('loading');
    setLoadError('');
    api('list', { locationId })
      .then((d) => { setData(d); setLoadState('ready'); })
      .catch((err) => { setLoadError(err.message); setLoadState('error'); });
  }

  // ── Local list changes ──
  const listKey = (scope) => (scope === 'global' ? 'global' : 'local');
  function putMemo(memo, replaceId = memo.id) {
    setData((d) => {
      if (!d) return d;
      const key = listKey(memo.scope);
      const list = d[key].some((m) => m.id === replaceId)
        ? d[key].map((m) => (m.id === replaceId ? memo : m))
        : [...d[key], memo];
      return { ...d, [key]: list };
    });
  }
  function dropMemo(id) {
    setData((d) => (d ? { ...d, local: d.local.filter((m) => m.id !== id), global: d.global.filter((m) => m.id !== id) } : d));
  }
  const findMemo = (id) => data?.local.find((m) => m.id === id) || data?.global.find((m) => m.id === id) || null;

  // The server says Global is locked (time over / password changed): lock this iPad too.
  function forgetUnlockIfRefused(err) {
    if (err?.data?.locked) {
      setUnlock(null);
      try { shopify.storage.delete(UNLOCK_STORAGE_KEY).catch(() => {}); } catch { /* ignore */ }
    }
  }

  // ── Taps ──
  function openMemo(memo) {
    setOpenId(memo.id);
    setConfirmDelete(false);
    setPage('detail');
  }

  function startNew() {
    setDraft({ scope: tab === 'global' ? 'global' : 'location', title: '', body: '', size: 'S', pinned: false });
    setDraftError('');
    setPage('edit');
  }

  function startEdit(memo) {
    setDraft({ id: memo.id, scope: memo.scope, title: memo.title, body: memo.body, size: memo.size, pinned: memo.pinned, baseRev: memo.rev });
    setDraftError('');
    setPage('edit');
  }

  function reopenDraft(d) {
    setDraft(d);
    setDraftError('');
    setNotice(null);
    setPage('edit');
  }

  function save() {
    const d = draft;
    const title = d.title.trim();
    if (!title) { setDraftError('Please enter a title.'); return; }
    if (!canEditScope(d.scope)) { setDraftError('Global is locked: go back, tap the lock and enter the password.'); return; }
    const payload = { locationId, staffId, unlockToken, title, body: d.body, size: d.size, pinned: d.pinned };

    if (d.id) {
      const before = findMemo(d.id);
      putMemo({ ...before, title, body: d.body, size: d.size, pinned: d.pinned, saving: true });
      setOpenId(d.id);
      setConfirmDelete(false);
      setPage('detail');
      api('save', { ...payload, id: d.id, baseRev: d.baseRev })
        .then((r) => putMemo(r.memo))
        .catch((err) => {
          forgetUnlockIfRefused(err);
          if (err.data?.current) putMemo(err.data.current);
          else if (before) putMemo(before);
          else dropMemo(d.id);
          setNotice({ tone: 'critical', text: `"${clip(title, 40)}" was not saved: ${err.message}`, draft: d });
        });
      return;
    }

    const tempId = `new-${Date.now()}`;
    putMemo({ id: tempId, scope: d.scope, locationId, title, body: d.body, size: d.size, pinned: d.pinned, updatedAt: '', saving: true });
    setTab(d.scope === 'global' ? 'global' : 'local');
    setPage('list');
    api('save', { ...payload, scope: d.scope })
      .then((r) => {
        putMemo(r.memo, tempId);
        setOpenId((cur) => (cur === tempId ? r.memo.id : cur));
      })
      .catch((err) => {
        forgetUnlockIfRefused(err);
        dropMemo(tempId);
        setNotice({ tone: 'critical', text: `"${clip(title, 40)}" was not saved: ${err.message}`, draft: d });
      });
  }

  function togglePin(memo) {
    setBusy('pin');
    api('save', { locationId, staffId, unlockToken, id: memo.id, pinned: !memo.pinned })
      .then((r) => putMemo(r.memo))
      .catch((err) => {
        forgetUnlockIfRefused(err);
        setNotice({ tone: 'critical', text: `Could not ${memo.pinned ? 'unpin' : 'pin'}: ${err.message}` });
      })
      .finally(() => setBusy(null));
  }

  function deleteMemo(memo) {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setConfirmDelete(false);
    dropMemo(memo.id);
    setPage('list');
    api('delete', { locationId, unlockToken, id: memo.id })
      .catch((err) => {
        forgetUnlockIfRefused(err);
        putMemo(memo);
        setNotice({ tone: 'critical', text: `"${clip(memo.title, 40)}" was not deleted: ${err.message}` });
      });
  }

  function doUnlock() {
    if (!password) { setUnlockError('Please enter the password.'); return; }
    setUnlockBusy(true);
    setUnlockError('');
    api('unlock', { locationId, password })
      .then((r) => {
        const value = { token: r.token, expiresAt: r.expiresAt };
        setUnlock(value);
        setNow(Date.now());
        setPassword('');
        try { shopify.storage.set(UNLOCK_STORAGE_KEY, value).catch(() => {}); } catch { /* ignore */ }
      })
      .catch((err) => setUnlockError(err.message))
      .finally(() => setUnlockBusy(false));
  }

  function lockNow() {
    setUnlock(null);
    try { shopify.storage.delete(UNLOCK_STORAGE_KEY).catch(() => {}); } catch { /* ignore */ }
  }

  function backToList() {
    setConfirmDelete(false);
    setPage('list');
  }

  const noticeBanner = notice && (
    <s-stack direction="block" gap="small">
      <s-banner tone={notice.tone} heading={notice.text} />
      <s-stack direction="inline" gap="base">
        {notice.draft && <s-button onClick={() => reopenDraft(notice.draft)}>Open my text again</s-button>}
        <s-button onClick={() => setNotice(null)}>OK</s-button>
      </s-stack>
    </s-stack>
  );

  // ─── Unlock Global ─────────────────────────────────────────────────────────
  if (page === 'unlock') {
    return (
      <s-page heading="MEMO" subheading="Unlock Global">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base">
                <s-button onClick={() => { setTab('global'); setUnlockError(''); setPage('list'); }}>‹ Back to Global</s-button>
              </s-stack>
              {globalUnlocked ? (
                <s-banner tone="success" heading={`Global is unlocked on this iPad for ${minutesLeft} min`} />
              ) : (
                <s-stack direction="block" gap="base">
                  <s-text>Enter the MEMO password to add, edit, pin or delete Global memos on this iPad for 30 minutes.</s-text>
                  <s-text-field
                    label="Password"
                    value={password}
                    disabled={unlockBusy}
                    onInput={(e) => setPassword(e.currentTarget.value)}
                  />
                  {unlockError && <s-banner tone="critical" heading={unlockError} />}
                  <s-stack direction="inline" gap="base">
                    <s-button variant="primary" disabled={unlockBusy} onClick={doUnlock}>
                      {unlockBusy ? 'Checking...' : 'Unlock'}
                    </s-button>
                  </s-stack>
                </s-stack>
              )}
            </s-stack>
          </s-box>
        </s-scroll-box>
      </s-page>
    );
  }

  // ─── New / edit ────────────────────────────────────────────────────────────
  if (page === 'edit' && draft) {
    const scopeName = draft.scope === 'global' ? 'Global' : locationName;
    return (
      <s-page heading="MEMO" subheading={`${draft.id ? 'Edit memo' : 'New memo'} · ${scopeName}`}>
        <s-scroll-box>
          <s-box padding="base">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center">
                <s-button onClick={() => setPage(draft.id && findMemo(draft.id) ? 'detail' : 'list')}>Cancel</s-button>
                <s-button variant="primary" onClick={save}>Save</s-button>
              </s-stack>
              {draftError && <s-banner tone="critical" heading={draftError} />}
              <s-text-field
                label="Title"
                value={draft.title}
                maxLength={MAX_TITLE}
                onInput={(e) => setDraft({ ...draft, title: e.currentTarget.value })}
              />
              <s-text-area
                label="Text"
                rows={10}
                maxLength={MAX_BODY}
                value={draft.body}
                onInput={(e) => setDraft({ ...draft, body: e.currentTarget.value })}
              />
              <s-text type="small" color="subdued">
                One item per line. An empty line adds space. Put a name in [brackets] to show it as a pill, e.g. [Chambly] 450 555 1234
              </s-text>
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-text>Card size</s-text>
                <ChoiceButton selected={draft.size === 'S'} onClick={() => setDraft({ ...draft, size: 'S' })}>Small</ChoiceButton>
                <ChoiceButton selected={draft.size === 'L'} onClick={() => setDraft({ ...draft, size: 'L' })}>Large</ChoiceButton>
                <s-text>Pinned</s-text>
                <ChoiceButton selected={!draft.pinned} onClick={() => setDraft({ ...draft, pinned: false })}>No</ChoiceButton>
                <ChoiceButton selected={draft.pinned} onClick={() => setDraft({ ...draft, pinned: true })}>Yes</ChoiceButton>
              </s-stack>
              <s-section heading="Preview">
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">{draft.title || 'Title'}</s-text>
                  <MemoText text={draft.body} />
                </s-stack>
              </s-section>
            </s-stack>
          </s-box>
        </s-scroll-box>
      </s-page>
    );
  }

  // ─── Memo details ──────────────────────────────────────────────────────────
  if (page === 'detail') {
    const memo = findMemo(openId);
    const editable = memo && canEditScope(memo.scope) && !memo.saving;
    return (
      <s-page heading="MEMO" subheading={memo?.scope === 'global' ? 'Global · all stores' : `${locationName} · this store`}>
        <s-scroll-box>
          <s-box padding="base">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center">
                <s-button onClick={backToList}>‹ Back</s-button>
                {memo && (editable
                  ? <s-button variant="primary" onClick={() => startEdit(memo)}>Edit</s-button>
                  : memo.scope === 'global' && !globalUnlocked && <s-text color="subdued">🔒 Global is locked</s-text>)}
              </s-stack>
              {noticeBanner}
              {!memo ? (
                <s-text color="subdued">This memo no longer exists.</s-text>
              ) : (
                <s-stack direction="block" gap="base">
                  <s-section>
                    <s-stack direction="block" gap="base">
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        {memo.pinned && <s-text tone="critical">●</s-text>}
                        <s-heading>{memo.title}</s-heading>
                      </s-stack>
                      <MemoText text={memo.body} />
                    </s-stack>
                  </s-section>
                  <s-text type="small" color="subdued">
                    {memo.saving ? 'Saving...' : `Updated ${fmtDate(memo.updatedAt)}`} · {memo.size === 'L' ? 'Large' : 'Small'} card
                  </s-text>
                  {editable && (
                    <s-stack direction="inline" gap="base">
                      <s-button disabled={busy === 'pin'} onClick={() => togglePin(memo)}>
                        {busy === 'pin' ? 'Saving...' : memo.pinned ? 'Unpin' : 'Pin to top'}
                      </s-button>
                      <s-button
                        tone="critical"
                        variant={confirmDelete ? 'primary' : 'secondary'}
                        onClick={() => deleteMemo(memo)}
                      >
                        {confirmDelete ? 'Tap again to delete' : 'Delete'}
                      </s-button>
                    </s-stack>
                  )}
                </s-stack>
              )}
            </s-stack>
          </s-box>
        </s-scroll-box>
      </s-page>
    );
  }

  // ─── List (default) ────────────────────────────────────────────────────────
  const memos = sortMemos(tab === 'global' ? (data?.global || []) : (data?.local || []));
  const tier = tierFor(memos.length);
  const tabEditable = canEditScope(tab === 'global' ? 'global' : 'location');
  return (
    <s-page heading="MEMO" subheading={tab === 'global' ? 'Global · all stores' : data ? `${locationName} · this store` : 'This store'}>
      <s-scroll-box>
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center">
              <s-stack direction="inline" gap="small">
                <ChoiceButton selected={tab === 'local'} onClick={() => setTab('local')}>{locationName}</ChoiceButton>
                <ChoiceButton selected={tab === 'global'} onClick={() => setTab('global')}>Global</ChoiceButton>
              </s-stack>
              <s-stack direction="inline" gap="small">
                {tab === 'global' && (globalUnlocked
                  ? <s-button onClick={lockNow}>🔓 {minutesLeft} min · Lock</s-button>
                  : <s-button onClick={() => { setUnlockError(''); setPage('unlock'); }}>🔒 Locked</s-button>)}
                <s-button onClick={loadList}>Refresh</s-button>
                <s-button variant="primary" disabled={!tabEditable || loadState !== 'ready'} onClick={startNew}>Add</s-button>
              </s-stack>
            </s-stack>
            {noticeBanner}
            {loadState === 'loading' && <s-text color="subdued">Loading memos...</s-text>}
            {loadState === 'error' && (
              <s-stack direction="block" gap="base">
                <s-banner tone="critical" heading="Could not load the memos">{loadError}</s-banner>
                <s-button onClick={loadList}>Try again</s-button>
              </s-stack>
            )}
            {loadState === 'ready' && memos.length === 0 && (
              <s-text color="subdued">
                {tab === 'global'
                  ? (globalUnlocked ? 'No Global memos yet. Tap Add.' : 'No Global memos yet. Unlock to add one.')
                  : 'No memos for this store yet. Tap Add.'}
              </s-text>
            )}
            {loadState === 'ready' && memos.length > 0 && (
              <s-stack direction="inline" gap="small">
                {memos.map((m) => <MemoCard key={m.id} memo={m} tier={tier} onOpen={() => openMemo(m)} />)}
              </s-stack>
            )}
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}
