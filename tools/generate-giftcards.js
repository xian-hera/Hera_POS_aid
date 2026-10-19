// Generates a batch of Hera gift card codes for printing.
//
//   GIFT_SECRET=<the same value as on Render> node tools/generate-giftcards.js 50
//   (or: npm run giftcards -- 50)
//
// For every card it produces
//   B  activation serial   QR on the card FRONT (outside the sticker), scanned by the cashier
//   A  redeem code         QR `shopify-giftcard-v1-<code>` + the text, printed UNDER the sticker
// and writes, into giftcards-output/<timestamp>/:
//   cards.csv     one row per card, for the print shop
//   qr/B-0001.png, qr/A-0001.png ...   the QR images
//   preview.html  open in a browser to eyeball a few cards (or to test scanning from the screen)
//
// The output contains redeem codes. Keep it out of git (already ignored), send it to the printer
// securely and delete your copy when the cards are printed.

import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { generateSerial, redeemCodeFor, redeemQrContent } from "../giftcard.js";

const secret = process.env.GIFT_SECRET || "";
if (secret.length < 32) {
  console.error("Set GIFT_SECRET (the same 32+ character value that is on Render) before running this script.");
  process.exit(1);
}

const count = Number.parseInt(process.argv[2] || "20", 10);
if (!Number.isInteger(count) || count < 1 || count > 100000) {
  console.error("Usage: node tools/generate-giftcards.js <number of cards, 1-100000>");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.resolve(process.argv[3] || path.join("giftcards-output", stamp));
const qrDir = path.join(outDir, "qr");
fs.mkdirSync(qrDir, { recursive: true });

// Unique serials (a repeat among N random 10-symbol bodies is practically impossible, but check)
const serials = new Set();
while (serials.size < count) serials.add(generateSerial(secret));

const QR_OPTIONS = { errorCorrectionLevel: "Q", margin: 4, width: 600 };
const rows = [];
let i = 0;
for (const serial of serials) {
  i += 1;
  const n = String(i).padStart(String(count).length < 4 ? 4 : String(count).length, "0");
  const code = redeemCodeFor(secret, serial);
  const qrA = redeemQrContent(code);
  await QRCode.toFile(path.join(qrDir, `B-${n}.png`), serial, QR_OPTIONS);
  await QRCode.toFile(path.join(qrDir, `A-${n}.png`), qrA, QR_OPTIONS);
  rows.push({ n, serial, qrA, codeText: code.toUpperCase() });
}

const csv = [
  "no,serial_B_qr_content,redeem_A_qr_content,redeem_A_text,qr_B_file,qr_A_file",
  ...rows.map((r) => [r.n, r.serial, r.qrA, r.codeText, `qr/B-${r.n}.png`, `qr/A-${r.n}.png`].join(",")),
].join("\n");
fs.writeFileSync(path.join(outDir, "cards.csv"), csv + "\n");

const cardHtml = (r) => `
  <div class="card">
    <div class="n">#${r.n}</div>
    <div class="pair">
      <figure><img src="qr/B-${r.n}.png"><figcaption>B · activation (outside sticker)<br>${r.serial}</figcaption></figure>
      <figure><img src="qr/A-${r.n}.png"><figcaption>A · redeem (under sticker)<br><b>${r.codeText}</b></figcaption></figure>
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

console.log(`Created ${rows.length} cards in ${outDir}`);
console.log("Files: cards.csv, preview.html, qr/");
