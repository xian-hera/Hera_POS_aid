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
| `/v1/devices/...`, `/v1/passes/...`, `/v1/log` | Apple Wallet | Apple Wallet web service: registration, updates, error logs. |
| `POST /webhooks/orders` | Shopify `orders/paid` | Syncs Smile.io points into `custom.points_balance` and pushes a card update to every registered device. |
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
