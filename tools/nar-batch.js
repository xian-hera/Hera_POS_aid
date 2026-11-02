// Batch test of addresses against the refined NAR files (made by tools/nar-refine.js).
//
// Input: a text file, one address per line: "<address line 1>, <postal code>"
//   e.g.  465 Rue Sicard, J7K 0Z8
// Lines starting with # and empty lines are ignored.
//
// Usage (from the Hera_POS_aid folder):
//   node tools/nar-batch.js "D:\202606\NAR_refined" tools/nar-test-addresses.txt
//
// All province files are read once (about 480 MB, usually under a minute), so an address
// with a wrong postal code can still be found by its civic number + street name.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { unitGiven } from "../address.js";

const [dir, listFile] = process.argv.slice(2);
if (!dir || !listFile || !fs.existsSync(dir) || !fs.existsSync(listFile)) {
  console.error('Usage: node tools/nar-batch.js "<NAR_refined folder>" "<addresses .txt>"');
  process.exit(1);
}

const USE = { 1: "residential", 2: "partly residential", 3: "non-residential", 4: "unknown" };
const TYPE_SYNONYMS = [
  ["st", "street", "rue"], ["ave", "av", "avenue"], ["rd", "road", "ch", "chemin"], ["dr", "drive"],
  ["blvd", "boul", "boulevard", "bd"], ["cres", "crescent", "cr"], ["crt", "ct", "court"], ["pl", "place"],
  ["cir", "circle", "cercle"], ["ln", "lane"], ["terr", "terrace", "tsse", "terrasse"], ["hwy", "highway", "route", "rte"],
  ["pky", "pkwy", "parkway"], ["sq", "square", "carre"], ["mtee", "montee"], ["rang", "rg"], ["way"], ["trail", "trl"],
];

function norm(s) {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bsainte\b/g, "ste").replace(/\bsaint\b/g, "st")
    .replace(/\bmonseigneur\b/g, "mgr")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function parseCivic(address1) {
  const s = String(address1 || "").trim();
  const m = s.match(/^\s*[a-z]?\d*[a-z]?\s*[-–]\s*(\d+)\s*([a-z](?![a-z]))?/i)
    || s.match(/^\s*(\d+)\s*([a-z](?![a-z]))?/i)
    || s.match(/(?:^|[\s,])(\d+)\s*([a-z](?![a-z]))?\s+\D/i);
  return m ? { civic: m[1], suffix: (m[2] || "").toUpperCase() } : null;
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

// 0 = street name not in line 1, 1 = name found, 2 = name + street type found
function score(row, address1) {
  const line1 = ` ${norm(address1)} `;
  const name = norm(row.street);
  if (!name || !line1.includes(` ${name} `)) return 0;
  const words = new Set(line1.trim().split(" "));
  const type = norm(row.type);
  const syn = TYPE_SYNONYMS.find((g) => g.includes(type)) || [type];
  return syn.some((t) => words.has(t)) ? 2 : 1;
}

// ── Read the address list ──
const items = fs.readFileSync(listFile, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)
  .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  .map((l, i) => {
    const comma = l.lastIndexOf(",");
    const address1 = (comma >= 0 ? l.slice(0, comma) : l).trim();
    const postal = (comma >= 0 ? l.slice(comma + 1) : "").replace(/\s+/g, "").toUpperCase();
    return { n: i + 1, address1, postal, pc: parseCivic(address1), exact: [], samePostal: [], elsewhere: [] };
  });

const postals = new Set(items.map((it) => it.postal));
const civics = new Set(items.filter((it) => it.pc).map((it) => it.pc.civic));

// ── One pass over every province file ──
const files = fs.readdirSync(dir).filter((f) => /^[A-Z0-9]+\.csv$/i.test(f)).sort();
const t0 = Date.now();
for (const f of files) {
  const prov = f.replace(/\.csv$/i, "");
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, f), { encoding: "utf8" }), crlfDelay: Infinity });
  let head = null;
  for await (const line of rl) {
    if (!head) { head = parseCsvLine(line.replace(/^\uFEFF/, "")); continue; }
    const c1 = line.indexOf(",");
    const postal = line.slice(0, c1);
    const civic = line.slice(c1 + 1, line.indexOf(",", c1 + 1));
    const inPostal = postals.has(postal);
    if (!inPostal && !civics.has(civic)) continue;
    const fields = parseCsvLine(line);
    const row = Object.fromEntries(head.map((h, i) => [h, fields[i]]));
    row.prov = prov;
    for (const it of items) {
      if (!it.pc) continue;
      if (postal === it.postal) {
        if (civic === it.pc.civic) it.exact.push(row);
        else it.samePostal.push(row);
      } else if (civic === it.pc.civic && score(row, it.address1) > 0) {
        it.elsewhere.push(row);
      }
    }
  }
  process.stdout.write(`  read ${prov}.csv\r`);
}
console.log(`Read ${files.length} province files in ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);

// ── Results ──
const fmt = (r) => `${r.civic}${r.suffix} ${[r.street, r.type, r.dir].filter(Boolean).join(" ")}, ${r.city} ${r.postal} (${r.prov}) · units ${r.units} of ${r.addresses} · ${USE[r.use] || r.use}`;
const verdictOf = (rows, address1) => {
  const top = Math.max(0, ...rows.map((r) => score(r, address1)));
  const pool = top > 0 ? rows.filter((r) => score(r, address1) === top) : rows.length === 1 ? rows : [];
  if (!pool.length) return { kind: "UNSURE", pool };
  const units = Math.max(0, ...pool.map((r) => Number(r.units) || 0));
  return units >= 2 ? { kind: "MULTI-UNIT", units, pool } : { kind: "single unit", pool };
};

const summary = {};
for (const it of items) {
  console.log(`#${it.n}  ${it.address1}, ${it.postal}`);
  const given = unitGiven(it.address1, "");
  if (given.given) console.log(`    unit number on the order: YES (${given.how})`);
  if (!it.pc) { console.log("    no civic number found in line 1\n"); summary["no civic number"] = (summary["no civic number"] || 0) + 1; continue; }
  if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(it.postal)) console.log("    postal code is not valid");

  let kind;
  if (it.exact.length) {
    const v = verdictOf(it.exact, it.address1);
    kind = v.kind;
    console.log(`    → ${v.kind}${v.units ? ` (${v.units} units)` : ""}`);
    for (const r of it.exact) console.log(`      ${v.pool.includes(r) ? "*" : " "} ${fmt(r)}`);
  } else if (it.elsewhere.length) {
    const v = verdictOf(it.elsewhere, it.address1);
    kind = `found with another postal code: ${v.kind}`;
    console.log(`    → NOT FOUND with ${it.postal}, but found with another postal code: ${v.kind}${v.units ? ` (${v.units} units)` : ""}`);
    for (const r of it.elsewhere.slice(0, 5)) console.log(`        ${fmt(r)}`);
  } else {
    kind = it.samePostal.length ? "NOT FOUND (postal code exists)" : "NOT FOUND (postal code not in NAR)";
    console.log(`    → ${kind}`);
    const near = it.samePostal.sort((a, b) => Math.abs(a.civic - it.pc.civic) - Math.abs(b.civic - it.pc.civic)).slice(0, 4);
    for (const r of near) console.log(`        nearby: ${fmt(r)}`);
  }
  summary[kind] = (summary[kind] || 0) + 1;
  console.log("");
}

console.log("Summary");
for (const [k, v] of Object.entries(summary)) console.log(`  ${String(v).padStart(3)}  ${k}`);
