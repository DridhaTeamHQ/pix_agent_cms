/* ── Supabase Postgres ──
   One lazily-created pool for the whole process, plus the read/write helpers
   the /api/pix routes need.

   The connection string is SUPABASE_POOLER_URL, falling back to
   SUPABASE_DIRECT_CONNECTION_URL (Supabase dashboard → Connect). When neither
   is set the module stays inert and every helper reports "not configured"
   instead of throwing — the app has run without a database since day one and
   must keep working that way. Nothing in the poster pipeline should fail
   because storage is unavailable.

   Note on hosting: the *direct* connection is IPv6-only unless the IPv4 add-on
   is enabled, and it holds a real long-lived socket. That suits this
   long-running Node server (Railway/Docker). A serverless deploy (Netlify,
   Vercel) should use the Transaction pooler URL instead — same code, different
   string. */

import pg from "pg";

const { Pool } = pg;

let pool = null;
let connectionString = "";
let schemaReady = null;

/* Supabase hands out a self-signed chain for the direct host. Verifying it
   needs their CA bundle shipped alongside the app; every Supabase client
   library connects with rejectUnauthorized:false for the same reason. The
   connection is still TLS-encrypted. */
const SSL = { rejectUnauthorized: false };

/**
 * Point the module at a database. Called once at boot with whatever the host
 * exposes — server.mjs reads .env itself, so it passes the value in rather
 * than letting this module guess.
 */
export function configureDb(url) {
  const cleaned = String(url || "").trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
  if (cleaned === connectionString) return isConfigured();
  connectionString = cleaned;
  schemaReady = null;
  if (pool) {
    pool.end().catch(() => {});
    pool = null;
  }
  return isConfigured();
}

export function isConfigured() {
  return Boolean(connectionString || envConnectionString());
}

/* The pooler wins when both are present. `db.<ref>.supabase.co` publishes an
   AAAA record and nothing else, so the direct string is unusable from any
   IPv4-only network — which includes most laptops and plenty of hosts. The
   session pooler is the same database over an IPv4 address. */
export function envConnectionString() {
  return process.env.SUPABASE_POOLER_URL
    || process.env.SUPABASE_DIRECT_CONNECTION_URL
    || process.env.DATABASE_URL
    || process.env.SUPABASE_DB_URL
    || "";
}

function getPool() {
  if (pool) return pool;
  const url = connectionString || envConnectionString();
  if (!url) throw new Error("No database configured. Set SUPABASE_POOLER_URL.");
  connectionString = url;
  pool = new Pool({
    connectionString: url,
    ssl: SSL,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // A pool error with no listener kills the process. A dropped Postgres
  // connection must never take the poster server down with it.
  pool.on("error", (err) => console.warn("⚠ Postgres pool error:", err.message));
  return pool;
}

export async function query(text, params = []) {
  await ensureSchema();
  return getPool().query(text, params);
}

/* Health probe — used by /health and by `npm run db:init`. */
export async function ping() {
  if (!isConfigured()) return { configured: false, ok: false, error: "SUPABASE_POOLER_URL not set" };
  try {
    const { rows } = await getPool().query("select now() as at");
    return { configured: true, ok: true, at: rows[0]?.at || null };
  } catch (err) {
    return { configured: true, ok: false, error: describeConnectionError(err) };
  }
}

/* The one common failure here is IPv6: the direct host resolves to an AAAA
   record only, so an IPv4-only network answers ENETUNREACH/EHOSTUNREACH and
   the raw message ("connect ENETUNREACH 2406:da…") tells you nothing about
   the fix. Say what the fix is. */
function describeConnectionError(err) {
  const code = err?.code || "";
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH" || code === "ENOTFOUND" || code === "ENOENT" || code === "EAI_AGAIN") {
    return `${err.message} — the direct connection is IPv6-only. On an IPv4 network use the Session pooler URL from the Supabase dashboard (Connect → Session pooler), or enable the IPv4 add-on.`;
  }
  if (code === "28P01") return "Password authentication failed — check the password in the connection string (percent-encode any special characters).";
  return err?.message || String(err);
}

export { describeConnectionError };

/* ── Schema ──
   Created on first use and then memoised, so a fresh Supabase project needs no
   manual migration step. Everything is IF NOT EXISTS, so it is safe to run on
   every boot and safe to run concurrently. */
const SCHEMA_SQL = `
create table if not exists pix_posts (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- who built it (from the Shortly agent session; null when auth is off)
  user_login_id     text,
  user_name         text,

  -- what the scrape returned
  source_url        text,
  scraped_title     text,
  article_text      text,
  detail_text       text,
  image_query       text,
  source_image_url  text,

  -- what the AI writer produced
  ai_headline       text,
  ai_bullets        jsonb not null default '[]'::jsonb,
  ai_tweet          text,
  ai_flags          jsonb not null default '[]'::jsonb,

  -- what the poster actually shows
  headline          text,
  detail_body       text,
  main_image_url    text,
  main_image_source text,
  aspect_ratio      text,
  accent_color      text,
  tag               text,

  -- the full editor snapshot: every slider, offset, filter and video setting,
  -- i.e. everything needed to reopen this pix exactly as it was
  design            jsonb not null default '{}'::jsonb
);

/* QA sign-off. Added with ALTER rather than in the CREATE above so a database
   made before approval existed picks the columns up on the next boot — the
   CREATE only ever runs on an empty schema. */
alter table pix_posts add column if not exists approved          boolean not null default false;
alter table pix_posts add column if not exists approved_at       timestamptz;
alter table pix_posts add column if not exists approved_by       text;
alter table pix_posts add column if not exists approved_by_name  text;

create index if not exists pix_posts_created_at_idx on pix_posts (created_at desc);
create index if not exists pix_posts_approved_idx on pix_posts (approved, updated_at desc);
create index if not exists pix_posts_source_url_idx on pix_posts (source_url);
create index if not exists pix_posts_user_idx on pix_posts (user_login_id, created_at desc);
`;

export function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = getPool().query(SCHEMA_SQL).then(
    () => true,
    (err) => {
      // Do not memoise a failure: a transient network error at boot would
      // otherwise poison every later request for the life of the process.
      schemaReady = null;
      throw err;
    }
  );
  return schemaReady;
}

/* ── Columns ──
   The write path is generated from this list so adding a field means touching
   one place. `json: true` columns are stringified before binding. */
const COLUMNS = [
  "user_login_id", "user_name",
  "source_url", "scraped_title", "article_text", "detail_text", "image_query", "source_image_url",
  "ai_headline", { name: "ai_bullets", json: true }, "ai_tweet", { name: "ai_flags", json: true },
  "headline", "detail_body", "main_image_url", "main_image_source",
  "aspect_ratio", "accent_color", "tag",
  { name: "design", json: true },
];

function bindable(col, value) {
  if (typeof col === "string") return value === undefined ? undefined : value;
  return value === undefined ? undefined : JSON.stringify(value ?? null);
}

/**
 * Insert a pix, or update the one with `id`. Only keys present in `fields`
 * are written, so a field the editor could not supply this time never blanks
 * out what is already stored.
 *
 * `ownerId` scopes an update to one user's rows — passed for writers, left
 * null for QA, who may edit anyone's post.
 */
export async function savePix(id, fields = {}, { ownerId = null } = {}) {
  await ensureSchema();

  const names = [];
  const values = [];
  for (const col of COLUMNS) {
    const name = typeof col === "string" ? col : col.name;
    const bound = bindable(col, fields[name]);
    if (bound === undefined) continue;
    names.push(name);
    values.push(bound);
  }

  if (id) {
    const sets = names.map((n, i) => `${n} = $${i + 2}`);
    sets.push("updated_at = now()");
    // Ownership is enforced in the WHERE clause, not by reading the row first
    // and deciding: a check-then-write leaves a window where the row changes
    // hands between the two queries.
    const params = [id, ...values];
    let ownership = "";
    if (ownerId) {
      params.push(ownerId);
      ownership = ` and user_login_id = $${params.length}`;
    }
    const { rows } = await getPool().query(
      `update pix_posts set ${sets.join(", ")} where id = $1${ownership} returning id, created_at, updated_at`,
      params
    );
    if (rows[0]) return rows[0];

    // No row updated: either the id is stale, or it belongs to someone else.
    // Those need different answers, so ask which before falling through to an
    // insert — silently creating a copy of another user's post would be worse
    // than refusing.
    if (ownerId) {
      const { rows: existing } = await getPool().query("select id from pix_posts where id = $1", [id]);
      if (existing[0]) {
        const err = new Error("This post belongs to someone else.");
        err.code = "PIX_FORBIDDEN";
        throw err;
      }
    }
  }

  const placeholders = names.map((_, i) => `$${i + 1}`);
  const { rows } = await getPool().query(
    `insert into pix_posts (${names.join(", ")}) values (${placeholders.join(", ")})
     returning id, created_at, updated_at`,
    values
  );
  return rows[0];
}

/* List view. article_text is the biggest column by far and nothing in a list
   needs it, so it is left out and only its length reported. */
export async function listPix({ limit = 50, offset = 0, userLoginId = null, approved = null } = {}) {
  await ensureSchema();
  const params = [Math.min(Number(limit) || 50, 200), Number(offset) || 0];
  const clauses = [];
  if (userLoginId) {
    params.push(userLoginId);
    clauses.push(`user_login_id = $${params.length}`);
  }
  if (approved !== null && approved !== undefined) {
    params.push(Boolean(approved));
    clauses.push(`approved = $${params.length}`);
  }
  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  const { rows } = await getPool().query(
    `select id, created_at, updated_at, user_login_id, user_name, source_url,
            coalesce(headline, ai_headline, scraped_title) as headline,
            main_image_url, aspect_ratio, accent_color, tag,
            jsonb_array_length(ai_bullets) as bullet_count,
            length(coalesce(article_text, '')) as article_chars,
            approved, approved_at, approved_by_name
       from pix_posts ${where}
      order by created_at desc
      limit $1 offset $2`,
    params
  );
  return rows;
}

export async function getPixAnalytics({ role = "writer", userLoginId = null, approverId = null } = {}) {
  await ensureSchema();

  const scoped = role === "qa"
    ? { clause: "", params: [] }
    : { clause: "where user_login_id = $1", params: [userLoginId] };

  const summaryParams = [...scoped.params, approverId || userLoginId || null];
  const meIndex = summaryParams.length;
  const { rows: summaryRows } = await getPool().query(
    `select count(*)::int as sent_count,
            count(*) filter (where approved)::int as approved_count,
            count(*) filter (where not approved)::int as pending_count,
            round(coalesce((count(*) filter (where approved)) * 100.0 / nullif(count(*), 0), 0))::int as approval_rate,
            round(coalesce(extract(epoch from avg(case when approved_at is not null then approved_at - created_at end)) / 3600.0, 0)::numeric, 1) as avg_approval_hours,
            count(distinct user_login_id)::int as active_writers,
            count(distinct approved_by) filter (where approved_by is not null)::int as active_qas,
            count(*) filter (where approved_by = $${meIndex})::int as approved_by_me_count
       from pix_posts
       ${scoped.clause}`,
    summaryParams
  );

  const trendParams = [...scoped.params];
  const approvedWhere = scoped.clause
    ? `${scoped.clause} and approved_at is not null`
    : "where approved_at is not null";
  const { rows: trendRows } = await getPool().query(
    `with days as (
       select generate_series(current_date - interval '6 days', current_date, interval '1 day')::date as day
     ),
     sent as (
       select created_at::date as day, count(*)::int as sent_count
         from pix_posts
         ${scoped.clause}
        group by 1
     ),
     approved as (
       select approved_at::date as day, count(*)::int as approved_count
         from pix_posts
         ${approvedWhere}
        group by 1
     )
     select days.day::text as date,
            to_char(days.day, 'Dy') as label,
            coalesce(sent.sent_count, 0)::int as sent_count,
            coalesce(approved.approved_count, 0)::int as approved_count
       from days
       left join sent on sent.day = days.day
       left join approved on approved.day = days.day
      order by days.day`,
    trendParams
  );

  let writers = [];
  let qas = [];

  if (role === "qa") {
    const { rows: writerRows } = await getPool().query(
      `select coalesce(nullif(user_name, ''), 'Unknown writer') as user_name,
              user_login_id,
              count(*)::int as sent_count,
              count(*) filter (where approved)::int as approved_count,
              count(*) filter (where not approved)::int as pending_count,
              round(coalesce((count(*) filter (where approved)) * 100.0 / nullif(count(*), 0), 0))::int as approval_rate,
              max(created_at) as last_post_at
         from pix_posts
        group by user_login_id, user_name
        order by sent_count desc, approved_count desc, last_post_at desc
        limit 10`
    );
    writers = writerRows;

    const { rows: qaRows } = await getPool().query(
      `select coalesce(nullif(approved_by_name, ''), 'Unknown QA') as user_name,
              approved_by as user_login_id,
              count(*)::int as approved_count,
              max(approved_at) as latest_approval_at
         from pix_posts
        where approved = true and approved_by is not null
        group by approved_by, approved_by_name
        order by approved_count desc, latest_approval_at desc
        limit 10`
    );
    qas = qaRows;
  }

  return {
    summary: summaryRows[0] || {
      sent_count: 0,
      approved_count: 0,
      pending_count: 0,
      approval_rate: 0,
      avg_approval_hours: 0,
      active_writers: 0,
      active_qas: 0,
      approved_by_me_count: 0,
    },
    trend: trendRows,
    writers,
    qas,
  };
}

export async function getPix(id) {
  await ensureSchema();
  const { rows } = await getPool().query("select * from pix_posts where id = $1", [id]);
  return rows[0] || null;
}

/**
 * QA sign-off. Separate from savePix because approving is not editing: it
 * must not touch a single field of the post itself, and it is the one write
 * a writer can never perform.
 */
export async function setApproval(id, { approved, byId = null, byName = null }) {
  await ensureSchema();
  const { rows } = await getPool().query(
    `update pix_posts
        set approved = $2,
            approved_at = case when $2 then now() else null end,
            approved_by = case when $2 then $3 else null end,
            approved_by_name = case when $2 then $4 else null end
      where id = $1
      returning id, approved, approved_at, approved_by_name`,
    [id, Boolean(approved), byId, byName]
  );
  return rows[0] || null;
}

export async function deletePix(id, { ownerId = null } = {}) {
  await ensureSchema();
  const { rowCount } = ownerId
    ? await getPool().query("delete from pix_posts where id = $1 and user_login_id = $2", [id, ownerId])
    : await getPool().query("delete from pix_posts where id = $1", [id]);
  return rowCount > 0;
}

export async function closeDb() {
  if (!pool) return;
  const p = pool;
  pool = null;
  schemaReady = null;
  await p.end().catch(() => {});
}
