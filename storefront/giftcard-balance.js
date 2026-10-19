// Storefront gift card balance page (English / French). Served through the Shopify App Proxy.
// Plain ES5-style JavaScript: no build step and nothing from third-party servers.
(function () {
  'use strict';
  var root = document.getElementById('hera-gcb');
  if (!root) return;

  var STR = {
    en: {
      title: 'Check your gift card balance',
      intro: 'Enter the code printed under the sticker on your card, or scan its QR code.',
      label: 'Gift card code',
      placeholder: 'ABCD2345EFGH6789',
      check: 'Check balance',
      checking: 'Checking...',
      scan: 'Scan QR code',
      stop: 'Cancel',
      scanHint: 'Point the camera at the QR code under the sticker.',
      help: 'Where is the code',
      helpAlt: 'Where to find your gift card code',
      close: 'Close',
      balance: 'Your balance',
      ending: 'Card ending in {x}',
      another: 'Check another card',
      notFound: "We couldn't find this gift card. Please check the code and try again.",
      disabled: 'This gift card is no longer active.',
      expired: 'This gift card has expired.',
      invalid: 'Please enter the code printed on your card (8 to 20 letters and numbers).',
      error: 'Something went wrong. Please try again.',
      rate: 'Too many attempts. Please wait a minute and try again.',
      cameraDenied: 'Camera access was denied. You can type the code instead.',
      cameraUnavailable: 'The camera is not available on this device. You can type the code instead.',
      notHera: 'This QR code is not a gift card.',
      notRedeem: 'Please scan the code on the left.',
      footer: 'Hera Beauté gift cards can be used in store and online.'
    },
    fr: {
      title: 'Vérifier le solde de votre carte-cadeau',
      intro: "Entrez le code imprimé sous l'autocollant de votre carte, ou numérisez son code QR.",
      label: 'Code de la carte-cadeau',
      placeholder: 'ABCD2345EFGH6789',
      check: 'Vérifier le solde',
      checking: 'Vérification...',
      scan: 'Numériser le code QR',
      stop: 'Annuler',
      scanHint: "Placez le code QR situé sous l'autocollant devant la caméra.",
      help: 'Où se trouve le code',
      helpAlt: 'Où trouver le code de votre carte-cadeau',
      close: 'Fermer',
      balance: 'Votre solde',
      ending: 'Carte se terminant par {x}',
      another: 'Vérifier une autre carte',
      notFound: "Nous n'avons pas trouvé cette carte-cadeau. Vérifiez le code et réessayez.",
      disabled: "Cette carte-cadeau n'est plus active.",
      expired: 'Cette carte-cadeau est expirée.',
      invalid: 'Entrez le code imprimé sur votre carte (de 8 à 20 lettres et chiffres).',
      error: "Une erreur s'est produite. Veuillez réessayer.",
      rate: 'Trop de tentatives. Veuillez patienter une minute et réessayer.',
      cameraDenied: "L'accès à la caméra a été refusé. Vous pouvez saisir le code à la main.",
      cameraUnavailable: "La caméra n'est pas disponible sur cet appareil. Vous pouvez saisir le code à la main.",
      notHera: "Ce code QR n'est pas une carte-cadeau.",
      notRedeem: 'Veuillez numériser le code situé à gauche.',
      footer: 'Les cartes-cadeaux Hera Beauté sont utilisables en boutique et en ligne.'
    }
  };

  // Language: ?lang=fr (handy for testing) > storefront locale given by Shopify > <html lang> > browser.
  function pickLang() {
    var param = null;
    try { param = new URLSearchParams(window.location.search).get('lang'); } catch (e) { /* old browser */ }
    var candidates = [param, root.getAttribute('data-locale'), document.documentElement.lang, navigator.language];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c && /^fr/i.test(c)) return 'fr';
      if (c && /^en/i.test(c)) return 'en';
    }
    return 'en';
  }
  var lang = pickLang();
  var T = STR[lang];
  function t(key, vars) {
    var s = T[key] || STR.en[key] || key;
    if (vars) for (var k in vars) s = s.replace('{' + k + '}', vars[k]);
    return s;
  }

  var form = document.getElementById('hera-gcb-form');
  var input = document.getElementById('hera-gcb-code');
  var submitBtn = document.getElementById('hera-gcb-submit');
  var scanBtn = document.getElementById('hera-gcb-scan');
  var scannerBox = document.getElementById('hera-gcb-scanner');
  var stopBtn = document.getElementById('hera-gcb-stop');
  var video = document.getElementById('hera-gcb-video');
  var resultBox = document.getElementById('hera-gcb-result');

  var nodes = root.querySelectorAll('[data-i18n]');
  for (var n = 0; n < nodes.length; n++) nodes[n].textContent = t(nodes[n].getAttribute('data-i18n'));
  var phs = root.querySelectorAll('[data-i18n-placeholder]');
  for (var p = 0; p < phs.length; p++) phs[p].setAttribute('placeholder', t(phs[p].getAttribute('data-i18n-placeholder')));
  document.documentElement.setAttribute('data-hera-gcb-lang', lang);

  // Same rules as the server: QR content "shopify-giftcard-v1-<code>" or the bare code, 8-20 letters/digits.
  var PREFIX = 'shopify-giftcard-v1-';
  function normalize(raw) {
    var s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (s.indexOf(PREFIX) === 0) s = s.slice(PREFIX.length);
    s = s.replace(/[\s-]+/g, '');
    return /^[a-z0-9]{8,20}$/.test(s) ? s : null;
  }
  // The activation code on the card front (HGB + 14): customers sometimes scan that one by mistake.
  function isActivationCode(raw) {
    return /^HGB[A-Z0-9]{14}$/i.test(String(raw == null ? '' : raw).trim());
  }

  function money(amount, currency) {
    try {
      return new Intl.NumberFormat(lang === 'fr' ? 'fr-CA' : 'en-CA', { style: 'currency', currency: currency }).format(amount);
    } catch (e) {
      return amount.toFixed(2) + ' ' + currency;
    }
  }

  function clearResult() {
    resultBox.hidden = true;
    resultBox.className = 'hera-gcb__result';
    while (resultBox.firstChild) resultBox.removeChild(resultBox.firstChild);
  }
  function showMessage(key) {
    clearResult();
    resultBox.className = 'hera-gcb__result hera-gcb__result--msg';
    resultBox.textContent = t(key);
    resultBox.hidden = false;
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function showBalance(data) {
    clearResult();
    resultBox.appendChild(el('span', 'hera-gcb__small', t('balance')));
    resultBox.appendChild(el('span', 'hera-gcb__amount', money(data.balance, data.currency)));
    resultBox.appendChild(el('span', 'hera-gcb__small', t('ending', { x: String(data.lastCharacters || '').toUpperCase() })));
    var again = el('button', 'hera-gcb__btn hera-gcb__btn--ghost', t('another'));
    again.type = 'button';
    again.addEventListener('click', function () {
      clearResult();
      input.value = '';
      input.focus();
    });
    resultBox.appendChild(again);
    resultBox.hidden = false;
  }

  var busy = false;
  function setBusy(on) {
    busy = on;
    submitBtn.disabled = on;
    submitBtn.textContent = on ? t('checking') : t('check');
  }

  function lookup(code) {
    if (busy) return;
    setBusy(true);
    clearResult();
    fetch(root.getAttribute('data-endpoint'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    })
      .then(function (resp) {
        return resp.json().then(
          function (data) { return { status: resp.status, data: data }; },
          function () { return { status: resp.status, data: null }; }
        );
      })
      .then(function (r) {
        if (r.status === 429) return showMessage('rate');
        if (r.status === 400) return showMessage('invalid');
        if (r.status !== 200 || !r.data) return showMessage('error');
        if (!r.data.found) return showMessage('notFound');
        if (r.data.enabled === false) return showMessage('disabled');
        if (r.data.expired) return showMessage('expired');
        showBalance(r.data);
      })
      .catch(function () { showMessage('error'); })
      .then(function () { setBusy(false); });
  }

  function submitTyped() {
    var raw = input.value;
    if (isActivationCode(raw)) return showMessage('notRedeem');
    var code = normalize(raw);
    if (!code) return showMessage('invalid');
    lookup(code);
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    submitTyped();
  });

  // ── "Where is the code" picture ──
  var helpBtn = document.getElementById('hera-gcb-help');
  var modal = document.getElementById('hera-gcb-modal');
  var modalImg = document.getElementById('hera-gcb-modal-img');
  var modalClose = document.getElementById('hera-gcb-modal-close');
  function closeHelp() {
    modal.hidden = true;
    helpBtn.focus();
  }
  if (helpBtn && modal && modalImg) {
    modalClose.setAttribute('aria-label', t('close'));
    helpBtn.addEventListener('click', function () {
      // A French picture can be set in data-help-image-fr; otherwise the same picture is used.
      var src = (lang === 'fr' && root.getAttribute('data-help-image-fr')) || root.getAttribute('data-help-image');
      if (!src) return;
      modalImg.alt = t('helpAlt');
      modalImg.src = src;
      modal.hidden = false;
      modalClose.focus();
    });
    modalClose.addEventListener('click', closeHelp);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeHelp(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.hidden) closeHelp(); });
  }

  // ── QR scanning (camera) ──
  var stream = null;
  var scanning = false;
  var timer = null;
  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var lastWarn = 0;

  function stopScan() {
    scanning = false;
    clearTimeout(timer);
    if (stream) {
      var tracks = stream.getTracks();
      for (var i = 0; i < tracks.length; i++) tracks[i].stop();
      stream = null;
    }
    try { video.pause(); } catch (e) { /* ignore */ }
    video.srcObject = null;
    scannerBox.hidden = true;
  }

  function loadDecoder(cb, fail) {
    if (window.jsQR) return cb();
    var s = document.createElement('script');
    s.src = root.getAttribute('data-jsqr');
    s.onload = cb;
    s.onerror = fail;
    document.head.appendChild(s);
  }

  function warnOnce(key) {
    var now = Date.now();
    if (now - lastWarn > 2500) {
      lastWarn = now;
      showMessage(key);
    }
  }

  function onScanned(text) {
    if (isActivationCode(text)) return warnOnce('notRedeem');
    var code = normalize(text);
    if (!code) return warnOnce('notHera');
    stopScan();
    input.value = code;
    lookup(code);
  }

  function tick() {
    if (!scanning) return;
    if (video.readyState >= 2 && video.videoWidth) {
      var w = Math.min(video.videoWidth, 800);
      var h = Math.round((video.videoHeight * w) / video.videoWidth);
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      var img = ctx.getImageData(0, 0, w, h);
      var found = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
      if (found && found.data) {
        onScanned(found.data);
        if (!scanning) return;
      }
    }
    timer = setTimeout(tick, 150);
  }

  function startScan() {
    if (scanning) return;
    clearResult();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return showMessage('cameraUnavailable');
    loadDecoder(function () {
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
        .then(function (s) {
          stream = s;
          scanning = true;
          video.setAttribute('playsinline', '');
          video.muted = true;
          video.srcObject = s;
          scannerBox.hidden = false;
          return video.play();
        })
        .then(tick)
        .catch(function (err) {
          stopScan();
          showMessage(err && err.name === 'NotAllowedError' ? 'cameraDenied' : 'cameraUnavailable');
        });
    }, function () { showMessage('cameraUnavailable'); });
  }

  scanBtn.addEventListener('click', startScan);
  stopBtn.addEventListener('click', stopScan);
  document.addEventListener('visibilitychange', function () { if (document.hidden) stopScan(); });
  window.addEventListener('pagehide', stopScan);
})();
