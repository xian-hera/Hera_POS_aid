// Hera Points (part of Hera Connect): the loyalty points system that replaces Smile
// ─────────────────────────────────────────────────────────────────────────────
// Customers are identified by their Shopify customer ID (works for customers without email).
//
// Render variables (values never in code, logs or Git):
//   HERA_CONNECT_API_URL   e.g. https://hera-points-web.onrender.com
//   HERA_CONNECT_API_KEY   hp_… (permissions points:read, estimate)
//   POINTS_SOURCE          smile (default, current behaviour) | hc (after the switch day)
//   HC_TEST_CUSTOMER_IDS   Shopify customer IDs (comma separated) that use Hera Points already while
//                          POINTS_SOURCE is still smile: Wallet card, Login tile and receipt points.

import fetch from "node-fetch";

const TIMEOUT_MS = 5000;
const ATTEMPTS = 3; // first try + 2 retries (only for 5xx / timeouts / network errors)

// "7012345678901" or "gid://shopify/Customer/7012345678901" → "7012345678901" ("" when invalid)
export function normId(value) {
  const m = String(value ?? "").trim().match(/^(?:gid:\/\/shopify\/Customer\/)?(\d{1,20})$/);
  return m ? m[1] : "";
}

export function createHeraPoints() {
  const BASE = String(process.env.HERA_CONNECT_API_URL || "").trim().replace(/\/+$/, "");
  const KEY = String(process.env.HERA_CONNECT_API_KEY || "").trim();
  const SOURCE = String(process.env.POINTS_SOURCE || "smile").trim().toLowerCase() === "hc" ? "hc" : "smile";
  const TEST_IDS = new Set(
    String(process.env.HC_TEST_CUSTOMER_IDS || "").split(/[\s,;]+/).map(normId).filter(Boolean)
  );
  const configured = Boolean(BASE && KEY);

  if (SOURCE === "hc" && !configured) {
    console.error("[hc] POINTS_SOURCE=hc but HERA_CONNECT_API_URL / HERA_CONNECT_API_KEY are missing: points cannot be read");
  }
  console.log(`[hc] points source: ${SOURCE}${SOURCE === "smile" ? ` · Hera Points test customers: ${TEST_IDS.size}` : ""} · Hera Points ${configured ? "configured" : "NOT configured"}`);

  /** Does this customer use Hera Points (instead of Smile)? */
  function usesHC(customerId) {
    if (SOURCE === "hc") return true;
    return configured && TEST_IDS.has(normId(customerId));
  }

  async function request(method, path, body) {
    if (!configured) throw new Error("Hera Points is not configured");
    let lastErr;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(`${BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${KEY}`,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        let data = null;
        try { data = await resp.json(); } catch { /* not JSON */ }
        if (resp.ok) return data;
        const err = new Error(`Hera Points ${resp.status}${data?.error ? `: ${String(data.error).slice(0, 160)}` : ""}`);
        err.status = resp.status;
        if (resp.status < 500) throw err; // 4xx: do not retry
        lastErr = err;
      } catch (err) {
        if (err.status && err.status < 500) throw err;
        lastErr = err;
      }
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 300 * attempt));
    }
    throw lastErr;
  }

  /** Available points (can be negative in rare cases). */
  async function getBalance(customerId) {
    const id = normId(customerId);
    if (!id) throw new Error("invalid customer ID");
    const data = await request("GET", `/api/v1/customers/${id}`);
    const n = Number(data?.balance);
    if (!Number.isFinite(n)) throw new Error("Hera Points: no balance in the answer");
    return Math.trunc(n);
  }

  /** Points a cart would earn (same rules as real orders; nothing is recorded). */
  async function estimate({ customerId, channel = "pos", lines }) {
    const data = await request("POST", "/api/v1/estimate", {
      ...(normId(customerId) ? { customerId: normId(customerId) } : {}),
      channel,
      lines,
    });
    const points = Number(data?.points);
    if (!Number.isFinite(points)) throw new Error("Hera Points: no points in the estimate");
    return { points: Math.trunc(points), eligibleAmount: Number(data?.eligibleAmount) || 0 };
  }

  return { SOURCE, configured, usesHC, getBalance, estimate };
}
