import '@shopify/ui-extensions/preact';
import { useState, useEffect } from 'preact/hooks';

// Shared Hera_POS_aid backend (Render). Do not change: Apple Wallet cards also point here.
const SERVER_URL = 'https://search-0wf4.onrender.com';

// Thank you page: the order is still being created when the page opens, so the server answers
// { pending: true } for a few seconds. Ask again every 2 s, up to 30 s.
const POLL_MS = 2000;
const POLL_TRIES = 15;

async function post(path, body) {
  const token = await shopify.sessionToken.get();
  const resp = await fetch(`${SERVER_URL}/api/unit/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await resp.json(); } catch { /* not JSON */ }
  if (!resp.ok) {
    const err = new Error(data?.error || `HTTP ${resp.status}`);
    err.code = data?.error;
    throw err;
  }
  return data;
}

// Settings from the checkout editor (empty = first choice in shopify.extension.toml).
function readSettings() {
  const s = shopify.settings.value || {};
  const pick = (v, d) => (v === undefined || v === null || v === '' ? d : v);
  return {
    container: pick(s.container, 'banner'),
    bannerTone: pick(s.banner_tone, 'critical'),
    cardBackground: pick(s.card_background, 'subdued'),
    cardBorderWidth: pick(s.card_border_width, 'large-100'),
    cardBorderStyle: pick(s.card_border_style, 'solid'),
    cardRadius: pick(s.card_radius, 'base'),
    cardPadding: pick(s.card_padding, 'large'),
    titleTone: pick(s.title_tone, 'critical'),
    showPill: s.show_pill !== false,
    pillTone: pick(s.pill_tone, 'critical'),
    pillColor: pick(s.pill_color, 'base'),
    pillSize: pick(s.pill_size, 'base'),
    saveButton: pick(s.save_button, 'primary'),
    noneButton: pick(s.none_button, 'secondary'),
    raw: s,
  };
}

export function UnitCheck({ orderId, number }) {
  const [phase, setPhase] = useState('loading'); // loading | hidden | ask | confirm | done-unit | done-none
  const [unit, setUnit] = useState('');
  const [savedUnit, setSavedUnit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const cfg = readSettings();
  const fr = String(shopify.localization?.language?.value?.isoCode || '').toLowerCase().startsWith('fr');
  const t = (key, vars) => shopify.i18n.translate(key, vars);
  const text = (key) => String(cfg.raw[`${key}_${fr ? 'fr' : 'en'}`] || '').trim() || t(key);

  useEffect(() => {
    if (!orderId || !number) { setPhase('hidden'); return undefined; }
    let stopped = false;
    let tries = 0;
    let timer = null;
    const ask = async () => {
      tries += 1;
      try {
        const r = await post('status', { orderId, number });
        if (stopped) return;
        if (r.pending && tries < POLL_TRIES) { timer = setTimeout(ask, POLL_MS); return; }
        if (r.show) setPhase('ask');
        else if (r.answered === 'unit') setPhase('hidden');
        else setPhase('hidden');
      } catch {
        if (stopped) return;
        if (tries < 3) { timer = setTimeout(ask, POLL_MS); return; }
        setPhase('hidden'); // never block the page: the order keeps its "Check unit" tag for staff
      }
    };
    ask();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [orderId, number]);

  async function answer(choice) {
    setError('');
    if (choice === 'unit' && !unit.trim()) { setError(t('invalidUnit')); return; }
    setBusy(true);
    try {
      await post('answer', { orderId, number, choice, unit: choice === 'unit' ? unit : '' });
      if (choice === 'unit') { setSavedUnit(unit.trim()); setPhase('done-unit'); } else setPhase('done-none');
    } catch (err) {
      setError(err.code === 'invalid-unit' ? t('invalidUnit') : t('error'));
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'loading' || phase === 'hidden') return null;

  if (phase === 'done-unit' || phase === 'done-none') {
    return (
      <s-banner tone="success">
        <s-text>{phase === 'done-unit' ? t('doneUnit', { unit: savedUnit }) : t('doneNone')}</s-text>
      </s-banner>
    );
  }

  const heading = phase === 'confirm' ? t('confirmHeading') : text('heading');

  const content = phase === 'confirm' ? (
    <s-stack direction="block" gap="base">
      <s-paragraph>{text('disclaimer')}</s-paragraph>
      {error && <s-text tone="critical">{error}</s-text>}
      <s-stack direction="inline" gap="base">
        <s-button variant="primary" loading={busy} onClick={() => answer('none')}>{t('confirm')}</s-button>
        <s-button variant="secondary" disabled={busy} onClick={() => { setError(''); setPhase('ask'); }}>{t('back')}</s-button>
      </s-stack>
    </s-stack>
  ) : (
    <s-stack direction="block" gap="base">
      <s-paragraph>{text('body')}</s-paragraph>
      <s-text-field
        label={t('unitLabel')}
        value={unit}
        maxLength={20}
        error={error || undefined}
        onInput={(e) => setUnit(e.currentTarget.value)}
      />
      <s-stack direction="inline" gap="base">
        <s-button variant={cfg.saveButton} loading={busy} onClick={() => answer('unit')}>{t('save')}</s-button>
        <s-button variant={cfg.noneButton} disabled={busy} onClick={() => { setError(''); setPhase('confirm'); }}>{t('noUnit')}</s-button>
      </s-stack>
    </s-stack>
  );

  const pill = cfg.showPill && (
    <s-stack direction="inline">
      <s-badge tone={cfg.pillTone} color={cfg.pillColor} size={cfg.pillSize}>{t('pill')}</s-badge>
    </s-stack>
  );

  if (cfg.container === 'card') {
    return (
      <s-box
        padding={cfg.cardPadding}
        background={cfg.cardBackground}
        border={`${cfg.cardBorderWidth} base ${cfg.cardBorderStyle}`}
        borderRadius={cfg.cardRadius}
      >
        <s-stack direction="block" gap="base">
          {pill}
          {cfg.titleTone === 'auto'
            ? <s-heading>{heading}</s-heading>
            : <s-text type="strong" tone={cfg.titleTone}>{heading}</s-text>}
          {content}
        </s-stack>
      </s-box>
    );
  }

  return (
    <s-banner tone={cfg.bannerTone} heading={heading}>
      <s-stack direction="block" gap="base">
        {pill}
        {content}
      </s-stack>
    </s-banner>
  );
}
