// Builds the unit number index used by the server (nar.js) from the refined NAR files.
//
//   node tools/nar-index.js "D:\202606\NAR_refined"
//
// Input : the NAR_refined folder made by tools/nar-refine.js (QC.csv, ON.csv, …)
// Output: data/nar-all.bin.gz    every civic address (postal code + civic number), as sorted hashes
//         data/nar-multi.tsv.gz  every building with 2+ units: prov, postal, civic, street, type, units,
//                                and how many buildings share that postal code + civic number
// Commit both files; Render loads them at start-up. Run again every quarter with the new NAR release.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { norm, civicKey, fnv1a } from "../nar-normalize.js";

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error('Usage: node tools/nar-index.js "<NAR_refined folder>"');
  process.exit(1);
}
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
fs.mkdirSync(outDir, { recursive: true });

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

const files = fs.readdirSync(dir).filter((f) => /^[A-Z]{2}\.csv$/i.test(f)).sort();
if (!files.length) { console.error(`No province files (QC.csv, ON.csv…) in ${dir}`); process.exit(1); }

async function eachRow(fn) {
  for (const f of files) {
    const prov = f.slice(0, 2).toUpperCase();
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, f), { encoding: "utf8" }), crlfDelay: Infinity });
    let head = null;
    for await (const line of rl) {
      if (!head) { head = parseCsvLine(line.replace(/^\uFEFF/, "")); continue; }
      if (!line) continue;
      const v = parseCsvLine(line);
      const r = Object.fromEntries(head.map((h, i) => [h, v[i]]));
      const civic = String(Number(r.civic));
      if (!r.postal || !civic || civic === "NaN") continue;
      fn({ prov, postal: r.postal, civic, street: norm(r.street), type: norm(r.type), dir: norm(r.dir), units: Number(r.units) || 0 });
    }
    process.stdout.write(`  ${prov}`);
  }
  process.stdout.write("\n");
}

const t0 = Date.now();

// Pass 1: hashes of every civic address + buildings with unit numbers (merged when a building
// was split over two input files, see nar-refine.js).
console.log("Pass 1/2");
let hashes = new Uint32Array(16_000_000);
let n = 0;
const withUnits = new Map(); // full key → row
await eachRow((r) => {
  if (n === hashes.length) { const bigger = new Uint32Array(hashes.length * 2); bigger.set(hashes); hashes = bigger; }
  hashes[n++] = fnv1a(civicKey(r.postal, r.civic));
  if (r.units > 0) {
    const k = [r.prov, r.postal, r.civic, r.street, r.type, r.dir].join("|");
    const cur = withUnits.get(k);
    if (cur) cur.units += r.units; else withUnits.set(k, { ...r });
  }
});
const multi = [...withUnits.values()].filter((r) => r.units >= 2);
const multiKeys = new Set(multi.map((r) => civicKey(r.postal, r.civic)));

// Pass 2: how many different buildings share each postal code + civic number that has a multi-unit building.
console.log("Pass 2/2");
const sharing = new Map(); // civic key → Set of street keys
await eachRow((r) => {
  const ck = civicKey(r.postal, r.civic);
  if (!multiKeys.has(ck)) return;
  if (!sharing.has(ck)) sharing.set(ck, new Set());
  sharing.get(ck).add(`${r.street}|${r.type}|${r.dir}`);
});

// All civic addresses: sorted unique hashes, written as varint gaps.
const sorted = hashes.subarray(0, n).sort();
const bytes = [];
let prev = 0, unique = 0;
for (let i = 0; i < sorted.length; i++) {
  const h = sorted[i];
  if (i > 0 && h === prev) continue;
  let gap = h - prev;
  prev = h;
  unique++;
  while (gap >= 0x80) { bytes.push((gap & 0x7f) | 0x80); gap >>>= 7; }
  bytes.push(gap);
}
const allFile = path.join(outDir, "nar-all.bin.gz");
fs.writeFileSync(allFile, zlib.gzipSync(Buffer.from(bytes), { level: 9 }));

const lines = ["prov\tpostal\tcivic\tstreet\ttype\tunits\tshared"];
for (const r of multi.sort((a, b) => (a.postal + a.civic).localeCompare(b.postal + b.civic))) {
  lines.push([r.prov, r.postal, r.civic, r.street, r.type, r.units, sharing.get(civicKey(r.postal, r.civic))?.size || 1].join("\t"));
}
const multiFile = path.join(outDir, "nar-multi.tsv.gz");
fs.writeFileSync(multiFile, zlib.gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8"), { level: 9 }));

const mb = (f) => (fs.statSync(f).size / 1048576).toFixed(1);
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(`  ${n.toLocaleString()} buildings → ${unique.toLocaleString()} civic addresses → ${allFile} (${mb(allFile)} MB)`);
console.log(`  ${multi.length.toLocaleString()} multi-unit buildings → ${multiFile} (${mb(multiFile)} MB)`);
