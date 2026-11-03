import '@shopify/ui-extensions/preact';
import { useState, useEffect } from 'preact/hooks';

// Shared Hera_POS_aid backend (Render). Do not change: Apple Wallet cards also point here.
const SERVER_URL = 'https://search-0wf4.onrender.com';

// Thank you page: the order is still being created when the page opens, so the server answers
// { pending: true } for a few seconds. Ask again every 2 s, up to 30 s.
const POLL_MS = 2000;
const POLL_TRIES = 15;

// Texts come from the metaobject "Unit No. Alert texts" (server, keys like "no_unit");
// an empty field falls back to locales/*.json (keys like "noUnit").
const LOCALE_KEY = {
  pill: 'pill', heading: 'heading', body: 'body', unit_label: 'unitLabel', save: 'save', no_unit: 'noUnit',
  confirm_heading: 'confirmHeading', disclaimer: 'disclaimer', confirm: 'confirm', back: 'back',
  done_unit: 'doneUnit', done_none: 'doneNone', invalid_unit: 'invalidUnit', error: 'error',
};

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

// Style settings from the checkout editor (empty = default). The rest of the look is fixed:
// critical banner, pill neutral / base.
function readSettings() {
  const s = shopify.settings.value || {};
  const pick = (v, d) => (v === undefined || v === null || v === '' ? d : v);
  return {
    showPill: s.show_pill !== false,
    inlineTitle: pick(s.title_layout, 'banner') === 'inline',
    fill: pick(s.button_width, 'fit') === 'fill',
    primaryVariant: pick(s.primary_variant, 'primary'),
    primaryTone: pick(s.primary_tone, 'auto'),
    secondaryVariant: pick(s.secondary_variant, 'secondary'),
    secondaryTone: pick(s.secondary_tone, 'auto'),
    bodyTone: pick(s.body_tone, 'base'),
  };
}

// <s-paragraph> props for the body color setting.
const bodyProps = (tone) => (tone === 'base' ? {} : tone === 'subdued' ? { color: 'subdued' } : { tone });

export function UnitCheck({ orderId, number }) {
  // In the checkout editor the order is a sample: always show the question (no order check),
  // so the block and its settings can be previewed. The buttons only change the preview.
  const inEditor = Boolean(shopify.extension?.editor);
  const [phase, setPhase] = useState(inEditor ? 'ask' : 'loading'); // loading | hidden | ask | confirm | done-unit | done-none
  const [texts, setTexts] = useState(null);   // { en: {...}, fr: {...} } from the metaobject
  const [editUrl, setEditUrl] = useState(''); // editor only: link to the texts metaobject
  const [unit, setUnit] = useState('');
  const [savedUnit, setSavedUnit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const cfg = readSettings();
  const lang = String(shopify.localization?.language?.value?.isoCode || '').toLowerCase().startsWith('fr') ? 'fr' : 'en';
  const t = (key, vars) => {
    const own = texts?.[lang]?.[key];
    if (own) return vars ? own.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '') : own;
    return shopify.i18n.translate(LOCALE_KEY[key], vars);
  };

  useEffect(() => {
    if (inEditor) {
      post('texts', {}).then((r) => { setTexts(r.text || null); setEditUrl(r.editUrl || ''); }).catch(() => {});
      return undefined;
    }
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
        if (r.text) setTexts(r.text);
        setPhase(r.show ? 'ask' : 'hidden');
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
    if (choice === 'unit' && !unit.trim()) { setError(t('invalid_unit')); return; }
    if (inEditor) { // preview only: show the result screen, then come back to the question
      if (choice === 'unit') setSavedUnit(unit.trim());
      setPhase(choice === 'unit' ? 'done-unit' : 'done-none');
      setTimeout(() => setPhase('ask'), 3000);
      return;
    }
    setBusy(true);
    try {
      await post('answer', { orderId, number, choice, unit: choice === 'unit' ? unit : '' });
      if (choice === 'unit') { setSavedUnit(unit.trim()); setPhase('done-unit'); } else setPhase('done-none');
    } catch (err) {
      setError(err.code === 'invalid-unit' ? t('invalid_unit') : t('error'));
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'loading' || phase === 'hidden') return null;

  // Editor only (customers never see it): where to change the texts.
  const editLink = inEditor && (
    <s-text type="small" color="subdued">
      Texts: Shopify admin → Content → Metaobjects → Unit No. Alert texts.{' '}
      {editUrl && <s-link href={editUrl} target="_blank">Edit texts</s-link>}
    </s-text>
  );

  if (phase === 'done-unit' || phase === 'done-none') {
    return (
      <s-stack direction="block" gap="small">
        <s-banner tone="success">
          <s-text>{phase === 'done-unit' ? t('done_unit', { unit: savedUnit }) : t('done_none')}</s-text>
        </s-banner>
        {editLink}
      </s-stack>
    );
  }

  const button = (group, label, onClick, isBusy) => (
    <s-button
      variant={group === 'primary' ? cfg.primaryVariant : cfg.secondaryVariant}
      tone={group === 'primary' ? cfg.primaryTone : cfg.secondaryTone}
      inlineSize={cfg.fill ? 'fill' : 'auto'}
      loading={group === 'primary' && isBusy}
      disabled={group !== 'primary' && isBusy}
      onClick={onClick}
    >
      {label}
    </s-button>
  );
  const buttons = (a, b) => (
    <s-stack direction={cfg.fill ? 'block' : 'inline'} gap="base">{a}{b}</s-stack>
  );

  const content = phase === 'confirm' ? (
    <s-stack direction="block" gap="base">
      <s-paragraph {...bodyProps(cfg.bodyTone)}>{t('disclaimer')}</s-paragraph>
      {error && <s-text tone="critical">{error}</s-text>}
      {buttons(
        button('primary', t('confirm'), () => answer('none'), busy),
        button('secondary', t('back'), () => { setError(''); setPhase('ask'); }, busy),
      )}
    </s-stack>
  ) : (
    <s-stack direction="block" gap="base">
      <s-paragraph {...bodyProps(cfg.bodyTone)}>{t('body')}</s-paragraph>
      <s-text-field
        label={t('unit_label')}
        value={unit}
        maxLength={20}
        error={error || undefined}
        onInput={(e) => setUnit(e.currentTarget.value)}
      />
      {buttons(
        button('primary', t('save'), () => answer('unit'), busy),
        button('secondary', t('no_unit'), () => { setError(''); setPhase('confirm'); }, busy),
      )}
    </s-stack>
  );

  const title = phase === 'confirm' ? t('confirm_heading') : t('heading');

  return (
    <s-stack direction="block" gap="small">
      {cfg.inlineTitle ? (
        // "inline": the banner's own heading only takes plain text, so the pill + title row is drawn
        // inside the banner (the banner keeps its own alert icon, so the pill has none).
        <s-banner tone="critical">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small" alignItems="center">
              {cfg.showPill && <s-badge tone="neutral" color="base">{t('pill')}</s-badge>}
              <s-text type="strong">{title}</s-text>
            </s-stack>
            {content}
          </s-stack>
        </s-banner>
      ) : (
        // "banner" (default): the banner's own title, the pill on its own line with an icon.
        <s-banner tone="critical" heading={title}>
          <s-stack direction="block" gap="base">
            {cfg.showPill && (
              <s-stack direction="inline">
                <s-badge tone="neutral" color="base" icon="alert-circle">{t('pill')}</s-badge>
              </s-stack>
            )}
            {content}
          </s-stack>
        </s-banner>
      )}
      {editLink}
    </s-stack>
  );
}
