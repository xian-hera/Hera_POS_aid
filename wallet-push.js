// One-time refresh of every Apple Wallet card (switch day Smile → Hera Points)
// ─────────────────────────────────────────────────────────────────────────────
// Hera Points imports the balances without firing its Flow, so cards already in customers'
// Wallets would keep the old Smile number until that customer's points change again.
// This page sends one "your pass changed" push to every registered device of the customers that
// use Hera Points; each iPhone then downloads its card again with the Hera Points balance.
//
//   /wallet-push   password: REPORT_PASSWORD (same as /report). Nothing personal is shown.
//
// Before the switch (POINTS_SOURCE=smile) only HC_TEST_CUSTOMER_IDS are pushed: a safe way to
// test the button. Pushes are throttled (3 customers at a time) so Apple, Shopify and Hera Points
// are not flooded. Dead devices are removed as usual (pushToDevices in server.js).

const CONCURRENCY = 3;
const GAP_MS = 250; // pause after each customer, per worker

import express from "express";

// Customers are read page by page (bulk operations are not allowed with this app's access token).
const PAGE_SIZE = 100;
const PAGE_QUERY = `
  query WalletCustomers($after: String) {
    customers(first: ${PAGE_SIZE}, after: $after) {
      nodes {
        id
        devices: metafield(namespace: "custom", key: "wallet_devices") { value }
        legacy: metafield(namespace: "custom", key: "wallet_push_token") { value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const page = (body) => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wallet refresh</title>
<style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:32px auto;padding:0 16px;color:#222}
input,button{font-size:16px;padding:8px 12px}button{cursor:pointer}pre{background:#f4f4f4;padding:12px;white-space:pre-wrap}</style>
</head><body>${body}</body></html>`;

export function registerWalletPush(app, { rateLimit, safeEqual, graphql, fetchCustomer, pushToDevices, usesHC }) {
  const PASSWORD = process.env.REPORT_PASSWORD || "";
  const ENABLED = PASSWORD.length >= 10;

  const job = { state: "idle", step: "", customers: 0, done: 0, pushes: 0, failed: 0, startedAt: null, finishedAt: null, error: "" };

  // Shopify limits how much can be read per second: wait and try again when throttled.
  async function readPage(after) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await graphql(PAGE_QUERY, { after });
      } catch (err) {
        if (attempt >= 10 || !/throttl/i.test(err.message)) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }

  async function collectCustomerIds() {
    const ids = [];
    let after = null;
    let read = 0;
    for (;;) {
      job.step = `reading customers from Shopify (${read} read, ${ids.length} with a Wallet card)`;
      const data = await readPage(after);
      const conn = data.customers;
      for (const row of conn?.nodes || []) {
        read++;
        let hasDevice = Boolean(row.legacy?.value);
        try { const d = JSON.parse(row.devices?.value || "[]"); if (Array.isArray(d) && d.some((x) => x?.pushToken)) hasDevice = true; } catch { /* ignore */ }
        const customerId = String(row.id || "").split("/").pop();
        if (hasDevice && /^\d+$/.test(customerId) && usesHC(customerId)) ids.push(customerId);
      }
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log(`[wallet-push] ${read} customer(s) read`);
    return ids;
  }

  async function run(givenIds) {
    Object.assign(job, { state: "running", step: "", customers: 0, done: 0, pushes: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null, error: "" });
    try {
      // A list chosen on the page (customers holding a card) avoids reading every customer.
      const ids = givenIds ? givenIds.filter((id) => usesHC(id)) : await collectCustomerIds();
      if (givenIds) console.log(`[wallet-push] list from the page: ${givenIds.length} ID(s), ${ids.length} on Hera Points`);
      job.customers = ids.length;
      job.step = "sending pushes";
      console.log(`[wallet-push] ${ids.length} customer(s) with a Wallet card to refresh`);
      let next = 0;
      const worker = async () => {
        while (next < ids.length) {
          const customerId = ids[next++];
          try {
            const customer = await fetchCustomer(customerId);
            const sent = customer ? await pushToDevices(customer) : 0;
            job.pushes += sent;
          } catch (err) {
            job.failed++;
            console.error(`[wallet-push] customer ${customerId}: ${err.message}`);
          }
          job.done++;
          await new Promise((r) => setTimeout(r, GAP_MS));
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      job.state = "finished";
      job.step = "";
      console.log(`[wallet-push] finished: ${job.done} customer(s), ${job.pushes} push(es), ${job.failed} error(s)`);
    } catch (err) {
      job.state = "failed";
      job.error = err.message;
      console.error(`[wallet-push] failed: ${err.message}`);
    }
    job.finishedAt = new Date().toISOString();
  }

  app.get("/wallet-push", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!ENABLED) return res.status(503).send("Not set up (REPORT_PASSWORD is missing on the server).");
    res.type("html").send(page(`<h2>Refresh all Apple Wallet cards</h2>
<p>Sends one update to every iPhone holding a Hera card, so it shows the Hera Points balance.
Use it once, right after the Hera Points import on the switch day.</p>
<p><b>Customer list (optional, faster):</b> a CSV of the customers holding a card. Only the customer ID
column is read, in this browser; nothing else is sent. Without a file, every customer is read from Shopify.</p>
<p><input type="file" id="csv" accept=".csv,.txt"> <span id="n"></span></p>
<form id="f"><input type="password" id="pw" placeholder="Password" autocomplete="current-password" required>
<button>Start</button></form>
<h3>Progress</h3><pre id="s">…</pre>
<script>
const s = document.getElementById("s");
let ids = null;
async function poll(){ try{ const r = await fetch("/wallet-push/status"); s.textContent = JSON.stringify(await r.json(), null, 2);}catch(e){} }
setInterval(poll, 3000); poll();
function splitCsvLine(line){ const out=[]; let cur="", q=false;
  for (const ch of line){ if (ch === '"') q = !q; else if ((ch === "," || ch === ";" || ch === "\\t") && !q){ out.push(cur); cur=""; } else cur += ch; }
  out.push(cur); return out.map(x => x.trim()); }
document.getElementById("csv").onchange = async (e) => {
  const f = e.target.files[0]; const n = document.getElementById("n"); ids = null; n.textContent = "";
  if (!f) return;
  const lines = (await f.text()).split(/\\r?\\n/).filter(l => l.trim());
  const found = new Set();
  // 1) gid://shopify/Customer/123 anywhere
  for (const l of lines) for (const m of l.matchAll(/gid:\\/\\/shopify\\/Customer\\/(\\d{6,20})/g)) found.add(m[1]);
  // 2) a column named like "Customer ID" / "ID"
  if (!found.size && lines.length) {
    const head = splitCsvLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z]/g, ""));
    let col = head.findIndex(h => h === "customerid" || h === "shopifycustomerid" || h === "shopifyid");
    if (col < 0) col = head.findIndex(h => h === "id");
    if (col < 0) { n.textContent = "No customer ID column found (expected a column named Customer ID or ID)."; return; }
    for (const l of lines.slice(1)) { const v = (splitCsvLine(l)[col] || "").replace(/^'+/, ""); const m = v.match(/(\\d{6,20})$/); if (m) found.add(m[1]); }
  }
  ids = [...found];
  n.textContent = ids.length ? ids.length + " customers found in the file." : "No customer IDs found in the file.";
  if (!ids.length) ids = null;
};
document.getElementById("f").onsubmit = async (e) => { e.preventDefault();
  const what = ids ? ids.length + " customers from the file" : "all customers (read from Shopify)";
  if (!confirm("Send the update to the Wallet cards of " + what + " now?")) return;
  const r = await fetch("/wallet-push/start", {method:"POST", headers:{"Content-Type":"text/plain"}, body: JSON.stringify({password: document.getElementById("pw").value, ids})});
  const j = await r.json().catch(() => ({})); alert(j.message || j.error || r.status); poll(); };
</script>`));
  });

  app.get("/wallet-push/status", rateLimit({ windowMs: 60 * 1000, max: 60 }), (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(job);
  });

  // Sent as text (the list can be larger than the app's normal JSON limit)
  app.post("/wallet-push/start", rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), express.text({ type: "text/plain", limit: "5mb" }), (req, res) => {
    if (!ENABLED) return res.status(503).json({ error: "Not set up" });
    if (typeof req.body === "string") {
      try { req.body = JSON.parse(req.body); } catch { return res.status(400).json({ error: "Bad request" }); }
    }
    if (!safeEqual(String(req.body?.password ?? ""), PASSWORD)) {
      console.warn(`[wallet-push] wrong password from ${req.ip}`);
      return res.status(401).json({ error: "Wrong password" });
    }
    if (job.state === "running") return res.status(409).json({ error: "Already running" });
    let ids = null;
    if (Array.isArray(req.body?.ids)) {
      ids = [...new Set(req.body.ids.map((x) => String(x).trim()).filter((x) => /^\d{6,20}$/.test(x)))];
      if (!ids.length) return res.status(400).json({ error: "No valid customer ID in the list" });
    }
    run(ids);
    console.log(`[wallet-push] started from ${req.ip} (${ids ? `${ids.length} customer(s) from a file` : "all customers"})`);
    res.json({ message: ids ? `Started: ${ids.length} customers` : "Started: all customers" });
  });
}
