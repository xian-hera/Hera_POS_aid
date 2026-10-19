# Hera_POS_aid

Hera Beauté's own Shopify POS tools, plus the Apple Wallet loyalty card backend.

- **Shopify app:** Hera_POS_aid (formerly "Search"), client_id `4ef1ce49f9f58d050c762000e78ecf71`
- **Backend:** Render web service, `https://search-0wf4.onrender.com`

> ⚠️ Never change the URL `search-0wf4.onrender.com`. Every Apple Wallet card already in
> customers' phones uses it (`webServiceURL` in `passkit/loyalty.pass/pass.json`).
> Renaming the service in the Render dashboard is fine because it only changes the display name.

## Structure

```
Hera_POS_aid/
├─ shopify.app.toml        Shopify app config (scopes, webhook, App Proxy)
├─ server.js               Backend (Render)
├─ passkit/loyalty.pass/   Apple Wallet card template
├─ certs/                  Apple certificates (local only, git-ignored)
└─ extensions/
   └─ login/               POS tile "Customer Login": scans the Wallet card barcode
                           (add future POS tiles as new folders here)
```

## What the backend does

| Route | Used by | Purpose |
|---|---|---|
| `GET /proxy/wallet` | Storefront `/apps/hera/wallet` (Klaviyo button) | Logged-in customer gets an "Add to Apple Wallet" page. Identity comes from the Shopify App Proxy signature. |
| `GET /api/pass/download/:id?exp&sig` | Button on the page above | Downloads the `.pkpass`. Signed link, valid for 10 minutes. |
| `POST /api/verify` | POS "Customer Login" tile | Checks the card barcode and returns the customer. Requires a Shopify POS session token and is rate-limited (30/min per IP). |
| `POST /api/giftcard/status` | POS "Gift Card Sale" tile | Checks a scanned activation serial (B): genuine or not, already activated or not. Always requires a POS session token, whatever `POS_AUTH_MODE` says. Never returns the redeem code. |
| `POST /api/giftcard/balance` | POS "Gift Card Sale" tile | Cashier scans the redeem QR (under the sticker) and reads the balance. POS session token required. Returns the last 4 characters only. |
| `GET /proxy/giftcard-balance` (+ `app.js`, `jsqr.js`) | Storefront `/apps/hera/giftcard-balance` | Gift card balance page, shown inside the theme, English or French following the storefront language. Files live in `storefront/`. |
| `POST /proxy/giftcard-balance/lookup` | The page above | Takes a code (typed or scanned) and returns the balance. App Proxy signature required, rate-limited (10/min per IP, 300/min in total). |
| `/v1/devices/...`, `/v1/passes/...`, `/v1/log` | Apple Wallet | Apple Wallet web service: registration, updates, error logs. |
| `POST /webhooks/orders` | Shopify `orders/paid` | Syncs Smile.io points into `custom.points_balance` and pushes a card update to every registered device. It also activates physical gift cards sold at POS (see Gift cards below). |
| `GET /wallet/email/:email`, `/wallet/:id`, `/api/pass/generate/:id` | Legacy | Old unauthenticated links. Turned off with `LEGACY_WALLET_LINKS=off`. |
| `/auth`, `/auth/callback` | Re-install only | OAuth. The token is shown once in the browser and never logged. |

Customer metafields (namespace `custom`): `points_balance`, `wallet_devices` (JSON list of
`{deviceId, pushToken}`). The older `wallet_push_token` and `wallet_device_id` fields are read
once and then migrated automatically.

## Environment variables (Render)

| Name | Notes |
|---|---|
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | App client id and secret |
| `SHOP_DOMAIN` | `xxx.myshopify.com` |
| `SHOP_ACCESS_TOKEN` | Admin API token |
| `APP_URL` | `https://search-0wf4.onrender.com` |
| `QR_SECRET` | Signs card barcodes and download links. Changing it invalidates every card. |
| `SMILE_API_KEY`, `KLAVIYO_API_KEY` | |
| `WWDR_PEM_B64`, `SIGNER_CERT_B64`, `SIGNER_KEY_B64` | Apple certificates, base64-encoded |
| `POS_AUTH_MODE` | `log` (default) or `enforce`. Use `log` first, then switch to `enforce` once the logs show `[pos-auth] ok` for real scans. |
| `LEGACY_WALLET_LINKS` | `on` (default) or `off`. Set to `off` once Klaviyo uses `/apps/hera/wallet`. |
| `SHOPIFY_API_VERSION` | Optional. Default `2026-07`. |
| `GIFT_SECRET` | 32+ random characters. Links each card's activation serial (B) to its redeem code (A). Never change it after cards are printed. Gift cards are disabled if it is missing. |
| `GIFT_MAX_AMOUNT` | Optional. Largest card the server will activate. Default `2000`. |
| `GIFT_CURRENCY` | Optional, e.g. `CAD`. Orders in another currency do not activate cards. |

## Gift cards (physical, POS)

Each printed card has two unrelated-looking codes tied together by `GIFT_SECRET`:

- **B, activation serial** (`HGB...`): QR on the front, outside the sticker. The cashier scans it in the POS **Gift Card Sale** tile.
- **A, redeem code**: QR `shopify-giftcard-v1-<code>` plus the text, under a tamper-evident sticker. The cashier never sees it. Shopify POS scans it natively to pay, and the customer can type it at online checkout.

Flow: cashier scans B, picks an amount, the tile adds a custom sale line "Hera Gift Card" tagged `_hera_gc_serial=B`, the customer pays, then `orders/paid` creates the Shopify gift card with code A and the paid amount (`giftcard.js`). Only a paid POS custom-sale line can activate a card. Scanning B again afterwards shows "Activated".

Balance check: customers use `https://<store>/apps/hera/giftcard-balance` (type the code, or tap "Scan QR code"; the phone camera reads the QR under the sticker). Cashiers can scan the same QR in the POS tile. The lookup works for any Shopify gift card, needs no new scope, and never returns the card note (it contains the activation serial). The page lives at `/apps/hera/giftcard-balance` (App Proxy). For the short address `www.herabeauty.ca/gift_card_balance`, create a URL redirect in Shopify admin (Online Store > Navigation > View URL redirects) from `/gift_card_balance` to `/apps/hera/giftcard-balance`. `jsQR` (Apache-2.0) is vendored in `storefront/vendor/`.

Generate a batch (needs the same `GIFT_SECRET` as Render; the output contains redeem codes and is git-ignored):

```
npm install
GIFT_SECRET=... npm run giftcards -- 50
```

This writes `giftcards-output/<timestamp>/` with `cards.csv`, QR PNGs (error correction Q) and `preview.html`.

Needs the `read_gift_cards,write_gift_cards` scopes: after `shopify app deploy`, approve them in the Shopify admin and re-run `/auth` to get a new `SHOP_ACCESS_TOKEN`.

A paid card whose activation fails is only logged (`[giftcard] FAILED ...`). Refunds after activation are not handled.

## Deploy

- **Backend:** push to GitHub `main`, and Render deploys automatically.
- **POS extensions and app config:** run `npm install` once, then `shopify app deploy`.

## Add a new POS tile

1. Run `shopify app generate extension` and choose the POS UI extension type. It creates a folder under `extensions/`.
2. Call the backend with `Authorization: Bearer ${await shopify.session.getSessionToken()}`. Copy the pattern from `extensions/login/src/Modal.jsx`.
3. Run `shopify app deploy`.

## Planned (phase 2)

- Longer barcode signature. Old and new formats are accepted during a transition period.
- Per-card Apple Wallet authentication token, replacing the shared `herabeauty2026loyalty`.
- Push an update to all registered cards so they migrate automatically, then turn off the old formats.
