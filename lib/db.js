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
    // Supabase's pooler hangs up on connections it considers idle, and a NAT
    // in between will drop a silent socket sooner than that. TCP keepalives
    // keep the connection observably alive so the pool hands out live sockets.
    keepAlive: true,
  });
  // A pool error with no listener kills the process. A dropped Postgres
  // connection must never take the poster server down with it.
  pool.on("error", (err) => console.warn("⚠ Postgres pool error:", err.message));
  return pool;
}

/* Errors that mean "this connection was already dead", as opposed to "the
   statement was rejected". They surface on the next query against a socket the
   pool still believed was good, before any SQL reached the server — so the
   statement provably did not run and re-running it cannot double-apply. */
const DEAD_CONNECTION_CODES = new Set([
  "ECONNRESET",   // socket reset under us
  "EPIPE",        // wrote to a closed socket
  "ETIMEDOUT",    // silent drop, usually a NAT idle timeout
  "08006",        // connection_failure
  "08003",        // connection_does_not_exist
  "57P01",        // admin_shutdown — pooler recycled the backend
  "57P02",        // crash_shutdown
  "57P03",        // cannot_connect_now — Supabase still waking up
]);

function isDeadConnection(err) {
  if (DEAD_CONNECTION_CODES.has(err?.code)) return true;
  return /Connection terminated|Client has encountered a connection error|server closed the connection/i
    .test(err?.message || "");
}

export async function query(text, params = []) {
  await ensureSchema();
  return getPool().query(text, params);
}

/**
 * Same as query(), but retries once when the pool hands back a connection that
 * was already dead. ONLY for statements that are safe to run twice — reads.
 * A write must not use this: a timeout is ambiguous about whether it applied,
 * and this cannot tell the difference.
 */
export async function readQuery(text, params = []) {
  await ensureSchema();
  try {
    return await getPool().query(text, params);
  } catch (err) {
    if (!isDeadConnection(err)) throw err;
    console.warn("⚠ stale Postgres connection, retrying read:", err.code || err.message);
    return getPool().query(text, params);
  }
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

/* QA turn-down. Before these existed a post was either approved or "not
   approved", which conflated two very different things: one QA has looked at
   and refused, and one nobody has reached yet. A review desk needs to tell
   those apart, so rejection is recorded with the same attribution as approval.
   The two flags are mutually exclusive — see setApproval(). */
alter table pix_posts add column if not exists rejected          boolean not null default false;
alter table pix_posts add column if not exists rejected_at       timestamptz;
alter table pix_posts add column if not exists rejected_by       text;
alter table pix_posts add column if not exists rejected_by_name  text;

/* Where the story is filed on the DailyMattr side. Chosen by the writer while
   they build the poster and confirmed by QA at publish, so the person with the
   context picks the section rather than QA guessing at review time. Plain
   integers, not a foreign key: the values live in DailyMattr's system, and
   mirroring their table here would only rot.

   The analytics category filter groups on category_id for the same reason: the
   id is what the writer actually chose, so it cannot drift from the name
   DailyMattr shows the way a stored copy of the name would. */
alter table pix_posts add column if not exists category_id  integer;
alter table pix_posts add column if not exists state_id     integer;

create index if not exists pix_posts_created_at_idx on pix_posts (created_at desc);
create index if not exists pix_posts_category_idx on pix_posts (category_id);
create index if not exists pix_posts_approved_idx on pix_posts (approved, updated_at desc);
create index if not exists pix_posts_rejected_idx on pix_posts (rejected, updated_at desc);
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
  "category_id", "state_id",
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
export async function listPix({ limit = 50, offset = 0, userLoginId = null, status = null, search = "" } = {}) {
  await ensureSchema();
  const params = [Math.min(Number(limit) || 50, 200), Number(offset) || 0];
  const clauses = [];
  if (userLoginId) {
    params.push(userLoginId);
    clauses.push(`user_login_id = $${params.length}`);
  }
  // "awaiting" is the absence of both verdicts, not simply `not approved` —
  // that older reading swept rejected posts back into the review queue.
  if (status === "approved") clauses.push("approved = true");
  else if (status === "rejected") clauses.push("rejected = true");
  else if (status === "awaiting") clauses.push("approved = false and rejected = false");

  /* Search runs in SQL rather than over the fetched rows, because the list is
     capped at 100: a client-side filter would only ever search the first page
     and quietly miss everything older. Matching here also reaches columns the
     list does not select — ai_headline and scraped_title sit inside a
     coalesce, so a post whose headline was edited is still findable by the
     title it was scraped under.

     %, _ and \ are escaped so a headline containing them is matched
     literally instead of behaving as a wildcard. */
  const term = String(search || "").trim().slice(0, 120);
  if (term) {
    params.push(`%${term.replace(/[\\%_]/g, "\\$&")}%`);
    const p = `$${params.length}`;
    clauses.push(
      `(headline ilike ${p} or ai_headline ilike ${p} or scraped_title ilike ${p}` +
      ` or user_name ilike ${p} or source_url ilike ${p} or tag ilike ${p})`
    );
  }

  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  const { rows } = await getPool().query(
    `select id, created_at, updated_at, user_login_id, user_name, source_url,
            coalesce(headline, ai_headline, scraped_title) as headline,
            main_image_url, aspect_ratio, accent_color, tag,
            category_id, state_id,
            jsonb_array_length(ai_bullets) as bullet_count,
            length(coalesce(article_text, '')) as article_chars,
            approved, approved_at, approved_by_name,
            rejected, rejected_at, rejected_by_name
       from pix_posts ${where}
      order by created_at desc
      limit $1 offset $2`,
    params
  );
  return rows;
}

/* Category sentinel for posts filed before the writer picked a section, or
   saved while the DailyMattr list was unreachable. A string, so it can never
   collide with a real category_id. */
export const UNCATEGORISED = "__none__";

export async function getPixAnalytics({
  role = "writer",
  // "full" builds the per-writer roster and the reviewer league table;
  // "basic" skips both. QA gets the state of the queue, an admin gets the
  // reporting about who produced it.
  scope = "full",
  userLoginId = null,
  approverId = null,
  from = null,
  to = null,
  category = null,
  source = null,
} = {}) {
  await ensureSchema();

  /* One filter set shared by every rollup below: the role scope, the QA-chosen
     date range, and the category. Built with running placeholder numbers so a
     query can append its own params afterwards without renumbering. */
  const clauses = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    clauses.push(sql.replace("$?", `$${params.length}`));
  };

  /* Only a writer is scoped to their own rows. Written as "not a reviewer"
     rather than "not qa": with the literal string, adding the admin role
     silently pinned every admin rollup to user_login_id = null, which matches
     no row at all — the whole dashboard read zero while the data was fine.

     Not imported from auth.js on purpose: auth.js imports this module, and
     the cycle would leave one of them half-initialised at load. */
  const scopedToSelf = role !== "qa" && role !== "admin";
  if (scopedToSelf) add("user_login_id = $?", userLoginId);
  if (from) add("created_at >= $?::date", from);
  // Inclusive of the whole end day — a range of 1st→1st has to return the 1st.
  if (to) add("created_at < ($?::date + interval '1 day')", to);
  if (category === UNCATEGORISED) clauses.push("category_id is null");
  else if (category) add("category_id = $?", Number(category));

  /* Sources are presented as hostnames, not full article URLs. This folds
     http/https, paths, ports and a leading www into one stable source key. */
  const sourceHostSql = `regexp_replace(lower(split_part(split_part(regexp_replace(source_url,
    '^[A-Za-z][A-Za-z0-9+.-]*://', ''), '/', 1), ':', 1)), '^www[.]', '')`;
  const sourceClauses = [...clauses, "source_url is not null", "btrim(source_url) <> ''"];
  const sourceWhere = `where ${sourceClauses.join(" and ")}`;
  const { rows: sourceRows } = await getPool().query(
    `select ${sourceHostSql} as value, count(*)::int as post_count
       from pix_posts
       ${sourceWhere}
      group by 1
     having ${sourceHostSql} <> ''
      order by post_count desc, value asc`,
    params
  );

  if (source) add(`${sourceHostSql} = $?`, source);

  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  // For queries that add their own conditions to the same WHERE.
  const and = clauses.length ? `${clauses.join(" and ")} and ` : "";

  /* Daily activity is deliberately independent of the historical date-range
     picker: "Today" must continue to mean the current India calendar day.
     It still follows identity, category and source so those filters remain
     useful across the whole dashboard. */
  const dailyClauses = [];
  const dailyParams = [];
  const addDaily = (sql, value) => {
    dailyParams.push(value);
    dailyClauses.push(sql.replace("$?", `$${dailyParams.length}`));
  };
  if (scopedToSelf) addDaily("user_login_id = $?", userLoginId);
  if (category === UNCATEGORISED) dailyClauses.push("category_id is null");
  else if (category) addDaily("category_id = $?", Number(category));
  if (source) addDaily(`${sourceHostSql} = $?`, source);

  const dailyWhere = dailyClauses.length ? `where ${dailyClauses.join(" and ")}` : "";
  const todayStartSql = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
  const tomorrowStartSql = `(${todayStartSql} + interval '1 day')`;
  const { rows: dailyRows } = await getPool().query(
    `select count(*) filter (
              where created_at >= ${todayStartSql} and created_at < ${tomorrowStartSql}
            )::int as sent_count,
            count(*) filter (
              where approved_at >= ${todayStartSql} and approved_at < ${tomorrowStartSql}
            )::int as approved_count,
            count(*) filter (
              where rejected_at >= ${todayStartSql} and rejected_at < ${tomorrowStartSql}
            )::int as rejected_count,
            count(*) filter (
              where created_at >= ${todayStartSql} and created_at < ${tomorrowStartSql}
                and not approved and not rejected
            )::int as pending_count,
            to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') as day_key,
            ${tomorrowStartSql} as next_reset_at
       from pix_posts
       ${dailyWhere}`,
    dailyParams
  );

  const summaryParams = [...params, approverId || userLoginId || null];
  const meIndex = summaryParams.length;
  const { rows: summaryRows } = await getPool().query(
    `select count(*)::int as sent_count,
            count(*) filter (where approved)::int as approved_count,
            count(*) filter (where rejected)::int as rejected_count,
            count(*) filter (where not approved and not rejected)::int as pending_count,
            round(coalesce((count(*) filter (where approved)) * 100.0 / nullif(count(*), 0), 0))::int as approval_rate,
            round(coalesce(extract(epoch from avg(case when approved_at is not null then approved_at - created_at end)) / 3600.0, 0)::numeric, 1) as avg_approval_hours,
            count(distinct user_login_id)::int as active_writers,
            count(distinct approved_by) filter (where approved_by is not null)::int as active_qas,
            count(*) filter (where approved_by = $${meIndex})::int as approved_by_me_count
       from pix_posts
       ${where}`,
    summaryParams
  );

  let writers = [];
  let qas = [];

  if (scope === "full" && (role === "qa" || role === "admin")) {
    const { rows: writerRows } = await getPool().query(
      `select coalesce(nullif(user_name, ''), 'Unknown writer') as user_name,
              user_login_id,
              count(*)::int as sent_count,
              count(*) filter (where approved)::int as approved_count,
              count(*) filter (where rejected)::int as rejected_count,
              count(*) filter (where not approved and not rejected)::int as pending_count,
              round(coalesce((count(*) filter (where approved)) * 100.0 / nullif(count(*), 0), 0))::int as approval_rate,
              count(*) filter (
                where created_at >= ${todayStartSql} and created_at < ${tomorrowStartSql}
              )::int as today_count,
              -- Output over the last seven days, which is the figure anyone
              -- actually asks for: a lifetime total says who has been here
              -- longest, not who is producing now.
              count(*) filter (where created_at >= now() - interval '7 days')::int as week_count,
              count(*) filter (where created_at >= now() - interval '14 days'
                                 and created_at <  now() - interval '7 days')::int as prev_week_count,
              max(created_at) as last_post_at
         from pix_posts
         ${where}
        group by user_login_id, user_name
        order by sent_count desc, approved_count desc, last_post_at desc
        limit 10`,
      params
    );
    writers = writerRows;

    const { rows: qaRows } = await getPool().query(
      /* Both verdicts, folded into one row per reviewer. A union rather than a
         filter over pix_posts because a reviewer who has only ever rejected
         still belongs on this list, and grouping by approved_by alone would
         drop them. */
      `with decisions as (
         select approved_by as user_login_id, approved_by_name as user_name,
                'approved' as decision, approved_at as decided_at
           from pix_posts
          where ${and}approved = true and approved_by is not null
         union all
         select rejected_by, rejected_by_name, 'rejected', rejected_at
           from pix_posts
          where ${and}rejected = true and rejected_by is not null
       )
       /* Grouped by identity alone, with the name picked per group: a reviewer
          who has since been renamed is still one person, and grouping on the
          name as well would split their record in two. */
       select coalesce(nullif(max(user_name), ''), 'Unknown QA') as user_name,
              user_login_id,
              count(*) filter (where decision = 'approved')::int as approved_count,
              count(*) filter (where decision = 'rejected')::int as rejected_count,
              count(*) filter (
                where decided_at >= ${todayStartSql} and decided_at < ${tomorrowStartSql}
              )::int as today_count,
              /* Weekly, the same as the writer roster. Without these the QA
                 table rendered "undefined" where the writers table showed a
                 number — the two lists are read side by side and have to
                 answer the same question. */
              count(*) filter (where decided_at >= now() - interval '7 days')::int as week_count,
              count(*) filter (where decided_at >= now() - interval '14 days'
                                 and decided_at <  now() - interval '7 days')::int as prev_week_count,
              max(decided_at) filter (where decision = 'approved') as latest_approval_at,
              max(decided_at) as latest_decision_at
         from decisions
        group by user_login_id
        order by approved_count desc, rejected_count desc, latest_decision_at desc
        limit 10`,
      params
    );
    qas = qaRows;
  }

  /* Recent posts with their author.

     The leaderboards answer "who is producing" but nothing here answered
     "who wrote THAT one" — the payload carried no post rows at all, so a
     content item on the analytics screen had nothing to click through to.
     This is the per-item view: same coalesce as the review list so an edited
     headline still shows, and the author fields the boards only ever used as
     GROUP BY keys. */
  const { rows: recentRows } = await getPool().query(
    `select id,
            created_at,
            coalesce(headline, ai_headline, scraped_title) as headline,
            coalesce(nullif(user_name, ''), 'Unknown writer') as user_name,
            user_login_id,
            source_url,
            main_image_url,
            approved,
            approved_at,
            approved_by_name
       from pix_posts
      ${where}
      order by created_at desc
      limit 30`,
    params
  );

  return {
    recent: recentRows,
    summary: summaryRows[0] || {
      sent_count: 0,
      approved_count: 0,
      rejected_count: 0,
      pending_count: 0,
      approval_rate: 0,
      avg_approval_hours: 0,
      active_writers: 0,
      active_qas: 0,
      approved_by_me_count: 0,
    },
    writers,
    qas,
    sources: sourceRows,
    daily: {
      ...(dailyRows[0] || {
        sent_count: 0,
        approved_count: 0,
        rejected_count: 0,
        pending_count: 0,
        day_key: null,
        next_reset_at: null,
      }),
      timezone: "Asia/Kolkata",
    },
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
/* One person's own tally, for the header chip every role can see.

   Deliberately not part of getPixAnalytics: that is management reporting and
   is gated to QA and admins, whereas this is a writer's own count of their own
   work and has to be readable by the writer. Both numbers are computed for
   everyone and the caller shows whichever fits the role — a reviewer who also
   writes gets a truthful answer to either question.

   "Week" is the trailing seven days rather than a calendar week, matching the
   roster counts elsewhere, so the two never disagree on a Monday. */
export async function getUserPixCounts(userId) {
  await ensureSchema();
  const id = String(userId || "");
  const { rows } = await getPool().query(
    `select
       count(*) filter (where user_login_id = $1
                          and created_at >= date_trunc('day', now()))::int as written_today,
       count(*) filter (where user_login_id = $1)::int as written_total,
       count(*) filter (where user_login_id = $1
                          and created_at >= now() - interval '7 days')::int as written_week,
       count(*) filter (where (approved_by = $1 or rejected_by = $1)
                          and greatest(coalesce(approved_at, 'epoch'::timestamptz),
                                       coalesce(rejected_at, 'epoch'::timestamptz))
                              >= date_trunc('day', now()))::int as reviewed_today,
       count(*) filter (where approved_by = $1 or rejected_by = $1)::int as reviewed_total,
       count(*) filter (where (approved_by = $1 or rejected_by = $1)
                          and greatest(coalesce(approved_at, 'epoch'::timestamptz),
                                       coalesce(rejected_at, 'epoch'::timestamptz))
                              >= now() - interval '7 days')::int as reviewed_week
     from pix_posts`,
    [id]
  );
  return rows[0] || { written_today: 0, written_week: 0, written_total: 0,
                      reviewed_today: 0, reviewed_week: 0, reviewed_total: 0 };
}

export async function setApproval(id, { approved, rejected = false, byId = null, byName = null }) {
  await ensureSchema();
  // Approving and rejecting are opposite verdicts on the same post, so setting
  // one always clears the other. Clearing both is how a post goes back to
  // awaiting review — the state it starts in.
  const isApproved = Boolean(approved);
  const isRejected = !isApproved && Boolean(rejected);
  const { rows } = await getPool().query(
    `update pix_posts
        set approved = $2,
            approved_at = case when $2 then now() else null end,
            approved_by = case when $2 then $4 else null end,
            approved_by_name = case when $2 then $5 else null end,
            rejected = $3,
            rejected_at = case when $3 then now() else null end,
            rejected_by = case when $3 then $4 else null end,
            rejected_by_name = case when $3 then $5 else null end
      where id = $1
      returning id, approved, approved_at, approved_by_name,
                rejected, rejected_at, rejected_by_name`,
    [id, isApproved, isRejected, byId, byName]
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
