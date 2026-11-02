// Multi-unit building lookup from Statistics Canada's National Address Register (NAR).
// The two data files are built by tools/nar-index.js and committed in data/:
//   nar-all.bin.gz    every civic address in Canada (hash of postal code + civic number)
//   nar-multi.tsv.gz  buildings with 2+ units (street, unit count, how many buildings share the civic address)
//
// lookup() answers:
//   multi      a building with 2+ units (units = how many)
//   single     the civic address exists and is not a multi-unit building
//   not-found  NAR does not know this civic address (often a new building)
//   unsure     several buildings share postal code + civic number and the street does not tell which one

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { norm, normPostal, parseCivic, streetScore, civicKey, fnv1a, provinceOfPostal } from "./nar-normalize.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");

export function loadNar() {
  const t0 = Date.now();
  const allFile = path.join(DATA_DIR, "nar-all.bin.gz");
  const multiFile = path.join(DATA_DIR, "nar-multi.tsv.gz");
  if (!fs.existsSync(allFile) || !fs.existsSync(multiFile)) {
    console.warn("[nar] data/nar-all.bin.gz or data/nar-multi.tsv.gz is missing: run tools/nar-index.js. Unit checks are off.");
    return null;
  }

  // Sorted hashes, stored as varint gaps.
  const raw = zlib.gunzipSync(fs.readFileSync(allFile));
  let count = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] < 0x80) count++;
  const all = new Uint32Array(count);
  let value = 0, gap = 0, shift = 0, k = 0;
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    gap += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) { value += gap; all[k++] = value; gap = 0; shift = 0; } else shift += 7;
  }

  const byCivic = new Map();     // "postal|civic" → rows
  const byProvCivic = new Map(); // "prov|civic"   → rows (when the postal code on the order is wrong)
  const text = zlib.gunzipSync(fs.readFileSync(multiFile)).toString("utf8");
  let rows = 0;
  for (const line of text.split("\n").slice(1)) {
    if (!line) continue;
    const [prov, postal, civic, street, type, units, shared] = line.split("\t");
    const row = { prov, postal, civic, street, type, units: Number(units), shared: Number(shared) || 1 };
    const a = civicKey(postal, civic);
    const b = `${prov}|${civic}`;
    (byCivic.get(a) || byCivic.set(a, []).get(a)).push(row);
    (byProvCivic.get(b) || byProvCivic.set(b, []).get(b)).push(row);
    rows++;
  }
  console.log(`[nar] loaded ${all.length.toLocaleString()} civic addresses and ${rows.toLocaleString()} multi-unit buildings in ${Date.now() - t0} ms`);

  function exists(postal, civic) {
    const h = fnv1a(civicKey(postal, civic));
    let lo = 0, hi = all.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (all[mid] === h) return true;
      if (all[mid] < h) lo = mid + 1; else hi = mid - 1;
    }
    return false;
  }

  // Rows whose street matches line 1 best; score 2 = name + type, 1 = name only.
  const best = (list, line) => {
    const scored = list.map((r) => ({ r, s: streetScore(line, r.street, r.type) }));
    const top = Math.max(0, ...scored.map((x) => x.s));
    return { rows: top > 0 ? scored.filter((x) => x.s === top).map((x) => x.r) : [], score: top };
  };
  const multiAnswer = (list, how) => ({ status: "multi", units: Math.max(...list.map((r) => r.units)), how });

  /** { status, units?, how } for one shipping address (line 1, postal code, province code). */
  function lookup({ address1, zip, province }) {
    const civic = parseCivic(address1);
    if (!civic) return { status: "no-civic" };
    const postal = normPostal(zip);
    const line = norm(address1);
    const prov = String(province || "").toUpperCase() || provinceOfPostal(postal);

    if (postal) {
      const here = byCivic.get(civicKey(postal, civic));
      if (here) {
        // Other (single-unit) buildings share this postal code + civic number: rural postal codes.
        const allMulti = here.every((r) => r.shared === here.length);
        const match = best(here, line);
        if (match.score === 2 || (match.score === 1 && allMulti)) return multiAnswer(match.rows, "postal + civic + street");
        if (allMulti) return multiAnswer(here, "postal + civic");
        // e.g. "402 9th St" when only "402 9th Ave" is multi-unit: probably the other building, but not sure.
        return { status: "unsure", how: "several buildings share postal + civic" };
      }
      if (exists(postal, civic)) return { status: "single", how: "postal + civic" };
    }

    // Wrong or missing postal code: same civic number + street name in the province.
    const elsewhere = prov ? best(byProvCivic.get(`${prov}|${civic}`) || [], line).rows : [];
    if (elsewhere.length) return multiAnswer(elsewhere, `civic + street in ${prov} (postal ${elsewhere[0].postal})`);
    return { status: "not-found" };
  }

  return { lookup };
}
