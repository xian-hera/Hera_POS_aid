// Look up shipping addresses in the refined NAR files (made by tools/nar-refine.js).
// Type the address as it appears on the order; the script shows:
//   1. whether our rule sees a unit number already (same unitGiven() as /api/address/check)
//   2. every NAR building with the same postal code + civic number, and whether it is multi-unit
//
// Usage (from the Hera_POS_aid folder):
//   node tools/nar-lookup.js "D:\202606\NAR_refined"
// Empty "Address line 1" quits.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { unitGiven } from "../address.js";

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error('Usage: node tools/nar-lookup.js "<NAR_refined folder>"');
  process.exit(1);
}

// First letter of the postal code → province file
const POSTAL_PROV = { A: "NL", B: "NS", C: "PE", E: "NB", G: "QC", H: "QC", J: "QC", K: "ON", L: "ON", M: "ON", N: "ON", P: "ON", R: "MB", S: "SK", T: "AB", V: "BC", Y: "YT" };
const X_PROVS = ["NU", "NT"]; // X… is shared by Nunavut and the Northwest Territories

// Street type spellings that mean the same thing (all already passed through norm())
const TYPE_SYNONYMS = [
  ["st", "street", "rue"], ["ave", "av", "avenue"], ["rd", "road", "ch", "chemin"], ["dr", "drive"],
  ["blvd", "boul", "boulevard", "bd"], ["cres", "crescent", "cr"], ["crt", "ct", "court"], ["pl", "place"],
  ["cir", "circle", "cercle"], ["ln", "lane"], ["terr", "terrace", "tsse", "terrasse"], ["hwy", "highway", "route", "rte"],
  ["pky", "pkwy", "parkway"], ["sq", "square", "carre"], ["mtee", "montee"], ["rang", "rg"], ["way"], ["trail", "trl"],
];

const USE = {1: "residential", 2: "partly residential", 3: "non-residential", 4: "unknown" };

/** "12-345A Rue X" → { civic: "345", suffix: "A" }; "345 Main St #3" → { civic: "345", suffix: "" } */
function parseCivic(address1) {
  const s = String(address1 || "").trim();
  const dash = s.match(/^\s*[a-z]?\d*[a-z]?\s*[-–]\s*(\d+)\s*([a-z](?![a-z]))?/i); // unit-civic
  const m = dash || s.match(/^\s*(\d+)\s*([a-z](?![a-z]))?/i) || s.match(/(?:^|[\s,])(\d+)\s*([a-z](?![a-z]))?\s+\D/i);
  return m ? { civic: m[1], suffix: (m[2] || "").toUpperCase() } : null;
}

/** Lower case, no accents, "saint"→"st", only letters/digits. */
function norm(s) {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bsainte\b/g, "ste").replace(/\bsaint\b/g, "st")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}

async function findRows(prov, postal, civic) {
  const file = path.join(dir, `${prov}.csv`);
  if (!fs.existsSync(file)) return null;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  const hits = [];
  let head = null;
  for await (const line of rl) {
    if (!head) { head = parseCsvLine(line.replace(/^\uFEFF/, "")); continue; }
    if (!line.startsWith(postal + ",")) continue; // fast filter before parsing
    const f = parseCsvLine(line);
    const row = Object.fromEntries(head.map((h, i) => [h, f[i]]));
    if (row.civic === civic) hits.push(row);
  }
  return hits;
}

/** When nothing matches: what else is in this postal code, and where else is this civic number + street? */
async function diagnose(prov, postal, civic, address1) {
  const file = path.join(dir, `${prov}.csv`);
  if (!fs.existsSync(file)) return;
  const words = ` ${norm(address1)} `;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let head = null;
  const samePostal = [], sameCivic = [];
  for await (const line of rl) {
    if (!head) { head = parseCsvLine(line.replace(/^﻿/, "")); continue; }
    const p = line.startsWith(postal + ",");
    if (!p && !line.includes(`,${civic},`)) continue;
    const f = parseCsvLine(line);
    const r = Object.fromEntries(head.map((h, i) => [h, f[i]]));
    if (p) samePostal.push(r);
    else if (r.civic === civic && norm(r.street) && words.includes(` ${norm(r.street)} `)) sameCivic.push(r);
  }
  const fmt = (r) => `${r.civic}${r.suffix} ${[r.street, r.type, r.dir].filter(Boolean).join(" ")}, ${r.city} ${r.postal} · units ${r.units} of ${r.addresses}`;
  console.log(`  Same postal code ${postal} (${prov}): ${samePostal.length} building(s)`);
  samePostal.sort((a, b) => Math.abs(a.civic - civic) - Math.abs(b.civic - civic)).slice(0, 8).forEach((r) => console.log(`    ${fmt(r)}`));
  console.log(`  Same civic number ${civic} + street name in line 1, other postal codes (${prov}): ${sameCivic.length}`);
  sameCivic.slice(0, 8).forEach((r) => console.log(`    ${fmt(r)}`));
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
async function ask(q) {
  process.stdout.write(q);
  const { value, done } = await input.next();
  if (!process.stdin.isTTY) process.stdout.write((value ?? "") + "\n");
  return done ? "" : value;
}
console.log(`NAR folder: ${dir}\nEmpty "Address line 1" quits.\n`);

while (true) {
  const a1 = (await ask("Address line 1: ")).trim();
  if (!a1) break;
  const a2 = (await ask("Address line 2: ")).trim();
  const postal = (await ask("Postal code   : ")).replace(/\s+/g, "").toUpperCase();

  console.log("\n── Result " + "─".repeat(50));
  const given = unitGiven(a1, a2);
  console.log(`Unit number on the order : ${given.given ? `YES (${given.how}) → the live check would stop here` : "no → the live check would look it up"}`);

  const pc = parseCivic(a1);
  if (!pc) { console.log("Civic number              : not found in line 1\n"); continue; }
  if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(postal)) { console.log("Postal code               : not a valid Canadian postal code\n"); continue; }
  console.log(`Civic number / postal     : ${pc.civic}${pc.suffix} / ${postal}`);

  const provs = postal[0] === "X" ? X_PROVS : [POSTAL_PROV[postal[0]]].filter(Boolean);
  let rows = [];
  for (const p of provs) {
    const t = Date.now();
    const r = await findRows(p, postal, pc.civic);
    if (r === null) console.log(`  (${p}.csv not found in ${dir})`);
    else { rows.push(...r); console.log(`  searched ${p}.csv in ${((Date.now() - t) / 1000).toFixed(1)} s`); }
  }

  if (!rows.length) {
    console.log("NAR                       : NOT FOUND (no building with this postal code + civic number)");
    for (const p of provs) await diagnose(p, postal, pc.civic, a1);
    console.log("");
    continue;
  }
  const line1 = ` ${norm(a1)} `;
  const words = new Set(line1.trim().split(" "));
  // 0 = street name differs, 1 = name matches, 2 = name and street type match
  const score = (r) => {
    const name = norm(r.street);
    if (!name || !line1.includes(` ${name} `)) return 0;
    const type = norm(r.type);
    const syn = TYPE_SYNONYMS.find((g) => g.includes(type)) || [type];
    return syn.some((t) => words.has(t)) ? 2 : 1;
  };
  console.log(`NAR buildings found       : ${rows.length}`);
  for (const r of rows) {
    const street = [r.street, r.type, r.dir].filter(Boolean).join(" ");
    const match = ["street differs", "street name matches", "street name + type match"][score(r)];
    const sfx = r.suffix && r.suffix.toUpperCase() !== pc.suffix ? ` (suffix ${r.suffix})` : "";
    console.log(`  ${r.civic}${r.suffix} ${street}, ${r.city}${sfx} · ${match} · units with number: ${r.units} of ${r.addresses} · ${USE[r.use] || r.use}`);
  }
  const top = Math.max(...rows.map(score));
  const best = top > 0 ? rows.filter((r) => score(r) === top) : [];
  const pool = best.length ? best : rows.length === 1 ? rows : [];
  const units = Math.max(0, ...pool.map((r) => Number(r.units) || 0));
  const verdict = !pool.length ? "UNSURE (several streets share this postal code + civic number, none matches line 1)"
    : units >= 2 ? `MULTI-UNIT (${units} units)` : "single unit";
  console.log(`Verdict                   : ${verdict}\n`);
}
process.exit(0);
