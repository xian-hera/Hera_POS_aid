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

import fetch from "node-fetch";

const CONCURRENCY = 3;
const GAP_MS = 250; // pause after each customer, per worker

const BULK_QUERY = `{
  customers {
    edges {
      node {
        id
        devices: metafield(namespace: "custom", key: "wallet_devices") { value }
        legacy: metafield(namespace: "custom", key: "wallet_push_token") { value }
      }
    }
  }
}`;

const page = (body) => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wallet refresh</title>
<style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:32px auto;padding:0 16px;color:#222}
input,button{font-size:16px;padding:8px 12px}button{cursor:pointer}pre{background:#f4f4f4;padding:12px;white-space:pre-wrap}</style>
</head><body>${body}</body></html>`;

export function registerWalletPush(app, { rateLimit, safeEqual, graphql, fetchCustomer, pushToDevices, usesHC }) {
  const PASSWORD = process.env.REPORT_PASSWORD || "";
  const ENABLED = PASSWORD.length >= 10;

  const job = { state: "idle", step: "", customers: 0, done: 0, pushes: 0, failed: 0, startedAt: null, finishedAt: null, error: "" };

  async function collectCustomerIds() {
    job.step = "asking Shopify for the list of cards";
    const start = await graphql(
      `mutation WalletBulk($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id } userErrors { field message } } }`,
      { q: BULK_QUERY }
    );
    const errs = start.bulkOperationRunQuery?.userErrors || [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
    const id = start.bulkOperationRunQuery.bulkOperation.id;

    let op;
    for (let i = 0; i < 360; i++) { // up to ~30 min
      await new Promise((r) => setTimeout(r, 5000));
      const data = await graphql(
        `query WalletBulkStatus($id: ID!) { node(id: $id) { ... on BulkOperation { status errorCode objectCount url } } }`,
        { id }
      );
      op = data.node;
      job.step = `Shopify is preparing the list (${op?.status || "?"}, ${op?.objectCount || 0} customers read)`;
      if (["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(op?.status)) break;
    }
    if (op?.status !== "COMPLETED") throw new Error(`customer list ${op?.status || "timed out"} ${op?.errorCode || ""}`.trim());
    if (!op.url) return []; // no customers

    const resp = await fetch(op.url);
    if (!resp.ok) throw new Error(`customer list download ${resp.status}`);
    const ids = [];
    for (const line of (await resp.text()).split("\n")) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      let hasDevice = Boolean(row.legacy?.value);
      try { const d = JSON.parse(row.devices?.value || "[]"); if (Array.isArray(d) && d.some((x) => x?.pushToken)) hasDevice = true; } catch { /* ignore */ }
      const customerId = String(row.id || "").split("/").pop();
      if (hasDevice && /^\d+$/.test(customerId) && usesHC(customerId)) ids.push(customerId);
    }
    return ids;
  }

  async function run() {
    Object.assign(job, { state: "running", step: "", customers: 0, done: 0, pushes: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null, error: "" });
    try {
      const ids = await collectCustomerIds();
      job.customers = ids.length;
      job.step = "sending pushes";
      console.log(`[wallet-push] ${ids.length} customer(s) with a Wallet card to refresh`);
      let next = 0;
      const worker = async () => {
        while (next < ids.length) {
          const customerId = ids[next++];
          try {
            const customer = await fetchCustomer(customerId);
            if (customer) job.pushes += await pushToDevices(customer);
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
<form id="f"><input type="password" id="pw" placeholder="Password" autocomplete="current-password" required>
<button>Start</button></form>
<h3>Progress</h3><pre id="s">…</pre>
<script>
const s = document.getElementById("s");
async function poll(){ try{ const r = await fetch("/wallet-push/status"); s.textContent = JSON.stringify(await r.json(), null, 2);}catch(e){} }
setInterval(poll, 3000); poll();
document.getElementById("f").onsubmit = async (e) => { e.preventDefault();
  if (!confirm("Send the update to all Wallet cards now?")) return;
  const r = await fetch("/wallet-push/start", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({password: document.getElementById("pw").value})});
  const j = await r.json().catch(() => ({})); alert(j.message || j.error || r.status); poll(); };
</script>`));
  });

  app.get("/wallet-push/status", rateLimit({ windowMs: 60 * 1000, max: 60 }), (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(job);
  });

  app.post("/wallet-push/start", rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), (req, res) => {
    if (!ENABLED) return res.status(503).json({ error: "Not set up" });
    if (!safeEqual(String(req.body?.password ?? ""), PASSWORD)) {
      console.warn(`[wallet-push] wrong password from ${req.ip}`);
      return res.status(401).json({ error: "Wrong password" });
    }
    if (job.state === "running") return res.status(409).json({ error: "Already running" });
    run();
    console.log(`[wallet-push] started from ${req.ip}`);
    res.json({ message: "Started" });
  });
}
