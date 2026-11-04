// MEMO head-office page: view and edit every store's memos + Global memos in a browser
// ─────────────────────────────────────────────────────────────────────────────
//   https://search-0wf4.onrender.com/memo
//
// Password: MEMO_ADMIN_PASSWORD (Render, 10+ characters). When it is not set, REPORT_PASSWORD (the
// restock report's password) is used, so the same people can use both pages. Signing in sets a
// 12-hour cookie; changing the password signs everybody out.
//
// The data is the same `pos_memo` metaobjects the iPads use (memo.js): a change made here shows on
// the iPads after Refresh, and the same revision check stops a browser and an iPad from overwriting
// each other.

import crypto from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(__dirname, "memo-admin", "index.html"), "utf8");
const LOGIN_PAGE = readFileSync(join(__dirname, "memo-admin", "login.html"), "utf8");

const COOKIE = "hera_memo_admin";
const SESSION_SECONDS = 12 * 60 * 60;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function registerMemoAdmin(app, { rateLimit, safeEqual, memo }) {
  const OWN = process.env.MEMO_ADMIN_PASSWORD || "";
  const PASSWORD = OWN || process.env.REPORT_PASSWORD || "";
  const ENABLED = PASSWORD.length >= 10 && Boolean(memo);
  if (!ENABLED) console.warn("[memo-admin] disabled: set MEMO_ADMIN_PASSWORD (or REPORT_PASSWORD), 10+ characters, on Render");
  else console.log(`[memo-admin] ready at /memo (password: ${OWN ? "MEMO_ADMIN_PASSWORD" : "REPORT_PASSWORD"})`);

  const sessionKey = crypto.createHash("sha256")
    .update(`hera-memo-admin|${PASSWORD}|${process.env.SHOPIFY_API_SECRET || ""}`)
    .digest();
  const sign = (exp) => crypto.createHmac("sha256", sessionKey).update(`memo-admin|${exp}`).digest("base64url");

  function isSignedIn(req) {
    if (!ENABLED) return false;
    const raw = parseCookies(req.headers.cookie)[COOKIE] || "";
    const [exp, sig] = raw.split(".");
    if (!/^\d{10}$/.test(exp || "") || Number(exp) < nowSeconds()) return false;
    return safeEqual(sign(exp), sig || "");
  }

  function setSecurityHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    );
  }

  // Changes only from this page's own scripts (JSON body + SameSite=Strict cookie).
  const isJson = (req) => String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json");

  function guard(req, res) {
    setSecurityHeaders(res);
    if (!ENABLED) { res.status(503).json({ error: "The memo page is not set up" }); return false; }
    if (!isSignedIn(req)) { res.status(401).json({ error: "Please sign in again" }); return false; }
    if (req.method === "POST" && !isJson(req)) { res.status(415).json({ error: "Unsupported request" }); return false; }
    return true;
  }

  // ── Pages ──

  app.get("/memo", (req, res) => {
    setSecurityHeaders(res);
    res.type("html");
    if (!ENABLED) return res.status(503).send("The memo page is not set up (MEMO_ADMIN_PASSWORD or REPORT_PASSWORD is missing on the server).");
    return res.send(isSignedIn(req) ? PAGE : LOGIN_PAGE);
  });

  let loginFails = [];
  app.post("/memo/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), (req, res) => {
    setSecurityHeaders(res);
    if (!ENABLED) return res.status(503).json({ error: "The memo page is not set up" });
    const now = Date.now();
    loginFails = loginFails.filter((t) => now - t < 60 * 60 * 1000);
    if (loginFails.length >= 20) return res.status(429).json({ error: "Too many wrong passwords. Try again in an hour." });
    if (!safeEqual(String(req.body?.password ?? ""), PASSWORD)) {
      loginFails.push(now);
      console.warn(`[memo-admin] wrong password from ${req.ip} (${loginFails.length} in the last hour)`);
      return res.status(401).json({ error: "Wrong password" });
    }
    const exp = String(nowSeconds() + SESSION_SECONDS);
    res.setHeader("Set-Cookie", `${COOKIE}=${exp}.${sign(exp)}; Path=/memo; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`);
    console.log(`[memo-admin] signed in from ${req.ip}`);
    return res.json({ ok: true });
  });

  app.post("/memo/logout", (req, res) => {
    setSecurityHeaders(res);
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/memo; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
    return res.json({ ok: true });
  });

  // ── Data ──

  app.get("/memo/data", rateLimit({ windowMs: 60 * 1000, max: 60 }), async (req, res) => {
    if (!guard(req, res)) return;
    try {
      return res.json(await memo.adminList());
    } catch (err) {
      console.error("[memo-admin] data failed:", err.message);
      return res.status(502).json({ error: "Shopify did not respond, please try again" });
    }
  });

  app.post("/memo/save", rateLimit({ windowMs: 60 * 1000, max: 60 }), async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const r = await memo.adminSave(req.body || {}, "head office");
      return res.status(r.status).json(r.body);
    } catch (err) {
      console.error("[memo-admin] save failed:", err.message);
      return res.status(502).json({ error: "Could not save, please try again" });
    }
  });

  app.post("/memo/delete", rateLimit({ windowMs: 60 * 1000, max: 60 }), async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const r = await memo.adminDelete(String(req.body?.id ?? ""));
      return res.status(r.status).json(r.body);
    } catch (err) {
      console.error("[memo-admin] delete failed:", err.message);
      return res.status(502).json({ error: "Could not delete, please try again" });
    }
  });
}
