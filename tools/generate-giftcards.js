// Generates a batch of Hera gift card codes for printing.
//
//   GIFT_SECRET=<the same value as on Render> node tools/generate-giftcards.js 5000
//   (or: npm run giftcards -- 5000)
//
// Every card has four printed items:
//   A  redeem QR      content `shopify-giftcard-v1-<12 chars>`   under the scratch-off sticker (Shopify reads it)
//   B  redeem text    the same 12 characters, without the prefix  under the sticker (typed online)
//   C  sale QR        the card serial `HGB…` (17 characters)      outside the sticker (our POS tile reads it)
//   D  sale text      the last 5 characters of the serial         outside the sticker (for people)
// A and B come from C with the secret (nothing is stored); D is unique within the batch.
// No printed text can be mistaken for a number, so the CSV survives Excel, WPS and Google Sheets unchanged.
//
// Output, in giftcards-output/<timestamp>/:
//   cards.csv        one row per card, for the print shop
//   qr/A-0001.png, qr/C-0001.png ...  QR images + preview.html   (only for up to 500 cards, or with --images)
//
// The output contains redeem codes. Keep it out of git (already ignored), send it to the printer
// securely, and keep ONE copy of the final batch. Never regenerate a batch you have already sent.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import QRCode from "qrcode";
import { generateSerial, parseSerial, redeemCodeFor, redeemQrContent, normalizeRedeemInput } from "../giftcard.js";

const args = process.argv.slice(2);
const withImages = args.includes("--images");
const positional = args.filter((a) => !a.startsWith("--"));

const secret = process.env.GIFT_SECRET || "";
if (secret.length < 32) {
  console.error("Set GIFT_SECRET (the same 32+ character value that is on Render) before running this script.");
  process.exit(1);
}

const count = Number.parseInt(positional[0] || "20", 10);
if (!Number.isInteger(count) || count < 1 || count > 100000) {
  console.error("Usage: node tools/generate-giftcards.js <number of cards, 1-100000> [outDir] [--images]");
  process.exit(1);
}
const makeImages = withImages || count <= 500;

const A_RE = /^shopify-giftcard-v1-[a-z0-9]{12}$/;
const C_RE = /^HGB[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{14}$/;
const D_LEN = 5;

// Excel, WPS and Google Sheets turn text such as 4E567 into a number (4E+567) and drop what cannot be a number.
// Cards whose printed text could be read as a number are simply not used, so the CSV is safe in any program.
const looksLikeNumber = (t) => /^[0-9]+$/.test(t) || /^[0-9]+[eE][0-9]+$/.test(t);

// ── Generate: unique serial, unique redeem code, unique 5-character D ────────
const seenSerial = new Set();
const seenD = new Set();
const seenCode = new Set();
const rows = [];
let rejectedForD = 0;
let rejectedForNumber = 0;
const startedAt = Date.now();
while (rows.length < count) {
  if (Date.now() - startedAt > 120000) {
    console.error("Could not find enough unique cards in 2 minutes (the 5-character D leaves too little room). Aborting.");
    process.exit(1);
  }
  const serial = generateSerial(secret);
  const d = serial.slice(-D_LEN);
  if (seenSerial.has(serial)) continue;
  if (seenD.has(d)) { rejectedForD += 1; continue; }
  const code = redeemCodeFor(secret, serial);
  if (looksLikeNumber(d) || looksLikeNumber(code)) { rejectedForNumber += 1; continue; }
  if (seenCode.has(code)) continue;
  seenSerial.add(serial); seenD.add(d); seenCode.add(code);
  rows.push({ serial, d, code });
}

// ── Check everything before writing a single file ───────────────────────────
const problems = [];
rows.forEach((r, idx) => {
  const a = redeemQrContent(r.code);
  if (!A_RE.test(a)) problems.push(`row ${idx + 1}: A has a wrong shape: ${a}`);
  if (!C_RE.test(r.serial)) problems.push(`row ${idx + 1}: C has a wrong shape: ${r.serial}`);
  if (parseSerial(secret, r.serial) !== r.serial) problems.push(`row ${idx + 1}: serial check digits do not verify`);
  if (normalizeRedeemInput(a) !== r.code) problems.push(`row ${idx + 1}: the app would not read A back as the same code`);
  if (redeemCodeFor(secret, r.serial) !== r.code) problems.push(`row ${idx + 1}: A does not belong to C`);
  if (r.serial.slice(-D_LEN) !== r.d) problems.push(`row ${idx + 1}: D does not match C`);
  if (looksLikeNumber(r.d) || looksLikeNumber(r.code)) problems.push(`row ${idx + 1}: a printed text could be read as a number`);
});
if (problems.length) {
  console.error("Self-check FAILED, nothing was written:\n" + problems.slice(0, 10).join("\n"));
  process.exit(1);
}

// ── Write ───────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.resolve(positional[1] || path.join("giftcards-output", stamp));
const qrDir = path.join(outDir, "qr");
fs.mkdirSync(makeImages ? qrDir : outDir, { recursive: true });

const pad = Math.max(4, String(count).length);
rows.forEach((r, idx) => {
  r.n = String(idx + 1).padStart(pad, "0");
  r.a = redeemQrContent(r.code);
});

const header = ["no", "A_redeem_qr_content", "B_redeem_text", "C_sale_qr_content", "D_serial_text"];
if (makeImages) header.push("A_qr_file", "C_qr_file");
const csv = [
  header.join(","),
  ...rows.map((r) => {
    const cells = [String(Number(r.n)), r.a, r.code, r.serial, r.d];
    if (makeImages) cells.push(`qr/A-${r.n}.png`, `qr/C-${r.n}.png`);
    return cells.join(",");
  }),
].join("\n") + "\n";
fs.writeFileSync(path.join(outDir, "cards.csv"), csv);

if (makeImages) {
  const QR_OPTIONS = { errorCorrectionLevel: "Q", margin: 4, width: 600 };
  for (const r of rows) {
    await QRCode.toFile(path.join(qrDir, `A-${r.n}.png`), r.a, QR_OPTIONS);
    await QRCode.toFile(path.join(qrDir, `C-${r.n}.png`), r.serial, QR_OPTIONS);
  }
  const cardHtml = (r) => `
  <div class="card">
    <div class="n">#${r.n}</div>
    <div class="pair">
      <figure><img src="qr/C-${r.n}.png"><figcaption>C · sale (outside sticker)<br>${r.serial}<br>D: <b>${r.d}</b></figcaption></figure>
      <figure><img src="qr/A-${r.n}.png"><figcaption>A · redeem (under sticker)<br>B: <b>${r.code}</b></figcaption></figure>
    </div>
  </div>`;
  fs.writeFileSync(
    path.join(outDir, "preview.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>Hera gift cards ${stamp}</title>
<style>
 body{font-family:-apple-system,Segoe UI,sans-serif;margin:24px}
 .card{display:inline-block;border:1px solid #ccc;border-radius:8px;padding:12px;margin:8px;vertical-align:top}
 .pair{display:flex;gap:16px} figure{margin:0;text-align:center;font-size:12px} img{width:180px;height:180px}
 .n{font-weight:600;margin-bottom:6px}
</style></head><body>
<h2>Hera gift cards · ${rows.length} cards · contains redeem codes, do not share</h2>
${rows.slice(0, 200).map(cardHtml).join("")}
</body></html>`
  );
}

const sha = crypto.createHash("sha256").update(csv).digest("hex");
console.log(`Created ${rows.length} cards in ${outDir}`);
console.log(`Self-check passed: every A belongs to its C, all A / C / D are unique (skipped ${rejectedForD} serials to keep D unique, ${rejectedForNumber} so no text looks like a number to Excel).`);
console.log(`Files: cards.csv${makeImages ? ", preview.html, qr/" : "  (no images: add --images to also make QR PNGs)"}`);
console.log(`cards.csv SHA-256: ${sha}`);
console.log("Keep this exact folder. Do not run the script again for the same print order.");
