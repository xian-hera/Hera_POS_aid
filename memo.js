// MEMO: quick-lookup notes for cashiers (POS tile "MEMO")
// ─────────────────────────────────────────────────────────────────────────────
// Two lists, shown as two tabs in the tile:
//   • this store's memos: anyone at that store can add / edit / delete them
//   • Global memos (e.g. other stores' addresses and phones): read-only until a cashier unlocks
//     editing with MEMO_PASSWORD (Render). Unlocking gives that iPad 30 minutes of edit access.
//
// Storage: one `pos_memo` metaobject per memo (merchant-owned type, created automatically on
// start-up; also visible in Shopify admin → Content → Metaobjects). It survives an app reinstall.
//
// Every route requires a valid POS session token (requirePosAuth).

import crypto from "crypto";
import { displayNameOf } from "./restock.js";

const TYPE = "pos_memo";
const UNLOCK_MINUTES = 30;
const MAX_TITLE = 80;
const MAX_BODY = 4000;
const MAX_PER_LIST = 200;
const CACHE_MS = 20 * 1000;
const COLORS = ["neutral", "info", "success", "caution", "warning", "critical", "auto"]; // "auto" = older memos (shown grey)

const isNumericId = (v) => /^\d{1,20}$/.test(String(v ?? ""));
const isMemoId = (v) => /^gid:\/\/shopify\/Metaobject\/\d{1,20}$/.test(String(v ?? ""));
const gid = (kind, id) => `gid://shopify/${kind}/${id}`;

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const DEFINITION_QUERY = `
  query MemoDefinition {
    metaobjectDefinitionByType(type: "${TYPE}") { id fieldDefinitions { key validations { name value } } }
  }
`;

const DEFINITION_CREATE = `
  mutation MemoDefinitionCreate($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition { id type }
      userErrors { field message code }
    }
  }
`;

const DEFINITION_UPDATE = `
  mutation MemoDefinitionUpdate($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
    metaobjectDefinitionUpdate(id: $id, definition: $definition) {
      metaobjectDefinition { id }
      userErrors { field message code }
    }
  }
`;

const LIST_QUERY = `
  query MemoList($after: String) {
    metaobjects(type: "${TYPE}", first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id fields { key value } }
    }
  }
`;

const GET_QUERY = `
  query MemoGet($id: ID!) {
    metaobject(id: $id) { id type fields { key value } }
  }
`;

const CREATE = `
  mutation MemoCreate($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id fields { key value } }
      userErrors { field message code }
    }
  }
`;

const UPDATE = `
  mutation MemoUpdate($id: ID!, $metaobject: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $metaobject) {
      metaobject { id fields { key value } }
      userErrors { field message code }
    }
  }
`;

const DELETE = `
  mutation MemoDelete($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors { field message code }
    }
  }
`;

const LOCATION_QUERY = `
  query MemoLocation($id: ID!) {
    location(id: $id) {
      name
      displayName: metafield(namespace: "custom", key: "display_name") { value }
    }
  }
`;

const text = (key, name, { choices = null, filterable = false } = {}) => ({
  key,
  name,
  type: "single_line_text_field",
  ...(filterable ? { capabilities: { adminFilterable: { enabled: true } } } : {}),
  ...(choices ? { validations: [{ name: "choices", value: JSON.stringify(choices) }] } : {}),
});

const DEFINITION_INPUT = {
  type: TYPE,
  name: "POS memo",
  description: "MEMO tile (POS): quick-lookup notes per store, plus Global notes for all stores. Written by Hera_POS_aid.",
  displayNameKey: "title",
  fieldDefinitions: [
    text("scope", "Scope", { choices: ["location", "global"], filterable: true }),
    text("location_id", "Location ID", { filterable: true }),
    text("location_code", "Store code"),
    text("title", "Title"),
    { key: "body", name: "Text", type: "multi_line_text_field" },
    { key: "pinned", name: "Pinned", type: "boolean" },
    text("size", "Card size", { choices: ["S", "L"] }),
    text("color", "Card color", { choices: ["neutral", "info", "success", "caution", "warning", "critical", "auto"] }),
    { key: "updated_at", name: "Updated at", type: "date_time" },
    text("updated_by", "Updated by (staff ID)"),
    text("rev", "Revision (changes at every save)"),
  ],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fromNode(node) {
  const f = Object.fromEntries((node.fields || []).map((x) => [x.key, x.value]));
  return {
    id: node.id,
    scope: f.scope === "global" ? "global" : "location",
    locationId: f.location_id || "",
    title: f.title || "",
    body: f.body || "",
    pinned: f.pinned === "true",
    size: f.size === "L" ? "L" : "S",
    color: COLORS.includes(f.color) ? f.color : "neutral",
    updatedAt: f.updated_at || "",
    updatedBy: f.updated_by || "",
    rev: f.rev || "",
  };
}

function cleanTitle(v) {
  return String(v ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, MAX_TITLE);
}

function cleanBody(v) {
  return String(v ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+$/gm, "")      // trailing spaces on each line
    .replace(/\n{3,}/g, "\n\n")      // at most one empty line in a row
    .trim()
    .slice(0, MAX_BODY);
}

// ─── Module ──────────────────────────────────────────────────────────────────

export function registerMemo(app, { graphql, requirePosAuth, rateLimit, safeEqual }) {
  const PASSWORD = process.env.MEMO_PASSWORD || "";
  const UNLOCK_ENABLED = PASSWORD.length >= 6;
  if (!UNLOCK_ENABLED) console.warn("[memo] Global editing is disabled: set MEMO_PASSWORD (6+ characters) on Render");

  // Unlock tokens: "<expiry seconds>.<signature>". Changing MEMO_PASSWORD cancels every unlock.
  const unlockKey = crypto.createHash("sha256")
    .update(`hera-memo|${PASSWORD}|${process.env.SHOPIFY_API_SECRET || ""}`)
    .digest();
  const signUnlock = (exp) => crypto.createHmac("sha256", unlockKey).update(`memo-unlock|${exp}`).digest("base64url");
  function unlockValid(token) {
    if (!UNLOCK_ENABLED) return false;
    const [exp, sig] = String(token || "").split(".");
    if (!/^\d{10}$/.test(exp || "") || Number(exp) * 1000 < Date.now()) return false;
    return safeEqual(signUnlock(exp), sig || "");
  }

  async function gqlChecked(query, variables, rootField) {
    const data = await graphql(query, variables);
    const errs = data?.[rootField]?.userErrors || [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
    return data[rootField];
  }

  // All memos, cached briefly (every change clears the cache).
  let cache = null;
  let loading = null;
  async function loadAll() {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    loading ||= (async () => {
      const all = [];
      let after = null;
      for (let page = 0; page < 20; page++) {
        const data = await graphql(LIST_QUERY, { after });
        const conn = data.metaobjects;
        for (const n of conn?.nodes || []) all.push(fromNode(n));
        if (!conn?.pageInfo?.hasNextPage) break;
        after = conn.pageInfo.endCursor;
      }
      cache = { at: Date.now(), value: all };
      return all;
    })().finally(() => { loading = null; });
    return loading;
  }
  const clearCache = () => { cache = null; };

  const locationCache = new Map();
  async function locationInfo(locationId) {
    const hit = locationCache.get(locationId);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    const data = await graphql(LOCATION_QUERY, { id: gid("Location", locationId) });
    const l = data.location;
    const value = l ? { code: l.name, name: displayNameOf(l.displayName?.value) || l.name } : null;
    locationCache.set(locationId, { at: Date.now(), value });
    return value;
  }

  async function getMemo(id) {
    const data = await graphql(GET_QUERY, { id });
    const n = data.metaobject;
    return n && n.type === TYPE ? fromNode(n) : null;
  }

  const badRequest = (res, msg) => res.status(400).json({ error: msg });
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

  // A memo may be changed by its own store (store memo) or by an unlocked iPad (Global memo).
  function canChange(memo, body) {
    if (memo.scope === "global") return unlockValid(body?.unlockToken) ? null : "Global is locked: tap the lock and enter the password.";
    if (memo.locationId !== String(body?.locationId ?? "")) return "This memo belongs to another store.";
    return null;
  }

  // ── List: this store's memos + Global memos ──
  app.post("/api/memo/list", limiter, requirePosAuth, async (req, res) => {
    const locationId = String(req.body?.locationId ?? "");
    if (!isNumericId(locationId)) return badRequest(res, "Unknown store (no location on this iPad)");
    try {
      const [all, loc] = await Promise.all([loadAll(), locationInfo(locationId).catch(() => null)]);
      return res.json({
        locationName: loc?.name || "This store",
        local: all.filter((m) => m.scope === "location" && m.locationId === locationId),
        global: all.filter((m) => m.scope === "global"),
        unlockAvailable: UNLOCK_ENABLED,
      });
    } catch (err) {
      console.error("[memo] list failed:", err.message);
      return res.status(502).json({ error: "Could not load the memos, please try again" });
    }
  });

  // ── Create or edit (partial: only the fields sent are changed) ──
  app.post("/api/memo/save", limiter, requirePosAuth, async (req, res) => {
    const b = req.body || {};
    const locationId = String(b.locationId ?? "");
    if (!isNumericId(locationId)) return badRequest(res, "Unknown store (no location on this iPad)");

    const fields = [];
    if (b.title !== undefined) {
      const title = cleanTitle(b.title);
      if (!title) return badRequest(res, "Please enter a title");
      fields.push({ key: "title", value: title });
    }
    if (b.body !== undefined) fields.push({ key: "body", value: cleanBody(b.body) });
    if (b.pinned !== undefined) fields.push({ key: "pinned", value: b.pinned ? "true" : "false" });
    if (b.size !== undefined) fields.push({ key: "size", value: b.size === "L" ? "L" : "S" });
    if (b.color !== undefined) fields.push({ key: "color", value: COLORS.includes(b.color) ? b.color : "neutral" });
    if (!fields.length) return badRequest(res, "Nothing to save");
    fields.push({ key: "updated_at", value: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
    fields.push({ key: "updated_by", value: String(b.staffId ?? req.posUser ?? "").slice(0, 40) });
    fields.push({ key: "rev", value: crypto.randomBytes(6).toString("base64url") });

    try {
      if (b.id) {
        // ── Edit ──
        if (!isMemoId(b.id)) return badRequest(res, "Invalid memo");
        const memo = await getMemo(b.id);
        if (!memo) return res.status(404).json({ error: "This memo was deleted" });
        const denied = canChange(memo, b);
        if (denied) return res.status(403).json({ error: denied, locked: memo.scope === "global" });
        // Someone else saved it since this iPad loaded it (pin/unpin alone never conflicts)
        if (b.baseRev !== undefined && memo.rev && b.baseRev !== memo.rev) {
          return res.status(409).json({ error: "Someone else changed this memo in the meantime. Your text is kept: copy it if needed, then go back to see the new version.", current: memo });
        }
        const updated = await gqlChecked(UPDATE, { id: b.id, metaobject: { fields } }, "metaobjectUpdate");
        clearCache();
        console.log(`[memo] ${memo.scope} memo updated (${fields.map((f) => f.key).filter((k) => !k.startsWith("updated") && k !== "rev").join(", ")}) at location ${locationId} by ${req.posUser}`);
        return res.json({ memo: fromNode(updated.metaobject) });
      }

      // ── New ──
      const scope = b.scope === "global" ? "global" : "location";
      if (scope === "global" && !unlockValid(b.unlockToken)) {
        return res.status(403).json({ error: "Global is locked: tap the lock and enter the password.", locked: true });
      }
      if (b.title === undefined) return badRequest(res, "Please enter a title");
      const all = await loadAll();
      const count = all.filter((m) => m.scope === scope && (scope === "global" || m.locationId === locationId)).length;
      if (count >= MAX_PER_LIST) return badRequest(res, `This list is full (${MAX_PER_LIST} memos). Delete old ones first.`);
      const loc = scope === "location" ? await locationInfo(locationId).catch(() => null) : null;
      const created = await gqlChecked(CREATE, {
        metaobject: {
          type: TYPE,
          fields: [
            { key: "scope", value: scope },
            { key: "location_id", value: scope === "location" ? locationId : "" },
            { key: "location_code", value: loc?.code || "" },
            ...(b.pinned === undefined ? [{ key: "pinned", value: "false" }] : []),
            ...(b.size === undefined ? [{ key: "size", value: "S" }] : []),
            ...fields,
          ],
        },
      }, "metaobjectCreate");
      clearCache();
      console.log(`[memo] ${scope} memo created at location ${locationId} by ${req.posUser}`);
      return res.json({ memo: fromNode(created.metaobject) });
    } catch (err) {
      console.error("[memo] save failed:", err.message);
      return res.status(502).json({ error: "Could not save, please try again" });
    }
  });

  // ── Delete ──
  app.post("/api/memo/delete", limiter, requirePosAuth, async (req, res) => {
    const b = req.body || {};
    if (!isMemoId(b.id)) return badRequest(res, "Invalid memo");
    try {
      const memo = await getMemo(b.id);
      if (!memo) { clearCache(); return res.json({ deleted: true }); } // already gone
      const denied = canChange(memo, b);
      if (denied) return res.status(403).json({ error: denied, locked: memo.scope === "global" });
      await gqlChecked(DELETE, { id: b.id }, "metaobjectDelete");
      clearCache();
      console.log(`[memo] ${memo.scope} memo deleted ("${memo.title.slice(0, 40)}") at location ${b.locationId} by ${req.posUser}`);
      return res.json({ deleted: true });
    } catch (err) {
      console.error("[memo] delete failed:", err.message);
      return res.status(502).json({ error: "Could not delete, please try again" });
    }
  });

  // ── Unlock Global editing for 30 minutes ──
  let unlockFails = [];
  app.post("/api/memo/unlock", rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), requirePosAuth, (req, res) => {
    if (!UNLOCK_ENABLED) return res.status(503).json({ error: "Global editing is not set up yet (MEMO_PASSWORD is missing on the server)." });
    const now = Date.now();
    unlockFails = unlockFails.filter((t) => now - t < 60 * 60 * 1000);
    if (unlockFails.length >= 20) return res.status(429).json({ error: "Too many wrong passwords. Try again in an hour." });
    if (!safeEqual(String(req.body?.password ?? ""), PASSWORD)) {
      unlockFails.push(now);
      console.warn(`[memo] wrong unlock password at location ${req.body?.locationId} (${unlockFails.length} in the last hour)`);
      return res.status(401).json({ error: "Wrong password", wrongPassword: true });
    }
    const exp = String(Math.floor(now / 1000) + UNLOCK_MINUTES * 60);
    console.log(`[memo] Global unlocked for ${UNLOCK_MINUTES} min at location ${req.body?.locationId} by ${req.posUser}`);
    return res.json({ token: `${exp}.${signUnlock(exp)}`, expiresAt: Number(exp) * 1000 });
  });

  // ── Start-up: create the metaobject definition if it is missing ──
  (async () => {
    try {
      const data = await graphql(DEFINITION_QUERY, {});
      const def = data.metaobjectDefinitionByType;
      if (!def) {
        const created = await gqlChecked(DEFINITION_CREATE, { definition: DEFINITION_INPUT }, "metaobjectDefinitionCreate");
        console.log(`[memo] created metaobject definition ${created.metaobjectDefinition?.type}`);
      } else {
        const have = new Set(def.fieldDefinitions.map((f) => f.key));
        const missing = DEFINITION_INPUT.fieldDefinitions.filter((f) => !have.has(f.key));
        if (missing.length) {
          await gqlChecked(DEFINITION_UPDATE, {
            id: def.id,
            definition: { fieldDefinitions: missing.map((f) => ({ create: f })) },
          }, "metaobjectDefinitionUpdate");
          console.log(`[memo] added metaobject fields: ${missing.map((f) => f.key).join(", ")}`);
        }
        // Choice lists changed after the first release (e.g. new card colors): update them.
        const changed = DEFINITION_INPUT.fieldDefinitions.filter((f) => {
          const want = f.validations?.find((v) => v.name === "choices")?.value;
          const cur = def.fieldDefinitions.find((x) => x.key === f.key);
          const now = cur?.validations?.find((v) => v.name === "choices")?.value;
          return want && cur && JSON.stringify(JSON.parse(now || "[]")) !== JSON.stringify(JSON.parse(want));
        });
        if (changed.length) {
          await gqlChecked(DEFINITION_UPDATE, {
            id: def.id,
            definition: { fieldDefinitions: changed.map((f) => ({ update: { key: f.key, validations: f.validations } })) },
          }, "metaobjectDefinitionUpdate");
          console.log(`[memo] updated choices of: ${changed.map((f) => f.key).join(", ")}`);
        }
      }
      console.log(`[memo] ready (Global editing ${UNLOCK_ENABLED ? "on" : "off"})`);
    } catch (err) {
      console.error("[memo] setup failed:", err.message);
    }
  })();
}
