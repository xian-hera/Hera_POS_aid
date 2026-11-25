// Hera gift card tool: interactive, for people who do not use the command line. Packed into a single
// Windows program (hera-giftcard-tool.exe) by tools/build-exe.md; it also runs with:  node tools/giftcard-tool.js
//
//   1  make a new batch of cards (cards.csv)       2  check an existing cards.csv
//
// The secret is typed (nothing is shown) and is never saved. Same rules as generate-giftcards.js / verify-giftcards.js.
// English only on purpose: the Windows console often garbles other languages.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { generateSerial, parseSerial, redeemCodeFor, redeemQrContent, normalizeRedeemInput } from "../giftcard.js";

const A_RE = /^shopify-giftcard-v1-[a-z0-9]{12}$/;
const C_RE = /^HGB[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{14}$/;
const D_LEN = 5;
const looksLikeNumber = (t) => /^[0-9]+$/.test(t) || /^[0-9]+[eE][0-9]+$/.test(t);

// ── Console helpers ─────────────────────────────────────────────────────────
const out = (s = "") => process.stdout.write(s + "\n");

// Without a terminal (input piped in, used for testing) all lines are read at once.
let pipedLines = null;
function ask(question, echo = true) {
  if (!process.stdin.isTTY) {
    if (pipedLines === null) pipedLines = fs.readFileSync(0, "utf8").split(/\r?\n/);
    const answer = (pipedLines.shift() ?? "").trim();
    process.stdout.write(question + (echo ? answer : "") + "\n");
    return Promise.resolve(answer);
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { resolve(answer.trim()); rl.close(); }); // resolve first: close() fires "close" at once
    rl.on("close", () => resolve("")); // input ended without an answer (a no-op if already resolved)
  });
}

// Reads a line without showing it (the secret). Pasting works. Falls back to a visible prompt when there is no terminal.
function askHidden(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") return ask(question, false);
  return new Promise((resolve) => {
    process.stdout.write(question);
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          return resolve(value.trim());
        }
        if (ch === "\u0003") { process.stdout.write("\n"); process.exit(1); } // Ctrl+C
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

// Folder next to the program (or the current folder when run with node).
function baseDir() {
  try {
    const sea = process.getBuiltinModule ? process.getBuiltinModule("node:sea") : null;
    if (sea && sea.isSea()) return path.dirname(process.execPath);
  } catch { /* not a single-file program */ }
  return process.cwd();
}

async function askSecret() {
  const secret = await askHidden("Paste the GIFT_SECRET from Render (nothing will be shown), then press Enter: ");
  if (secret.length < 32) {
    out("That is shorter than 32 characters, so it cannot be the GIFT_SECRET. Nothing was done.");
    return null;
  }
  out(`Secret received (${secret.length} characters).`);
  return secret;
}

// A wrong secret would silently produce cards that our app rejects, so offer to test it against a card that is known to work.
async function confirmSecret(secret) {
  out("");
  out("Safety check (recommended): paste the sale code (C, starts with HGB) of a card you have already tested in the POS.");
  out("It proves that this is the right secret. Press Enter to skip.");
  const serial = await ask("Tested card sale code: ");
  if (!serial) { out("Skipped."); return true; }
  if (parseSerial(secret, serial)) { out("Secret confirmed: it matches that card."); return true; }
  out("This secret does NOT match that card (or the code was typed wrongly). Nothing was created.");
  return false;
}

// ── Make a batch ────────────────────────────────────────────────────────────
function makeBatch(secret, count) {
  const seenSerial = new Set(), seenD = new Set(), seenCode = new Set();
  const rows = [];
  let skippedD = 0, skippedNumber = 0;
  const started = Date.now();
  while (rows.length < count) {
    if (Date.now() - started > 120000) throw new Error("Could not find enough unique cards in 2 minutes.");
    const serial = generateSerial(secret);
    const d = serial.slice(-D_LEN);
    if (seenSerial.has(serial)) continue;
    if (seenD.has(d)) { skippedD++; continue; }
    const code = redeemCodeFor(secret, serial);
    if (looksLikeNumber(d) || looksLikeNumber(code)) { skippedNumber++; continue; }
    if (seenCode.has(code)) continue;
    seenSerial.add(serial); seenD.add(d); seenCode.add(code);
    rows.push({ serial, d, code, a: redeemQrContent(code) });
  }
  const problems = [];
  rows.forEach((r, i) => {
    const at = `row ${i + 1}`;
    if (!A_RE.test(r.a)) problems.push(`${at}: A has a wrong shape`);
    if (!C_RE.test(r.serial)) problems.push(`${at}: C has a wrong shape`);
    if (parseSerial(secret, r.serial) !== r.serial) problems.push(`${at}: serial does not verify`);
    if (normalizeRedeemInput(r.a) !== r.code) problems.push(`${at}: the app would not read A back as the same code`);
    if (redeemCodeFor(secret, r.serial) !== r.code) problems.push(`${at}: A does not belong to C`);
    if (r.serial.slice(-D_LEN) !== r.d) problems.push(`${at}: D does not match C`);
  });
  if (problems.length) throw new Error("Self-check failed, nothing was written: " + problems.slice(0, 5).join("; "));
  return { rows, skippedD, skippedNumber };
}

async function makeCards() {
  const secret = await askSecret();
  if (!secret) return;
  if (!(await confirmSecret(secret))) return;

  out("");
  const answer = await ask("How many cards? (Enter = 5000): ");
  const count = answer === "" ? 5000 : Number.parseInt(answer, 10);
  if (!Number.isInteger(count) || count < 1 || count > 100000) { out("Please type a number from 1 to 100000."); return; }

  out("");
  out(`This creates ${count} NEW cards. Make only ONE batch per print order: a second run gives different codes.`);
  const yes = await ask("Type YES to continue: ");
  if (yes !== "YES") { out("Cancelled. Nothing was created."); return; }

  const { rows, skippedD, skippedNumber } = makeBatch(secret, count);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(baseDir(), "giftcards-output", stamp);
  fs.mkdirSync(dir, { recursive: true });
  const csv = [
    "no,A_redeem_qr_content,B_redeem_text,C_sale_qr_content,D_serial_text",
    ...rows.map((r, i) => [i + 1, r.a, r.code, r.serial, r.d].join(",")),
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "cards.csv"), csv);
  const sha = crypto.createHash("sha256").update(csv).digest("hex");
  fs.writeFileSync(path.join(dir, "cards.csv.sha256.txt"), `${sha}  cards.csv\n`);

  out("");
  out(`Done. ${rows.length} cards.`);
  out(`Self-check passed: every A and B belongs to its C, A / C / D are all unique (skipped ${skippedD} for D, ${skippedNumber} so nothing looks like a number to Excel).`);
  out(`File:    ${path.join(dir, "cards.csv")}`);
  out(`SHA-256: ${sha}`);
  out("Keep this folder. It contains every redeem code: send it only to the print shop.");
}

// ── Check a CSV ─────────────────────────────────────────────────────────────
async function checkCsv() {
  out("Drag cards.csv into this window (or type its full path), then press Enter.");
  const given = (await ask("Path to cards.csv: ")).replace(/^["']|["']$/g, "");
  if (!given || !fs.existsSync(given)) { out("File not found."); return; }
  const secret = await askSecret();
  if (!secret) return;

  const raw = fs.readFileSync(given);
  const text = raw.toString("utf8");
  const problems = [];
  if (text.charCodeAt(0) === 0xfeff) problems.push("The file starts with a byte-order mark (BOM): the first column name is damaged.");
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const header = lines[0].split(",");
  const col = (n) => header.indexOf(n);
  const [cA, cB, cC, cD] = ["A_redeem_qr_content", "B_redeem_text", "C_sale_qr_content", "D_serial_text"].map(col);
  if ([cA, cB, cC, cD].some((c) => c < 0)) { out("The header row is not the one this tool writes."); return; }

  const seen = { A: new Set(), C: new Set(), D: new Set() };
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const at = `row ${i} (line ${i + 1})`;
    if (cells.length !== header.length) { problems.push(`${at}: ${cells.length} columns instead of ${header.length}`); continue; }
    const [a, b, c, d] = [cells[cA], cells[cB], cells[cC], cells[cD]];
    if (cells.some((x) => /["\s]/.test(x))) problems.push(`${at}: a cell contains quotes or spaces`);
    if (!A_RE.test(a)) problems.push(`${at}: A is not shopify-giftcard-v1- + 12 lowercase characters: ${a}`);
    if (a.slice(20) !== b) problems.push(`${at}: B is not A without the prefix`);
    const serial = parseSerial(secret, c);
    if (!serial) { problems.push(`${at}: C is not a valid serial for this secret: ${c}`); continue; }
    if (redeemCodeFor(secret, serial) !== b) problems.push(`${at}: A / B do not belong to C`);
    if (c.slice(-D_LEN) !== d) problems.push(`${at}: D is not the last 5 characters of C`);
    if (!/^[A-Z0-9]{5}$/.test(d) || looksLikeNumber(d)) problems.push(`${at}: D looks changed or could be read as a number: ${d}`);
    for (const [k, v] of [["A", a], ["C", c], ["D", d]]) {
      if (seen[k].has(v)) problems.push(`${at}: ${k} is repeated: ${v}`);
      seen[k].add(v);
    }
  }
  out("");
  out(`${given}: ${lines.length - 1} rows, SHA-256 ${crypto.createHash("sha256").update(raw).digest("hex")}`);
  if (problems.length) {
    out(`NOT OK: ${problems.length} problem(s). First ones:`);
    problems.slice(0, 15).forEach((p) => out("  " + p));
  } else {
    out("OK: every row is valid, A / B belong to C, D matches C, nothing repeated, no cell was altered.");
  }
}

// ── Menu ────────────────────────────────────────────────────────────────────
async function main() {
  out("=== Hera gift card tool ===");
  for (;;) {
    out("");
    out("  1  Make a new batch of cards (cards.csv)");
    out("  2  Check an existing cards.csv");
    out("  3  Exit");
    const choice = await ask("Choose 1, 2 or 3: ");
    try {
      if (choice === "1") await makeCards();
      else if (choice === "2") await checkCsv();
      else if (choice === "3" || choice === "") break;
      else out("Please type 1, 2 or 3.");
    } catch (err) {
      out("Something went wrong: " + (err && err.message ? err.message : err));
    }
  }
}

main().then(
  () => process.exit(0),
  async (err) => {
    out("The tool stopped: " + (err && err.message ? err.message : err));
    await ask("Press Enter to close this window.");
    process.exit(1);
  }
);
