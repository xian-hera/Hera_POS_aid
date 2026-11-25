// Checks a cards.csv (the original, or a copy that came back from somewhere) against the secret.
//
//   GIFT_SECRET=<same value as on Render> node tools/verify-giftcards.js path/to/cards.csv
//   (or: npm run verifygiftcards -- path/to/cards.csv)
//
// For every row it checks that A, B, C and D have the right shape, that A and B belong to C, that D is the end of C,
// that nothing is repeated, and that no cell was changed by a spreadsheet program (numbers, quotes, spaces, line breaks).

import fs from "node:fs";
import crypto from "node:crypto";
import { parseSerial, redeemCodeFor } from "../giftcard.js";

const file = process.argv[2];
const secret = process.env.GIFT_SECRET || "";
if (!file || secret.length < 32) {
  console.error("Usage: GIFT_SECRET=... node tools/verify-giftcards.js path/to/cards.csv");
  process.exit(1);
}

const raw = fs.readFileSync(file);
const text = raw.toString("utf8");
const problems = [];
if (text.charCodeAt(0) === 0xfeff) problems.push("File starts with a byte-order mark (BOM): the first column name is damaged.");
const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l, i, all) => l !== "" || i < all.length - 1);
if (lines[lines.length - 1] === "") lines.pop();

const header = lines[0].split(",");
const col = (name) => header.indexOf(name);
const cA = col("A_redeem_qr_content"), cB = col("B_redeem_text"), cC = col("C_sale_qr_content"), cD = col("D_serial_text");
if ([cA, cB, cC, cD].some((c) => c < 0)) {
  console.error("The header row is not the one the generator writes (A_redeem_qr_content, B_redeem_text, C_sale_qr_content, D_serial_text).");
  process.exit(1);
}

const A_RE = /^shopify-giftcard-v1-[a-z0-9]{12}$/;
const seen = { A: new Set(), C: new Set(), D: new Set() };
let rows = 0;
for (let i = 1; i < lines.length; i++) {
  const cells = lines[i].split(",");
  const at = `row ${i} (line ${i + 1})`;
  rows += 1;
  if (cells.length !== header.length) { problems.push(`${at}: ${cells.length} columns instead of ${header.length}`); continue; }
  const [a, b, c, d] = [cells[cA], cells[cB], cells[cC], cells[cD]];
  if (cells.some((x) => /["\s]/.test(x))) problems.push(`${at}: a cell contains quotes or spaces`);
  if (!A_RE.test(a)) problems.push(`${at}: A is not shopify-giftcard-v1- + 12 lowercase characters: ${a}`);
  if (a.slice(20) !== b) problems.push(`${at}: B is not A without the prefix`);
  const serial = parseSerial(secret, c);
  if (!serial) { problems.push(`${at}: C is not a valid serial: ${c}`); continue; }
  if (redeemCodeFor(secret, serial) !== b) problems.push(`${at}: A / B do not belong to C`);
  if (c.slice(-5) !== d) problems.push(`${at}: D is not the last 5 characters of C`);
  if (!/^[A-Z0-9]{5}$/.test(d) || /^[0-9]+$/.test(d) || /^[0-9]+E[0-9]+$/.test(d)) problems.push(`${at}: D looks changed or could be read as a number: ${d}`);
  for (const [k, v] of [["A", a], ["C", c], ["D", d]]) {
    if (seen[k].has(v)) problems.push(`${at}: ${k} is repeated: ${v}`);
    seen[k].add(v);
  }
}

console.log(`${file}: ${rows} rows, SHA-256 ${crypto.createHash("sha256").update(raw).digest("hex")}`);
if (problems.length) {
  console.error(`NOT OK: ${problems.length} problem(s). First ones:\n` + problems.slice(0, 15).join("\n"));
  process.exit(1);
}
console.log("OK: every row is valid, A / B belong to C, D matches C, nothing repeated, no cell was altered.");
