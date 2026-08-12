/* ── /api/pix ──
   Transport-free core for the pix library endpoints, so the Node server
   (server.mjs) and the serverless handler (api/pix.js) share one
   implementation instead of drifting apart like the older routes did.

   Every route answers { status, body } and never throws: storage is an
   optional feature of this app, and a database that is down must degrade to
   "not saved" rather than break the editor. */

import { isConfigured, savePix, listPix, getPix, deletePix, setApproval, ping, describeConnectionError } from "./db.js";

/* Caps. A poster is small text; anything far past these is either a runaway
   paste or a data: URL someone tried to smuggle into a text column. */
const LIMITS = {
  article_text: 120_000,
  detail_text: 4_000,
  detail_body: 8_000,
  text: 2_000,
  url: 2_048,
  bullets: 12,
  design: 200_000,   // serialised bytes
};

/* Authorship is deliberately absent: user_login_id and user_name are set from
   the session in handleSave, so a client cannot claim to be someone else. */
const CLIENT_TO_COLUMN = {
  sourceUrl: "source_url",
  scrapedTitle: "scraped_title",
  articleText: "article_text",
  detailText: "detail_text",
  imageQuery: "image_query",
  sourceImageUrl: "source_image_url",
  aiHeadline: "ai_headline",
  aiBullets: "ai_bullets",
  aiTweet: "ai_tweet",
  aiFlags: "ai_flags",
  headline: "headline",
  detailBody: "detail_body",
  mainImageUrl: "main_image_url",
  mainImageSource: "main_image_source",
  aspectRatio: "aspect_ratio",
  accentColor: "accent_color",
  tag: "tag",
  categoryId: "category_id",
  stateId: "state_id",
  design: "design",
};

/* The two integer columns. Everything else here is text or JSON, so they need
   their own branch in normalise() — running them through clip() would store
   the string "15" in an integer column and Postgres would reject the write. */
const INT_COLUMNS = new Set(["category_id", "state_id"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every route needs a signed-in `user` ({ id, username, role, displayName }).
 * The role decides scope, and it is applied here rather than in the browser:
 *
 *   writer — reads and writes only their own posts
 *   qa     — reads and writes everyone's, and is the only role that can delete
 */
export async function handlePixRequest({ method, path = "/api/pix", query = {}, body = {}, user = null }) {
  if (!isConfigured()) {
    return {
      status: 503,
      body: { error: "No database configured. Set SUPABASE_POOLER_URL to save posts." },
    };
  }
  if (!user) {
    return { status: 401, body: { error: "Sign in to use the post library." } };
  }

  // null = unrestricted (QA). A writer is scoped to rows stamped with their id.
  const ownerId = user.role === "qa" ? null : user.id;

  const approving = String(path || "").replace(/\/+$/, "").endsWith("/approve");

  try {
    if (method === "POST" && approving) return await handleApprove(query.id || body?.id, body, user);
    if (method === "POST") return await handleSave(body, user, ownerId);
    if (method === "GET") return query.id ? await handleGetOne(query.id, ownerId) : await handleList(query, ownerId);
    if (method === "DELETE") return await handleDelete(query.id || body?.id, user);
    return { status: 405, body: { error: "Method not allowed." } };
  } catch (err) {
    if (err?.code === "PIX_FORBIDDEN") {
      return { status: 403, body: { error: "That post belongs to another writer — only QA can edit it." } };
    }
    const message = describeConnectionError(err);
    console.warn("⚠ /api/pix failed:", message);
    return { status: 502, body: { error: message } };
  }
}

async function handleSave(body, user, ownerId) {
  const id = body?.id ? String(body.id) : null;
  if (id && !UUID_RE.test(id)) return { status: 400, body: { error: "Invalid id." } };

  const fields = normalise(body);
  if (!Object.keys(fields).length) {
    return { status: 400, body: { error: "Nothing to save." } };
  }

  // Authorship comes from the session, never from the request body — otherwise
  // any writer could file a post under another account's name.
  if (!id) {
    fields.user_login_id = user.id;
    fields.user_name = user.displayName || user.username;
  } else {
    delete fields.user_login_id;
    delete fields.user_name;
  }

  const row = await savePix(id, fields, { ownerId });
  return {
    status: 200,
    body: {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      created: !id || row.id !== id,
    },
  };
}

async function handleList(query, ownerId) {
  const rows = await listPix({
    limit: query.limit,
    offset: query.offset,
    // QA may narrow the list to one author; a writer is pinned to their own.
    userLoginId: ownerId || (query.user ? String(query.user) : null),
    approved: parseApprovedFilter(query.approved),
    search: query.q || "",
  });
  return { status: 200, body: { posts: rows, count: rows.length } };
}

/* Absent means "no filter"; only an explicit true/false narrows the list. */
function parseApprovedFilter(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value === "true" || value === true) return true;
  if (value === "false" || value === false) return false;
  return null;
}

/* Approval is QA's alone — it is the whole point of the role. */
async function handleApprove(id, body, user) {
  if (user.role !== "qa") {
    return { status: 403, body: { error: "Only QA can approve posts." } };
  }
  if (!id || !UUID_RE.test(String(id))) return { status: 400, body: { error: "Invalid id." } };

  // Default to approving; sending { approved: false } withdraws it.
  const approved = body?.approved === undefined ? true : Boolean(body.approved);
  const row = await setApproval(String(id), {
    approved,
    byId: user.id,
    byName: user.displayName || user.username,
  });
  if (!row) return { status: 404, body: { error: "Not found." } };
  return {
    status: 200,
    body: {
      id: row.id,
      approved: row.approved,
      approvedAt: row.approved_at,
      approvedByName: row.approved_by_name,
    },
  };
}

async function handleGetOne(id, ownerId) {
  if (!UUID_RE.test(String(id))) return { status: 400, body: { error: "Invalid id." } };
  const row = await getPix(String(id));
  // A writer asking for someone else's post gets the same answer as for a
  // post that does not exist — the library should not confirm what it holds.
  if (!row || (ownerId && row.user_login_id !== ownerId)) {
    return { status: 404, body: { error: "Not found." } };
  }
  return { status: 200, body: { post: row } };
}

async function handleDelete(id, user) {
  if (!id || !UUID_RE.test(String(id))) return { status: 400, body: { error: "Invalid id." } };
  if (user.role !== "qa") {
    return { status: 403, body: { error: "Only QA can delete posts." } };
  }
  const gone = await deletePix(String(id));
  return gone ? { status: 200, body: { deleted: true } } : { status: 404, body: { error: "Not found." } };
}

/* Health detail for /health — never throws. */
export async function pixStorageHealth() {
  return ping();
}

/* ── Normalisation ──
   Client keys are camelCase and every one is optional; only keys actually
   present become columns to write. */
function normalise(body) {
  const out = {};
  for (const [clientKey, column] of Object.entries(CLIENT_TO_COLUMN)) {
    if (!(clientKey in body)) continue;
    const value = body[clientKey];

    if (column === "ai_bullets") {
      out[column] = toStringArray(value, LIMITS.bullets, LIMITS.text);
      continue;
    }
    if (column === "ai_flags") {
      out[column] = toStringArray(value, LIMITS.bullets, LIMITS.text);
      continue;
    }
    if (column === "design") {
      out[column] = toDesign(value);
      continue;
    }
    if (INT_COLUMNS.has(column)) {
      // "" clears the column; anything non-numeric is treated as "not set"
      // rather than an error, so a stale value cannot pin a post to the wrong
      // section.
      const n = Number(value);
      out[column] = Number.isInteger(n) && n > 0 ? n : null;
      continue;
    }
    if (column.endsWith("_url")) {
      const url = toUrl(value);
      // undefined means "not storable" (a data: URL). Leave the column out
      // entirely so an export of an AI-enhanced image does not erase the
      // address of the image it was enhanced from.
      if (url !== undefined) out[column] = url;
      continue;
    }

    const cap = LIMITS[column] || LIMITS.text;
    out[column] = clip(value, cap);
  }
  return out;
}

function clip(value, max) {
  if (value === null || value === undefined) return null;
  // Postgres text columns reject NUL bytes outright; scraped HTML occasionally
  // carries one. Strip rather than let a whole save fail on it.
  const text = String(value).replace(/\u0000/g, "").trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/* A base64 data: URL is an entire image — hundreds of KB of it. Those belong
   in object storage, not in a text column. Answers undefined for one so the
   caller can leave the column untouched. */
function toUrl(value) {
  const text = clip(value, LIMITS.url);
  if (!text) return null;
  if (/^data:/i.test(text)) return undefined;   // keep whatever is stored
  if (!/^https?:\/\//i.test(text)) return null;
  return text;
}

function toStringArray(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => clip(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function toDesign(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  let serialised;
  try {
    serialised = JSON.stringify(value);
  } catch {
    return {};
  }
  // Guard against an accidental data: URL or a whole canvas snapshot landing
  // in the snapshot blob.
  if (serialised.length > LIMITS.design) {
    console.warn(`⚠ /api/pix: design snapshot was ${serialised.length} bytes — stored empty.`);
    return {};
  }
  return value;
}
