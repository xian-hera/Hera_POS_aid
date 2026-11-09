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
   ├─ login/               POS tile "Customer Login": scans the Wallet card barcode
   ├─ giftcard/            POS tile "Gift Card Sale"
   ├─ restock/             POS tile "Restock Notify" (backend: restock.js)
   ├─ memo/                POS tile "MEMO" (backend: memo.js)
   └─ points-sync/         Background extension (no tile): sends the cart for the receipt points (backend: points.js)
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
| `POST /api/restock/customer`, `/contact`, `/subscribe`, `/search`, `/submit` | POS "Restock Notify" tile | Customer details and consent, add or change the email / phone, save the confirmed language, variant search fallback, save the request. POS session token always required. |
| `POST /api/memo/list`, `/save`, `/delete`, `/unlock` | POS "MEMO" tile | Store memos and Global memos (metaobject `pos_memo`). Global changes need an unlock token (30 min) obtained with `MEMO_PASSWORD`. POS session token always required. |
| `POST /api/points/preview` | POS background extension "points-sync" | Receives the cart, reads the Smile balance, estimates this sale's points and writes `custom.receipt_points_*` for the receipt. POS session token always required. |
| `POST /api/unit/status`, `/api/unit/answer` | Thank you / Order status page block "unit-check" | Should the block ask for the unit number; save the customer's answer (unit → shipping address line 2, or "no unit"). Checkout session token + the order's confirmation number required. |
| `POST /api/restock/run` | Shopify Flow (10:00 and 16:00) | Checks stock for every pending request and sends the Klaviyo event. Needs header `X-Restock-Key`. `?dryRun=1` shows what would be sent without sending or changing anything. |
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
| `SMILE_API_KEY`, `KLAVIYO_API_KEY` | Klaviyo private key scopes needed: Profiles, Events, Lists, Subscriptions (Full access). |
| `KLAVIYO_SMS_LIST_ID` | Optional. Klaviyo list that SMS subscriptions made at POS are added to (Subscribe Profiles API). Default `UeqRiu`. Its opt-in setting decides whether Klaviyo sends the "Reply YES" text. |
| `KLAVIYO_EMAIL_LIST_ID` | Optional. When set, email subscriptions made at POS are also sent to Klaviyo and added to this list. Off by default (the Shopify email sync is used). |
| `WWDR_PEM_B64`, `SIGNER_CERT_B64`, `SIGNER_KEY_B64` | Apple certificates, base64-encoded |
| `REPORT_PASSWORD` | Password of the head-office report page `/report` (10+ characters). Changing it signs everybody out. |
| `MEMO_PASSWORD` | Password that unlocks editing of Global memos in the MEMO tile for 30 minutes on that iPad (6+ characters). Changing it locks every iPad again. Global editing is off when it is missing. |
| `MEMO_ADMIN_PASSWORD` | Optional. Password of the MEMO head-office page `/memo` (10+ characters). When missing, `REPORT_PASSWORD` is used. |
| `POINTS_MULTIPLIER` | Optional. Points campaign multiplier for the receipt estimate (e.g. `2`). Default `1`. |
| `POS_AUTH_MODE` | `log` (default) or `enforce`. Use `log` first, then switch to `enforce` once the logs show `[pos-auth] ok` for real scans. |
| `LEGACY_WALLET_LINKS` | `on` (default) or `off`. Set to `off` once Klaviyo uses `/apps/hera/wallet`. |
| `SHOPIFY_API_VERSION` | Optional. Default `2026-07`. |
| `GIFT_SECRET` | 32+ random characters. Links each card's activation serial (B) to its redeem code (A). Never change it after cards are printed. Gift cards are disabled if it is missing. |
| `GIFT_MAX_AMOUNT` | Optional. Largest card the server will activate. Default `2000`. |
| `GIFT_CURRENCY` | Optional, e.g. `CAD`. Orders in another currency do not activate cards. |
| `GIFT_PRODUCT_ID` | Optional. Numeric id of the physical gift card product. Built-in default in `server.js`. |
| `RESTOCK_RUN_KEY` | 24+ random characters. Shopify Flow sends it in the `X-Restock-Key` header. The stock check is disabled if it is missing. |
| `RESTOCK_THRESHOLD` | Optional. Notify when "available" at the store is at least this number. Default `1`. |
| `RESTOCK_TYPE_THRESHOLDS` | Optional. Exceptions by product type, `TYPE=number` separated by commas, e.g. `WIG=1,MAKEUP=3`. Type names are not case-sensitive. Default `WIG=1` (a wig is notified as soon as 1 is available). Set it to an empty value to remove all exceptions. |

## Gift cards (physical, POS)

Each printed card has two unrelated-looking codes tied together by `GIFT_SECRET`:

- **B, activation serial** (`HGB...`): QR on the front, outside the sticker. The cashier scans it in the POS **Gift Card Sale** tile.
- **A, redeem code**: QR `shopify-giftcard-v1-<code>` plus the text, under a tamper-evident sticker. The cashier never sees it. Shopify POS scans it natively to pay, and the customer can type it at online checkout.

Flow: cashier scans B, picks an amount, the tile adds one variant of the Shopify product **Hera Beauté Physical Gift Card** to the cart, tagged `_hera_gc_serial=B`. The customer pays, then `orders/paid` creates the Shopify gift card with code A and the paid amount (`giftcard.js`). Only a line of that product on a paid POS order can activate a card. Scanning B again afterwards shows "Activated".

The product (a regular product, NOT a Shopify gift card product) has one variant per amount, is sold in the Point of Sale channel only, is not taxable and has no inventory tracking. It is excluded from Smile points in Smile > Settings > Platform > Product exclusion, which is why a regular product is used instead of a custom sale. Its id is built into `server.js` (`GIFT_PRODUCT_ID`, override on Render only if the product is re-created). The amounts offered by the tile are the `GIFT_VARIANTS` list at the top of `extensions/giftcard/src/Modal.jsx`: to add or remove an amount, change the variants in Shopify, update that list with the new variant ids, and run `shopify app deploy`.

Balance check: customers use `https://<store>/apps/hera/giftcard-balance` (type the code, or tap "Scan QR code"; the phone camera reads the QR under the sticker). Cashiers can scan the same QR in the POS tile. The lookup works for any Shopify gift card, needs no new scope, and never returns the card note (it contains the activation serial). The page lives at `/apps/hera/giftcard-balance` (App Proxy). For the short address `www.herabeauty.ca/gift_card_balance`, create a URL redirect in Shopify admin (Online Store > Navigation > View URL redirects) from `/gift_card_balance` to `/apps/hera/giftcard-balance`. `jsQR` (Apache-2.0) is vendored in `storefront/vendor/`.

Factory QR check: `https://<store>/apps/hera/qr-check` (file `storefront/qr-check.html`, served as plain HTML through the App Proxy, no theme, bilingual Chinese/English). The factory opens it on a phone, scans or photographs a sample card, and sees the exact text stored in each QR code plus a pass/fail check (A: `shopify-giftcard-v1-` + 12 lowercase characters; B: `HGB` + 14 uppercase characters; no spaces or line breaks inside). It checks the format only: it has no secret, so it cannot tell whether A belongs to B. Everything runs in the browser, nothing is uploaded. Deploy: push to Render only.

POS guide picture: the scan screen of the tile shows `storefront/images/pos-guide.png` (served by the backend at `/proxy/giftcard-balance/img/pos-guide.png`). To change it, replace that file (keep the 1.6 : 1 shape) and push to Render. No `shopify app deploy` is needed unless the shape changes (`GUIDE_IMAGE_ASPECT_RATIO` in `Modal.jsx`).

Generate a batch (needs the same `GIFT_SECRET` as Render; the output contains redeem codes and is git-ignored):

```
npm install
GIFT_SECRET=... npm run giftcards -- 50
```

This writes `giftcards-output/<timestamp>/` with `cards.csv`, QR PNGs (error correction Q) and `preview.html`.

Needs the `read_gift_cards,write_gift_cards` scopes: after `shopify app deploy`, approve them in the Shopify admin and re-run `/auth` to get a new `SHOP_ACCESS_TOKEN`.

A paid card whose activation fails is only logged (`[giftcard] FAILED ...`). Refunds after activation are not handled.

## Restock Notify (POS)

A customer wants a product that is out of stock in the store. The cashier logs the customer in,
opens **Restock Notify**, searches (name, SKU or barcode, or scans) and taps **Add** on each
variant. Page 2 opens step by step: (1) the customer chooses **Email** or **SMS**; then (2) the
cashier confirms the customer's language (English / Français, pre-selected from the Shopify locale,
saved back to the customer and sent to Klaviyo as `language`) and (3) checks the email or mobile
number for that channel (add, or Edit to replace it in Shopify; Subscribe if the customer agrees).
Both channels need a subscription (email or SMS) before Confirm; right after subscribing to SMS the cashier must confirm they told the
customer to reply YES (Klaviyo double opt-in) before Confirm is enabled.

Search is variant-level: the tile uses the POS device's own search, splits each product into its
variants and keeps only the variants that match (a SKU or barcode gives exactly one line). When the
device finds nothing, the backend searches Shopify (`productVariants`).

Data (all in Shopify):

- **Metaobject `restock_request`** (merchant-owned, created automatically on start-up): one entry
  per customer + variant + store. Fields: `status` (`pending` / `notified` / `cancelled`),
  `location_code`, `location_id`, `customer`, `customer_id`, `variant`, `variant_id`, `sku`,
  `product_title`, `variant_title`, `channel` (`email` / `sms`), `requested_at`, `notified_at`,
  `available_at_notify`, `staff_id`. Entries are never deleted, so they can be used for analysis.
  `status`, `location_code`, `customer_id`, `variant_id`, `sku`, `channel` are filterable.
- **Customer metafield `custom.restock_requests`** (JSON): only what the customer is still waiting
  for, e.g. `[{"location":"MTL10","sku":"...","variant_id":"...","product":"...","channel":"sms","requested_at":"..."}]`.
- **Location metafield `custom.display_name`**: the store name sent to Klaviyo (MTL10 → "Chambly Longueuil").
  The address comes from the Shopify location. Empty → the location name (code) is used.

Stock check: Shopify Flow calls `POST /api/restock/run` at 10:00 and 16:00. For each pending request,
if `available` at that store ≥ the threshold (`RESTOCK_THRESHOLD`, or the product type's value from `RESTOCK_TYPE_THRESHOLDS`, e.g. WIG = 1), the backend sends the Klaviyo event
**Restock Available** (one event per customer + store + channel, with an `items` list), marks the
requests `notified` and removes them from the customer metafield. If Klaviyo fails, nothing is marked
and the next run tries again. A deleted variant is marked `cancelled`.

SMS needs consent: if SMS is chosen for a customer not subscribed to SMS, the tile asks the cashier at Confirm
(subscribe to SMS, or notify by email instead). At notify time, a request for SMS whose customer is not
subscribed to SMS is sent by email when the customer has an email (otherwise it stays pending).

Klaviyo event properties: `channel` (the channel actually used), `requested_channel` (the one chosen at POS), `language` (`en` / `fr`; the same language is also written to the Klaviyo profile `locale` as `fr-CA` / `en-CA`, at POS Confirm and with every event, so Smart Translations work), `store_code`, `store_name`, `store_address`, `store_phone` (e.g. "(450) 670-9777"), `store_phone_e164`, `store_address1`,
`store_city`, `store_province`, `store_zip`, `item_count`, `first_product_title`, `first_variant_title`,
`first_image_url`, `items_text` (all items joined with commas), `items_short` (at most 2 items, then "and N more", for SMS), `items[]` (`sku`, `product_title`, `variant_title`, `vendor`, `price`, `price_display` e.g. "$11.99",
`image_url` = the product's first media (variant image if the product has none), `variant_image_url`,
`url` = online store product page with the variant selected (store search for the SKU if the product is not online),
`available`, `variant_id`), `shopify_customer_id`. The profile is identified by email
(channel `email`) or phone number (channel `sms`).

Reading the list from another app on the shop (needs `read_metaobjects`, plus `read_customers` /
`read_products` to expand the references):

```graphql
query {
  metaobjects(type: "restock_request", first: 250,
              query: "fields.location_code:\"MTL10\" AND fields.status:\"pending\"") {
    pageInfo { hasNextPage endCursor }
    nodes {
      sku: field(key: "sku") { value }
      product: field(key: "product_title") { value }
      variant: field(key: "variant_title") { value }
      channel: field(key: "channel") { value }
      requestedAt: field(key: "requested_at") { value }
      customer: field(key: "customer") { reference { ... on Customer { displayName } } }
    }
  }
}
```

### Restock Notify POS endpoints added for the customer's list and Check Item (this store only)

| Route | Purpose |
|---|---|
| `POST /api/restock/waiting` | `{customerId, locationId}` → what the customer waits for at this store |
| `POST /api/restock/remove` | `{customerId, locationId, variantId}` → cancels that request (status `cancelled`), returns the new list |
| `POST /api/restock/item` | `{locationId, variantId}` → customers waiting for this product at this store (name, email, phone), stock and threshold |

## Restock report (head office)

`https://search-0wf4.onrender.com/report`, password `REPORT_PASSWORD` (12-hour session cookie). Code: `report.js`,
page: `report/index.html` (all grouping and filtering happen in the browser), sign-in: `report/login.html`.

- **Waiting**: stores overview → products per store (customers, longest wait, stock now / needed) → customers per store.
  A SKU (or part of a product name) shows, per store, how many customers wait now and how many ever waited.
- **Notified** (period filter, default 30 days): per store and per product, customers, notifications, email / SMS,
  average wait from request to notification; customers with what they were told and when.
- **Export CSV** exports the rows behind the current view.
- `notified_channel` (metaobject field, added automatically at start-up) records the channel actually used, so
  "asked SMS, sent by email" can be counted. Records notified before it existed show the requested channel.
- Data is cached 2 minutes; **Refresh** reloads from Shopify.

## MEMO (POS)

Tile "MEMO": quick lookup of important info. Code: `extensions/memo/` and `memo.js`.

- Two tabs: **this store** (everyone at that store can add, edit, pin and delete) and **Global** (shown at every
  store; locked until someone taps the lock and enters `MEMO_PASSWORD`, then unlocked on that iPad for 30 minutes).
- Each memo is one `pos_memo` metaobject (merchant-owned, created automatically at start-up, visible in
  Shopify admin → Content → Metaobjects): scope, location, title, text, pinned, card size (S/L), updated at/by.
- Text is shown line by line as typed; an empty line adds space; `[Name]` is shown as a pill.
- Cards: Small = 1/5 of the width, Large = 2/5. Pinned first (red dot), then A→Z. With 5 memos or fewer the
  cards are tall and show the full text; with more, they get shorter.
- If two iPads edit the same memo, the second save is refused and the cashier can reopen their text.
- During tests the tile subheading is `debug N`; final text: "Quick lookup of important info".

## Points on the receipt (POS)

Goal: the printed receipt shows the customer's points **including this sale**. Code: `extensions/points-sync/`
(background, API 2026-07, no tile) and `points.js`.

1. When the cart has a customer and items and stops changing for 1.2 s, the extension sends it to `/api/points/preview`.
2. The backend reads the Smile balance (by email), estimates the sale's points and writes 4 customer metafields
   (definitions created automatically at start-up): `custom.receipt_points_before`, `_earned`, `_total`,
   `_subtotal` (pre-tax amount in cents; `-1` = no estimate).
3. The receipt's custom Liquid block prints `receipt_points_total` when `receipt_points_subtotal` equals the
   order's subtotal, otherwise `custom.points_balance`, plus a note that the official balance is on the website.

Rules (Smile, Nov 2026): 1 point per $1 paid before tax, rounded down; products with a compare-at price and gift
cards earn nothing. Order-level discounts are shared between lines in proportion to their amounts.
Campaigns: set `POINTS_MULTIPLIER`. `custom.points_balance` (Apple Wallet) is not touched by this feature.

## Unit number check (online orders)

Code: `address.js` (orders, Thank you page answers), `nar.js` + `nar-normalize.js` (address lookup),
extension `extensions/unit-check` (Thank you and Order status page block). Data: Statistics Canada
National Address Register (NAR, free, Open Licence), as two files in `data/`.

- **orders/paid** (orders not from POS, shipped to Canada): if the address has no unit number and
  needs one, the order gets the tag `Check unit`.
- **Unit given** (nothing to do): address line 2 is filled, or line 1 has `12-345 …`, `#12`, `apt/app/unit/suite/bureau/logement 12`…
- **Needs one**: NAR says the building has 2+ units, or NAR does not know the civic address (often a new
  building), or several buildings share the postal code + civic number and the street does not say which.
  A wrong postal code is caught by civic number + street name in the same province.
- **Thank you page** (block "unit-check", second chance on the Order status page): the customer types the
  unit (written to shipping address line 2, tag `Unit added by customer`) or confirms there is none
  (tag `No unit (customer confirmed)`). Either way `Check unit` is removed. Answers are accepted for 14 days,
  once, while the order is not fulfilled.
- **"No unit" is remembered per customer email + address** (metaobject `unit_exemption`, Shopify admin →
  Content → Metaobjects): that customer is not asked or tagged again for that address. Delete the entry to
  ask again. Other customers at the same address are still checked.
- Render log lines: `[unit] #1234: multi (24 units) · … → tagged "Check unit"`, `[unit] #1234: customer added unit "12"`.

Block look (checkout editor → Thank you page / Order status page → block "Unit No. Alert"): always a red
(critical) banner with a grey pill and alert icon. Settings: show the pill, button width (fit / fill), style and
color of the Save / Confirm buttons, style and color of the No unit number / Back buttons, text color.

Block texts (English + French): metaobject **Unit No. Alert texts**, entry `default` (Shopify admin → Content →
Metaobjects). Created automatically with the built-in texts on the first start; an empty field uses the built-in
text in `extensions/unit-check/locales/`. Changes show within a minute. In the checkout editor, an "Edit texts"
link under the block preview opens the entry (customers never see it).

**Update the NAR data (about twice a year, usually June and December):**

1. Download the newest zip (about 1.6 GB, "Reference period" list, e.g. `202612.zip`) from
   https://www150.statcan.gc.ca/n1/pub/46-26-0002/462600022022001-eng.htm
2. Drag the zip onto `tools\update-nar.bat` (or run `tools\update-nar.bat "<path>\202612.zip"`). It unzips,
   runs `nar-refine.js` and `nar-index.js`, re-tests `tools/nar-test-addresses.txt` (if present), then asks
   before `git commit` + `git push` of `data/` (Render deploys) and before deleting the unzipped files.
3. After the deploy, the Render log shows `[nar] loaded … civic addresses and … multi-unit buildings`.

Testing tools: `node tools/nar-lookup.js "<NAR_refined>"` (type addresses one by one) and
`node tools/nar-batch.js "<NAR_refined>" tools/nar-test-addresses.txt` (a list; that file is not committed).

## MEMO head-office page

`https://search-0wf4.onrender.com/memo`: view and edit the memos of every store and the Global memos in a browser.
Code: `memo-admin.js`, pages `memo-admin/index.html` and `memo-admin/login.html`.

- Password: `MEMO_ADMIN_PASSWORD` (10+ characters). When it is not set, `REPORT_PASSWORD` is used. 12-hour session.
- Left: Global and every active store with its number of memos. Search looks in all stores.
- Click a memo to edit it (title, color, pinned, text, live preview) or delete it; "Add memo" adds one to the selected list.
  Global needs no unlock here.
- Same data and rules as the iPads; a change made at the same time on an iPad is not overwritten (the second save is refused).
  iPads show changes after Refresh.

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
