// Hera physical gift cards
//
// Every card carries two unrelated-looking codes that are linked only by a secret key:
//
//   B  "activation serial"  printed OUTSIDE the sticker, as a QR code. Scanned by the cashier in the
//      POS "Gift Card Sale" tile. It cannot be redeemed anywhere: Shopify has never heard of it.
//   A  "redeem code"        printed UNDER the sticker (QR `shopify-giftcard-v1-<A>` + the text).
//      It becomes a real Shopify gift card only when a paid POS order for serial B arrives.
//
// A is derived from B with HMAC(GIFT_SECRET), so no database is needed. Keep GIFT_SECRET as
// carefully as QR_SECRET: with it, anyone can compute A from a B they can see.

import crypto from "node:crypto";

export const SERIAL_PREFIX = "HGB";
export const GIFT_LINE_TITLE = "Hera Gift Card"; // title of the POS custom-sale line
export const SERIAL_PROPERTY = "_hera_gc_serial"; // line item property carrying B
export const REDEEM_QR_PREFIX = "shopify-giftcard-v1-"; // what Shopify POS recognises

// 31 symbols: digits 2-9 and letters without I, L, O (nothing that looks like 0 or 1)
const SYMBOLS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const SERIAL_BODY_LENGTH = 10;
const SERIAL_TAG_LENGTH = 4;
const REDEEM_CODE_LENGTH = 16; // Shopify accepts 8-20 letters/digits, case-insensitive

const SERIAL_RE = new RegExp(
  `^${SERIAL_PREFIX}([${SYMBOLS}]{${SERIAL_BODY_LENGTH}})([${SYMBOLS}]{${SERIAL_TAG_LENGTH}})$`
);

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function requireSecret(secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("GIFT_SECRET must be at least 32 characters");
  }
}

function hmac(secret, label, message) {
  return crypto.createHmac("sha256", secret).update(`${label}|${message}`).digest();
}

function toSymbols(bytes, count) {
  let out = "";
  for (let i = 0; i < count; i++) out += SYMBOLS[bytes[i] % SYMBOLS.length];
  return out;
}

function serialTag(secret, body) {
  return toSymbols(hmac(secret, "hera-gc-serial-tag", body), SERIAL_TAG_LENGTH);
}

/** New random serial B (17 chars, uppercase): HGB + 10 random + 4-char HMAC tag. */
export function generateSerial(secret) {
  requireSecret(secret);
  let body = "";
  for (let i = 0; i < SERIAL_BODY_LENGTH; i++) body += SYMBOLS[crypto.randomInt(SYMBOLS.length)];
  return SERIAL_PREFIX + body + serialTag(secret, body);
}

/** Returns the normalised serial if `raw` is a genuine B, otherwise null. */
export function parseSerial(secret, raw) {
  requireSecret(secret);
  const s = String(raw ?? "").trim().toUpperCase();
  const m = SERIAL_RE.exec(s);
  if (!m) return null;
  return safeEqual(serialTag(secret, m[1]), m[2]) ? s : null;
}

/** The redeem code A (16 lowercase letters/digits) that belongs to serial B. */
export function redeemCodeFor(secret, serial) {
  requireSecret(secret);
  return toSymbols(hmac(secret, "hera-gc-redeem-code", serial), REDEEM_CODE_LENGTH).toLowerCase();
}

/** Content of the QR code printed under the sticker. */
export function redeemQrContent(code) {
  return REDEEM_QR_PREFIX + code;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIND_QUERY = `
  query FindGiftCard($q: String!) {
    giftCards(first: 10, query: $q) {
      nodes { id lastCharacters enabled note }
    }
  }
`;

// NOTE: written against Admin API 2026-07, where the amount field is `initialValue`.
// Newer versions may rename it (initialAmount); adjust here if SHOPIFY_API_VERSION is raised.
const CREATE_MUTATION = `
  mutation GiftCardCreate($input: GiftCardCreateInput!) {
    giftCardCreate(input: $input) {
      giftCard { id lastCharacters initialValue { amount currencyCode } }
      userErrors { code field message }
    }
  }
`;

/**
 * @param {object}   opts
 * @param {string}   opts.secret      GIFT_SECRET
 * @param {Function} opts.graphql     async (query, variables) => data   (Admin API)
 * @param {number}   [opts.maxAmount] refuse to create a card above this amount
 * @param {string}   [opts.currency]  if set, orders in another currency are refused
 * @param {object}   [opts.log]
 * @param {number[]} [opts.retryDelaysMs]
 */
export function createGiftCardService({
  secret,
  graphql,
  maxAmount = 2000,
  currency = "",
  log = console,
  retryDelaysMs = [1500, 3000],
}) {
  requireSecret(secret);
  const inflight = new Set();

  /** Does a Shopify gift card with redeem code A already exist? */
  async function findExisting(code, serial) {
    const last4 = code.slice(-4);
    // The default search covers gift card codes.
    const byCode = await graphql(FIND_QUERY, { q: code });
    const hit = (byCode?.giftCards?.nodes || []).find(
      (n) => String(n.lastCharacters).toLowerCase() === last4
    );
    if (hit) return hit;
    // Fallback: search by last characters and confirm with the note written at activation.
    try {
      const byTail = await graphql(FIND_QUERY, { q: `last_characters:${last4}` });
      return (
        (byTail?.giftCards?.nodes || []).find(
          (n) => String(n.lastCharacters).toLowerCase() === last4 && String(n.note || "").includes(serial)
        ) || null
      );
    } catch {
      return null;
    }
  }

  /** For the POS tile: is this a genuine serial, and has the card been activated already? */
  async function status(rawSerial) {
    const serial = parseSerial(secret, rawSerial);
    if (!serial) return { valid: false, active: false };
    const existing = await findExisting(redeemCodeFor(secret, serial), serial);
    return { valid: true, active: Boolean(existing) };
  }

  async function createCard({ serial, amount, order }) {
    if (inflight.has(serial)) return { serial, outcome: "in_progress" };
    inflight.add(serial);
    const tag = serial.slice(-4);
    try {
      const input = {
        code: redeemCodeFor(secret, serial),
        initialValue: amount.toFixed(2),
        note: `Hera POS ${serial} | order ${order.name || order.id}`,
      };
      for (let attempt = 0; ; attempt++) {
        try {
          const data = await graphql(CREATE_MUTATION, { input });
          const payload = data?.giftCardCreate;
          if (payload?.giftCard) {
            log.log(`[giftcard] activated serial …${tag} amount ${input.initialValue} order ${order.name || order.id}`);
            return { serial, outcome: "created", amount };
          }
          const errors = payload?.userErrors || [];
          if (errors.some((e) => e.code === "TAKEN")) {
            log.warn(`[giftcard] serial …${tag} was already activated (order ${order.name || order.id})`);
            return { serial, outcome: "already_active" };
          }
          log.error(
            `[giftcard] FAILED serial …${tag} order ${order.name || order.id}: ` +
              errors.map((e) => `${e.code || "?"} ${e.message}`).join("; ")
          );
          return { serial, outcome: "rejected" };
        } catch (err) {
          if (attempt >= retryDelaysMs.length) {
            log.error(`[giftcard] FAILED serial …${tag} order ${order.name || order.id}: ${err.message}`);
            return { serial, outcome: "failed" };
          }
          log.warn(`[giftcard] retrying serial …${tag} (${err.message})`);
          await sleep(retryDelaysMs[attempt]);
        }
      }
    } finally {
      inflight.delete(serial);
    }
  }

  /**
   * Called for every orders/paid webhook. Activates the card behind each gift card line of a
   * paid POS order. Safe to call repeatedly for the same order (a second creation is rejected
   * by Shopify as TAKEN). Returns one result per gift card line; never throws on bad input.
   */
  async function activateFromOrder(order) {
    const results = [];
    if (!order || String(order.source_name || "").toLowerCase() !== "pos") return results;
    if (order.cancelled_at) return results;
    if (String(order.financial_status || "").toLowerCase() !== "paid") return results;
    const lines = Array.isArray(order.line_items) ? order.line_items : [];
    const seen = new Set();

    for (const li of lines) {
      const props = Array.isArray(li.properties) ? li.properties : [];
      const prop = props.find((p) => p?.name === SERIAL_PROPERTY);
      if (!prop) continue;
      const orderRef = order.name || order.id;

      // Only a POS custom sale may activate a card. A normal product line could be forged
      // online by anyone who has seen a serial on a card in the store.
      if (li.product_id || li.variant_id || li.title !== GIFT_LINE_TITLE) {
        log.warn(`[giftcard] ignored line "${li.title}" in order ${orderRef}: not a POS gift card line`);
        continue;
      }
      if (Number(li.quantity) !== 1) {
        log.warn(`[giftcard] ignored gift card line in order ${orderRef}: quantity ${li.quantity}`);
        continue;
      }
      if (currency && order.currency && order.currency !== currency) {
        log.error(`[giftcard] order ${orderRef} is in ${order.currency}, expected ${currency}`);
        continue;
      }
      const serial = parseSerial(secret, prop.value);
      if (!serial) {
        log.warn(`[giftcard] ignored gift card line in order ${orderRef}: invalid serial`);
        continue;
      }
      if (seen.has(serial)) continue;
      seen.add(serial);

      const paid = Number(li.price) - Number(li.total_discount || 0);
      const amount = Math.round(paid * 100) / 100;
      if (!Number.isFinite(amount) || amount <= 0) {
        log.warn(`[giftcard] order ${orderRef}: nothing paid for serial …${serial.slice(-4)}`);
        continue;
      }
      if (amount > maxAmount) {
        log.error(`[giftcard] order ${orderRef}: ${amount} exceeds the ${maxAmount} limit, card NOT activated`);
        results.push({ serial, outcome: "over_limit" });
        continue;
      }
      results.push(await createCard({ serial, amount, order }));
    }
    return results;
  }

  return { status, activateFromOrder, findExisting };
}
