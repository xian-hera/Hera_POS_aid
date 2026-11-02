// Refine the Statistics Canada National Address Register (NAR) into one small CSV per province.
//
// Input : the unzipped "Addresses" folder (Address_*.csv; the Locations folder is not needed).
// Output: <output folder>/QC.csv, ON.csv, … one row per building:
//   postal,civic,suffix,street,type,dir,city,units,addresses,use
//     units     = rows of that building with an apartment/suite number (APT_NO_LABEL)
//     addresses = all rows of that building
//     use       = BU_USE (1 residential, 2 partly residential, 3 non-residential, 4 unknown)
// Addresses without a civic number (PO Box, RR…) are skipped.
//
// Usage (from the Hera_POS_aid folder):
//   node tools/nar-refine.js "D:\NAR\Addresses"                  → writes D:\NAR\NAR_refined
//   node tools/nar-refine.js "D:\NAR\Addresses" "D:\NAR\out"     → writes D:\NAR\out
//
// Memory stays small: each input file is merged on its own. If one building's rows are split
// across two input files it appears twice in the output; the index builder adds those up.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const PROV = { 10: "NL", 11: "PE", 12: "NS", 13: "NB", 24: "QC", 35: "ON", 46: "MB", 47: "SK", 48: "AB", 59: "BC", 60: "YT", 61: "NT", 62: "NU" };
const OUT_COLS = ["postal", "civic", "suffix", "street", "type", "dir", "city", "units", "addresses", "use"];

const inDir = process.argv[2];
if (!inDir || !fs.existsSync(inDir) || !fs.statSync(inDir).isDirectory()) {
  console.error('Usage: node tools/nar-refine.js "<Addresses folder>" ["<output folder>"]');
  process.exit(1);
}
const outDir = process.argv[3] || path.join(path.dirname(path.resolve(inDir)), "NAR_refined");

/** Split one CSV line (handles "quoted, fields" and "" escapes). */
function parseCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const csvCell = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const writers = new Map(); // province → write stream
const stats = new Map();   // province → { buildings, multi, addresses }

function writerFor(prov) {
  if (!writers.has(prov)) {
    const w = fs.createWriteStream(path.join(outDir, `${prov}.csv`), { encoding: "utf8" });
    w.write(OUT_COLS.join(",") + "\n");
    writers.set(prov, w);
    stats.set(prov, { buildings: 0, multi: 0, addresses: 0 });
  }
  return writers.get(prov);
}

async function refineFile(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let idx = null;
  const buildings = new Map(); // key → [prov, postal, civic, suffix, street, type, dir, city, units, addresses, use]
  let rows = 0;
  for await (let line of rl) {
    if (!idx) {
      const head = parseCsvLine(line.replace(/^\uFEFF/, ""));
      idx = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
      for (const need of ["LOC_GUID", "APT_NO_LABEL", "CIVIC_NO", "CIVIC_NO_SUFFIX", "OFFICIAL_STREET_NAME", "OFFICIAL_STREET_TYPE", "OFFICIAL_STREET_DIR", "PROV_CODE", "MAIL_MUN_NAME", "MAIL_POSTAL_CODE", "BU_USE"]) {
        if (!(need in idx)) throw new Error(`${path.basename(file)}: column ${need} not found`);
      }
      continue;
    }
    if (!line) continue;
    const f = parseCsvLine(line);
    rows++;
    const civic = (f[idx.CIVIC_NO] || "").trim();
    if (!civic) continue;
    const prov = PROV[Number(f[idx.PROV_CODE])] || `P${f[idx.PROV_CODE]}`;
    const postal = (f[idx.MAIL_POSTAL_CODE] || "").replace(/\s+/g, "").toUpperCase();
    const suffix = (f[idx.CIVIC_NO_SUFFIX] || "").trim();
    const street = (f[idx.OFFICIAL_STREET_NAME] || "").trim();
    const type = (f[idx.OFFICIAL_STREET_TYPE] || "").trim();
    const dir = (f[idx.OFFICIAL_STREET_DIR] || "").trim();
    const key = [f[idx.LOC_GUID], postal, civic, suffix, street, type, dir].join("|");
    let b = buildings.get(key);
    if (!b) {
      b = [prov, postal, civic, suffix, street, type, dir, (f[idx.MAIL_MUN_NAME] || "").trim(), 0, 0, (f[idx.BU_USE] || "").trim()];
      buildings.set(key, b);
    }
    if ((f[idx.APT_NO_LABEL] || "").trim()) b[8]++;
    b[9]++;
  }
  for (const b of buildings.values()) {
    const [prov, ...cols] = b;
    const w = writerFor(prov);
    if (!w.write(cols.map((v) => csvCell(String(v))).join(",") + "\n")) await new Promise((r) => w.once("drain", r));
    const s = stats.get(prov);
    s.buildings++;
    s.addresses += b[9];
    if (b[8] >= 2) s.multi++;
  }
  return { rows, buildings: buildings.size };
}

const files = fs.readdirSync(inDir).filter((n) => n.toLowerCase().endsWith(".csv")).sort();
if (!files.length) { console.error(`No .csv files in ${inDir}`); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });
console.log(`${files.length} files → ${outDir}`);

const started = Date.now();
for (const [i, name] of files.entries()) {
  const t = Date.now();
  const r = await refineFile(path.join(inDir, name));
  console.log(`[${i + 1}/${files.length}] ${name}: ${r.rows.toLocaleString()} rows → ${r.buildings.toLocaleString()} buildings (${((Date.now() - t) / 1000).toFixed(1)} s)`);
}
await Promise.all([...writers.values()].map((w) => new Promise((r) => w.end(r))));

console.log(`\nDone in ${((Date.now() - started) / 60000).toFixed(1)} min\n`);
console.log("prov  buildings   2+ units   addresses   file size");
for (const [prov, s] of [...stats].sort()) {
  const mb = fs.statSync(path.join(outDir, `${prov}.csv`)).size / 1048576;
  console.log(`${prov.padEnd(5)} ${String(s.buildings).padStart(9)} ${String(s.multi).padStart(10)} ${String(s.addresses).padStart(11)}   ${mb.toFixed(1)} MB`);
}
