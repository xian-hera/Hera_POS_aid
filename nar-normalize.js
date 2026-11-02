// Shared by the NAR index builder (tools/nar-index.js) and the live lookup (nar.js).
// Both sides MUST normalize the same way, so keep every rule here.

// Street type spellings that mean the same thing (values already passed through norm()).
export const TYPE_SYNONYMS = [
  ["st", "street", "rue"], ["ave", "av", "avenue"], ["rd", "road", "ch", "chemin"], ["dr", "drive"],
  ["blvd", "boul", "boulevard", "bd"], ["cres", "crescent", "cr"], ["crt", "ct", "court"], ["pl", "place"],
  ["cir", "circle", "cercle"], ["ln", "lane"], ["terr", "terrace", "tsse", "terrasse"], ["hwy", "highway", "route", "rte"],
  ["pky", "pkwy", "parkway"], ["sq", "square", "carre"], ["mtee", "montee"], ["rang", "rg"], ["way"], ["trail", "trl"],
];

/** Lower case, no accents, "saint"→"st", "monseigneur"→"mgr", only letters/digits separated by one space. */
export function norm(s) {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\bsainte\b/g, "ste").replace(/\bsaint\b/g, "st")
    .replace(/\bmonseigneur\b/g, "mgr")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

/** "K1A 0a1" → "K1A0A1"; "" when it is not a Canadian postal code. */
export function normPostal(s) {
  const p = String(s ?? "").replace(/\s+/g, "").toUpperCase();
  return /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(p) ? p : "";
}

/** Civic number of address line 1: "12-345A Rue X" → "345", "345 Main St #3" → "345". */
export function parseCivic(address1) {
  const s = String(address1 ?? "").trim();
  const m = s.match(/^\s*[a-z]?\d*[a-z]?\s*[-–]\s*(\d+)\s*([a-z](?![a-z]))?/i) // unit-civic
    || s.match(/^\s*(\d+)\s*([a-z](?![a-z]))?/i)
    || s.match(/(?:^|[\s,])(\d+)\s*([a-z](?![a-z]))?\s+\D/i);
  return m ? String(Number(m[1])) : "";
}

/** How well a NAR street (normalized name + type) matches address line 1: 0 no, 1 name, 2 name + type. */
export function streetScore(address1Norm, streetNorm, typeNorm) {
  if (!streetNorm) return 0;
  const line = ` ${address1Norm} `;
  if (!line.includes(` ${streetNorm} `)) return 0;
  const words = new Set(address1Norm.split(" "));
  const syn = TYPE_SYNONYMS.find((g) => g.includes(typeNorm)) || [typeNorm];
  return syn.some((t) => t && words.has(t)) ? 2 : 1;
}

/** Key of one civic address (postal code + civic number). */
export const civicKey = (postal, civic) => `${postal}|${civic}`;

/** 32-bit FNV-1a hash (the "all buildings" set stores hashes, not text, to stay small). */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// First letter of the postal code → province (X = Nunavut or Northwest Territories).
const POSTAL_PROV = { A: "NL", B: "NS", C: "PE", E: "NB", G: "QC", H: "QC", J: "QC", K: "ON", L: "ON", M: "ON", N: "ON", P: "ON", R: "MB", S: "SK", T: "AB", V: "BC", Y: "YT" };
export const provinceOfPostal = (postal) => POSTAL_PROV[String(postal || "")[0]] || "";
