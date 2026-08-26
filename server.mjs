import http from "node:http";
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync,
  readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { TwitterApi } from "twitter-api-v2";
import Busboy from "busboy";
import {
  suggestRegister, registerRules, assessTone, rectifyInstruction,
} from "./lib/editorial-tone.js";
import {
  configureDb, isConfigured as dbConfigured, ping as dbPing,
  getPix, setApproval,
  claimPublish, recordPublishedId, recordPublishAttempt, releasePublishClaim, readQuery,
} from "./lib/db.js";
import {
  SESSION_COOKIE, parseCookies, sessionCookie, clearedSessionCookie,
  login, logout, sessionUser, purgeExpiredSessions,
  throttleCheck, throttleRecordFailure, throttleClear,
  ROLES, canReview, createUser, listUsers, setPassword, setUserActive, normaliseUsername, isAdmin, updateUser, deleteUser,
} from "./lib/auth.js";
import { handlePixRequest } from "./lib/pix-api.js";
import { handlePixAnalyticsRequest } from "./lib/pix-analytics.js";
import {
  configureStorage, isStorageConfigured, uploadMedia, pingStorage,
  createSignedUploadUrl, statMedia, deleteMedia,
} from "./lib/storage.js";
import {
  fetchDailyMattrMeta, getDailyMattrConfig, publishDailyMattrBuzzContent,
} from "./lib/dailymattr.js";
import {
  ScrapeValidationError, fetchPublicHtml, fetchPublicImage, parseScrapeArticleResult, parseScrapeRequest,
} from "./lib/scrape-security.js";

const root = join(process.cwd(), "public");
const port = Number(process.env.PORT || 3000);
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
const TEXT_DETAIL_CHAR_LIMIT = 500;

function readSecrets() {
  // Try reading .env as JSON from project dir or parent dir
  const candidates = [
    join(process.cwd(), ".env"),
    join(process.cwd(), "..", ".env")
  ];
  for (const file of candidates) {
    try {
      if (existsSync(file)) {
        const raw = readFileSync(file, "utf-8").trim();
        // Support JSON format: { "pexelsApiKey": "..." }
        if (raw.startsWith("{")) return JSON.parse(raw);
        // Support KEY=VALUE format
        const obj = {};
        for (const line of raw.split("\n")) {
          const match = line.match(/^\s*([A-Za-z_]+)\s*[:=]\s*"?([^"]*)"?\s*$/);
          if (match) obj[match[1]] = match[2];
        }
        return obj;
      }
    } catch { /* ignore */ }
  }
  return {};
}

const secrets = readSecrets();

/**
 * Read a secret from the environment, defensively.
 *
 * Pasting into a hosting dashboard very easily carries a trailing newline, a
 * stray space, or the surrounding quotes from a .env line. Any of those goes
 * straight into an Authorization header and the provider answers 401 — which
 * reads as "my key is wrong" when the key is fine. Strip them here so a
 * cosmetic paste error can't masquerade as a bad credential.
 */
function env(name, ...aliases) {
  for (const key of [name, ...aliases]) {
    const raw = process.env[key] ?? secrets[key];
    if (raw == null) continue;
    const cleaned = String(raw).trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
    if (cleaned) return cleaned;
  }
  return "";
}

function dailyMattrConfig() {
  return getDailyMattrConfig({
    DAILYMATTR_BASE_URL: env("DAILYMATTR_BASE_URL", "DAILYMATTR_API_BASE_URL"),
    DAILYMATTR_API_KEY: env("DAILYMATTR_API_KEY"),
    DAILYMATTR_EMAIL: env("DAILYMATTR_EMAIL", "DAILYMATTR_USERNAME"),
    DAILYMATTR_PASSWORD: env("DAILYMATTR_PASSWORD"),
  });
}

// Warn loudly if a value needed cleaning — otherwise this silently papers
// over a misconfiguration the user should fix at the source.
for (const name of ["OPENAI_API_KEY", "UPSCALER_SECRET", "PEXELS_API_KEY", "FAL_KEY"]) {
  const raw = process.env[name] ?? secrets[name];
  if (raw != null && String(raw) !== env(name)) {
    console.warn(`⚠ ${name} had surrounding whitespace or quotes — trimmed. Fix it in the dashboard.`);
  }
}
const pexelsApiKey = env("PEXELS_API_KEY", "pexelsApiKey");
if (pexelsApiKey) {
  console.log(`✓ Pexels API key loaded (${pexelsApiKey.slice(0, 6)}…)`);
} else {
  console.warn("⚠ No Pexels API key found. Stock images will not work.");
  console.warn("  Checked: .env in project dir and parent dir, or PEXELS_API_KEY env var.");
}

/* ── Supabase Postgres (saved pix library) ──
   Optional. Without it every /api/pix call answers 503 and the editor simply
   never saves — nothing else changes. The connection is verified in the
   background so a slow or unreachable database cannot delay the listen(). */
configureDb(env("SUPABASE_POOLER_URL", "SUPABASE_DIRECT_CONNECTION_URL", "DATABASE_URL", "SUPABASE_DB_URL"));
if (dbConfigured()) {
  dbPing().then((r) => {
    if (r.ok) console.log("✓ Supabase Postgres connected — posts will be saved to pix_posts");
    else console.warn(`⚠ Supabase Postgres unreachable: ${r.error}`);
  });
} else {
  console.warn("⚠ No SUPABASE_DIRECT_CONNECTION_URL — scraped posts will not be saved.");
}

/* ── Supabase Storage (uploaded images and video) ──
   Without it, uploads still work in the editor but cannot be saved: a data:
   URL has no address to put in a row. /api/media then answers 503 and the
   post is stored with everything except its image. */
configureStorage({
  url: env("SUPABASE_URL"),
  serviceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"),
});
if (isStorageConfigured()) {
  pingStorage().then((r) => {
    if (r.ok) console.log(`✓ Supabase Storage ready (buckets: ${r.buckets.join(", ") || "none yet"})`);
    else console.warn(`⚠ Supabase Storage unreachable: ${r.error}`);
  });
} else {
  console.warn("⚠ No SUPABASE_SERVICE_ROLE_KEY — uploaded images and videos will not be saved.");
}

/* ── Twitter / X (OAuth 1.0a) ── */
const twitterCfg = {
  appKey:       env("TWITTER_API_KEY"),
  appSecret:    env("TWITTER_API_SECRET"),
  accessToken:  env("TWITTER_ACCESS_TOKEN"),
  accessSecret: env("TWITTER_ACCESS_SECRET"),
};
const twitterClient = (twitterCfg.appKey && twitterCfg.accessToken)
  ? new TwitterApi(twitterCfg)
  : null;
if (twitterClient) {
  console.log(`✓ Twitter API ready (key ${twitterCfg.appKey.slice(0, 6)}…)`);
} else {
  console.warn("⚠ Twitter keys missing — /api/twitter/post will return 503.");
}

/* ── OpenAI (for AI tweet captions) ── */
// Enhance routing. The self-hosted upscaler is free; gpt-image is not, and
// it is only ever a fallback. DISABLE_GPT_IMAGE turns that fallback into a
// hard error so a broken upscaler cannot quietly become a bill.
const upscalerConfigured = Boolean(env("UPSCALER_URL"));
const gptImageDisabled = /^(1|true|yes)$/i.test(env("DISABLE_GPT_IMAGE"));

/* Read the quality actually in force rather than hardcoding a figure. It is
   the difference between ~$0.016 and ~$0.25 a click, and a fixed number in a
   log line goes stale the moment someone edits the variable — which is how
   you end up reassured by a message that is quietly wrong. */
function enhanceCostLabel() {
  const q = (process.env.IMAGE_QUALITY || "low").toLowerCase();
  const per = { low: "~$0.016", medium: "~$0.06", high: "~$0.25" }[q] || "cost unknown";
  return `quality=${q}, ${per} each`;
}
if (gptImageDisabled) {
  console.log("\u2713 gpt-image fallback DISABLED — AI Enhance will only use the self-hosted upscaler");
} else if (!upscalerConfigured) {
  console.warn("\u26a0 No UPSCALER_URL — every AI Enhance will bill gpt-image (" + enhanceCostLabel() + ").");
}

const openaiApiKey = env("OPENAI_API_KEY");
if (openaiApiKey) {
  // Log a fingerprint, never the key. Prefix + length + last 4 is enough to
  // tell "the wrong key is deployed" apart from "the key is revoked" without
  // putting a live credential in the logs.
  const shape = `${openaiApiKey.slice(0, 8)}…${openaiApiKey.slice(-4)} len=${openaiApiKey.length}`;
  console.log(`✓ OpenAI API key loaded (${shape})`);
  if (!/^sk-[A-Za-z0-9_-]+$/.test(openaiApiKey)) {
    console.warn("⚠ OPENAI_API_KEY doesn't look like an OpenAI key (expected sk-… with no spaces).");
  }
} else {
  console.warn("⚠ OPENAI_API_KEY missing — AI features will return 503.");
}

const STOPWORDS = new Set([
  "THE", "A", "AN", "AND", "OR", "BUT", "FOR", "WITH", "FROM", "THAT", "THIS", "WILL", "WOULD", "SHOULD", "COULD",
  "SAYS", "SAID", "AFTER", "BEFORE", "ABOUT", "UNDER", "OVER", "INTO", "ONTO", "WITHIN", "WITHOUT", "THROUGH",
  "THEIR", "THEY", "THEM", "THERE", "THEN", "HAVE", "HAS", "HAD", "WAS", "WERE", "ARE", "IS", "BEEN", "BEING",
  "MORE", "MOST", "VERY", "JUST", "ONLY", "ALSO", "NEWS", "LIVE", "BBC", "NEW", "SOME", "SUCH", "YOUR", "OUR",
  "AGAINST", "DURING", "WHILE", "WHERE", "WHEN", "WHAT", "WHICH", "WHO", "WHOM", "WHY", "HOW"
]);


const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

/* ── Asset versioning ──
   index.html referenced "./app.js" with no version. That is fine while the
   server sends cache headers, but anything cached BEFORE those headers
   existed was stored with no Cache-Control and no Last-Modified at all, and
   browsers cache such responses heuristically — they can serve them for days
   without ever revalidating. Those users silently run an old app.js against
   a new index.html and simply never receive new features.

   Stamping the URL with a hash of the file's own mtime+size means a changed
   asset is a changed URL, which no cache can satisfy from an old entry. */
function assetVersion(...relPaths) {
  let sig = "";
  for (const rel of relPaths) {
    try {
      const st = statSync(join(root, rel));
      sig += `${rel}:${st.mtimeMs}:${st.size};`;
    } catch { /* missing asset — fall through to a stable default */ }
  }
  return createHash("sha1").update(sig).digest("hex").slice(0, 8);
}

// Computed once per process. The files cannot change under a running
// container, and `node --watch` restarts the process on edit in dev.
const ASSET_V = assetVersion("app.js", "styles.css");
const assetMtimeMs = ["app.js", "styles.css"].reduce((newest, rel) => {
  try { return Math.max(newest, statSync(join(root, rel)).mtimeMs); } catch { return newest; }
}, 0);
console.log(`\u2713 asset version ${ASSET_V}`);

function withAssetVersion(html) {
  return html
    .replace(/(<script[^>]+src=")\.\/app\.js(")/g, `$1./app.js?v=${ASSET_V}$2`)
    .replace(/(<link[^>]+href=")\.\/styles\.css(")/g, `$1./styles.css?v=${ASSET_V}$2`);
}

/* ── Who may call /api/* ──
   The only thing that used to stand between the open internet and
   OPENAI_API_KEY, FAL_KEY, the upscaler and yt-dlp was the browser's login
   screen — and curl does not run app.js. The reasoning was already written
   down for the media upload ("an open upload endpoint backed by that key is a
   free file host for anyone who finds it") but never applied to the routes
   that spend money: /api/generate-article, /api/generate-caption,
   /api/analyze-image, /api/flux-image, /api/upscale-image, /api/stock-images
   and /api/google-images all bill a third party per call, /api/video/clip
   spawns yt-dlp and ffmpeg per call, and /api/twitter/post writes to the org's
   X account. Anyone who knew the hostname could run any of them.

   The check lives here rather than in fourteen handlers so it is deny-by-
   default: a route added later is protected before its author thinks about
   auth, and forgetting to allowlist something surfaces as a 401 in
   development instead of as a bill. Handlers that already do their own
   currentUser() check keep it — it costs nothing (the lookup is memoised per
   request) and states each route's own rule where a reader will look for it.

   Only /api/* is matched. /health and /healthz must answer for the platform
   healthcheck — Railway fails the deploy if that path 401s — and every static
   asset must stay open or the browser cannot fetch the login page it needs in
   order to get a session at all. Neither is /api/*, so neither is touched. */
const PUBLIC_API_ROUTES = new Set([
  // How a session is obtained; gating it would make signing in impossible.
  "/api/auth/login",
  // Must work with a dead or already-expired session, otherwise a user
  // holding a stale cookie has no way to clear it.
  "/api/auth/logout",
  // The boot probe (app.js initAuth). It answers its own 401 when signed out
  // and a 503 when the database is unreachable, and the login screen tells
  // those two apart — a blanket 401 here would report an outage as "sign in".
  "/api/auth/me",
]);

/* ── Routes only a reviewer may spend money on ──
   AI Enhance bills gpt-image per call, and it used to be offered to everyone
   who could open the editor. That meant the bill was driven by how many posts
   were WRITTEN, when the only enhanced image that ever reaches DailyMattr is
   one on a post that was approved — every enhance on a story that was later
   rejected, or rewritten, or enhanced twice while the writer compared results,
   was paid for and thrown away.

   Moving it behind the review gate ties the spend to what actually ships.
   Enforced here and not only by hiding the button: the button is a courtesy,
   this is the control. A writer's session posting straight to the endpoint —
   by habit, by a stale tab, or by curl — is refused. */
const REVIEWER_ONLY_API_ROUTES = new Set([
  "/api/upscale-image",
]);

const server = http.createServer(async (req, res) => {
  /* Compare the path alone. Most of these routes carry their arguments in the
     query string and are matched with startsWith() below (/api/image?url=…,
     /api/flux-image?query=…), so testing req.url against the allowlist would
     miss every one of them. */
  const apiPath = req.url?.split("?")[0] || "";
  if (apiPath.startsWith("/api/") && !PUBLIC_API_ROUTES.has(apiPath)) {
    const user = await currentUser(req);
    if (!user) {
      sendJson(res, 401, { error: "Sign in to use Pix." });
      return;
    }
    // 403, not 401: the session is fine, the role is not. Reporting this as
    // "sign in" would send a writer round the login screen forever.
    if (REVIEWER_ONLY_API_ROUTES.has(apiPath) && !canReview(user.role)) {
      sendJson(res, 403, {
        error: "AI Enhance is done by QA at review time — save the post with the image as it is.",
      });
      return;
    }
  }

  if (req.method === "POST" && req.url === "/api/scrape") {
    await handleScrape(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/scrape-article") {
    await handleScrapeArticle(req, res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/image?")) {
    await handleImageProxy(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/auth/login") {
    await handleLogin(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/auth/logout") {
    await handleLogout(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/auth/me") {
    await handleMe(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/video/resolve") {
    await handleVideoResolve(req, res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/video/preview?")) {
    await handleVideoPreview(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/video/clip") {
    await handleVideoClip(req, res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/stock-images?")) {
    await handleStockImages(req, res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/google-images?")) {
    await handleGoogleImages(req, res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/flux-image?")) {
    await handleFluxImage(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/analyze-image") {
    await handleAnalyzeImage(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/twitter/post") {
    await handleTwitterPost(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/generate-caption") {
    await handleGenerateCaption(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/generate-article") {
    await handleGenerateArticle(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/upscale-image") {
    await handleUpscaleImage(req, res);
    return;
  }

  /* Direct-to-Storage upload. /api/media/sign hands the browser a one-shot
     URL, the browser sends the bytes straight to Supabase, and
     /api/media/confirm verifies the object arrived before any post is allowed
     to reference it. The bytes never touch this container. */
  /* Removing an object from the bucket. Admin only, and refused outright for
     anything a post still points at. */
  if (req.method === "POST" && req.url?.startsWith("/api/media/cleanup")) {
    await handleMediaCleanup(req, res);
    return;
  }

  if (req.method === "DELETE" && req.url?.startsWith("/api/media")) {
    await handleMediaDelete(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/media/sign") {
    await handleMediaSign(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/media/confirm") {
    await handleMediaConfirm(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/media") {
    await handleMediaUpload(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/dailymattr/meta") {
    await handleDailyMattrMeta(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/dailymattr/publish") {
    await handleDailyMattrPublish(req, res);
    return;
  }

  // Matched on the path alone — the analytics filters ride in the query string.
  if (req.method === "GET" && req.url?.split("?")[0] === "/api/pix-analytics") {
    await handlePixAnalytics(req, res);
    return;
  }

  if (req.url?.startsWith("/api/users")) {
    await handleUsers(req, res);
    return;
  }

  if (req.url?.startsWith("/api/pix")) {
    await handlePix(req, res);
    return;
  }

  // Railway (and any other platform healthcheck) pings this.
  if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
    sendJson(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      features: {
        openai: Boolean(env("OPENAI_API_KEY")),
        upscaler: upscalerConfigured,
        gptImageFallback: !gptImageDisabled,
        // Video works when both binaries are on PATH; cookies are what make
        // YouTube reliable from a datacenter IP.
        ffmpeg: Boolean(ffmpegAvailable),
        ytdlp: Boolean(ytdlpAvailable),
        ytdlpCookies: Boolean(cookieFilePath),
        jsRuntime: Boolean(jsRuntimeAvailable),
        ytdlpProxy: Boolean(ytdlpProxy),
        pexels: Boolean(pexelsApiKey),
        database: dbConfigured(),
        storage: isStorageConfigured(),
      },
    });
    return;
  }

  // Static file serving — URL-decode so paths with %20 (spaces) etc. resolve.
  let urlPath = req.url === "/" ? "/index.html" : req.url;
  // Drop any query string before disk lookup
  const qIdx = urlPath.indexOf("?");
  if (qIdx >= 0) urlPath = urlPath.slice(0, qIdx);
  try { urlPath = decodeURIComponent(urlPath); } catch { /* leave as-is */ }
  const safePath = normalize(urlPath).replace(/^([.][.][/\\])+/, "");
  const filePath = join(root, safePath);

  if (!filePath.startsWith(root) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  // ── Caching ──
  // On Vercel the CDN handled this. Serving directly, we have to: without
  // it every page load re-downloads app.js (~180 KB) and the logos.
  //
  // Assets that carry no content hash (app.js, styles.css, index.html) get
  // `no-cache`, which means "revalidate every time" — NOT "don't store".
  // Combined with Last-Modified the browser sends If-Modified-Since and we
  // answer 304 with an empty body: the bytes are saved, and a deploy can
  // never serve stale code. Images and fonts are immutable in practice and
  // get a real max-age.
  const stat = statSync(filePath);
  const ext = extname(filePath).toLowerCase();

  // For HTML the response also depends on ASSET_V, which tracks app.js and
  // styles.css. Validating on index.html's own mtime alone would return 304
  // after a JS-only change, leaving the client on cached HTML that still
  // points at the previous asset URL — the exact staleness this is meant to
  // prevent. Advertise the newest mtime of the three instead.
  const mtimeMs = ext === ".html" ? Math.max(stat.mtimeMs, assetMtimeMs) : stat.mtimeMs;
  const lastModified = new Date(mtimeMs).toUTCString();

  const ims = req.headers["if-modified-since"];
  if (ims && Date.parse(ims) >= Math.floor(mtimeMs / 1000) * 1000) {
    res.writeHead(304, { "Last-Modified": lastModified });
    res.end();
    return;
  }

  const immutable = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico", ".woff", ".woff2"];
  const cacheControl = immutable.includes(ext)
    ? "public, max-age=86400"
    : "no-cache";

  // HTML is rewritten in flight to carry the asset version, so its length
  // differs from the file on disk — read it rather than streaming.
  if (ext === ".html") {
    const body = Buffer.from(withAssetVersion(readFileSync(filePath, "utf-8")), "utf-8");
    res.writeHead(200, {
      "Content-Type": types[ext],
      "Content-Length": body.length,
      "Last-Modified": lastModified,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
    return;
  }

  res.writeHead(200, {
    "Content-Type": types[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Last-Modified": lastModified,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  console.log(`Pix Post Builder running at http://localhost:${port}`);
});

// Railway sends SIGTERM on redeploy. Without this the process is killed
// outright and in-flight requests (a 5-minute AI enhance, say) die with it.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`${signal} received — finishing in-flight requests…`);
    server.close(() => process.exit(0));
    // Don't hang forever if a client keeps the socket open.
    setTimeout(() => process.exit(0), 15000).unref();
  });
}

/* ── Web Image Search (multi-source, high quality) ── */

// Strip CDN resize parameters to get original full-resolution images
function upgradeImageUrl(imageUrl) {
  try {
    const u = new URL(imageUrl);

    // Cloudinary: remove transformation path segments
    if (u.hostname.includes("cloudinary.com") || u.hostname.includes("res.cloudinary.com")) {
      u.pathname = u.pathname.replace(/\/c_\w+,[^/]+/g, "").replace(/\/w_\d+[^/]*/g, "").replace(/\/h_\d+[^/]*/g, "");
      return u.toString();
    }

    // imgix: remove resize params, set high quality
    if (u.hostname.includes("imgix.net")) {
      u.searchParams.delete("w"); u.searchParams.delete("h");
      u.searchParams.delete("fit"); u.searchParams.delete("crop");
      u.searchParams.set("q", "100");
      return u.toString();
    }

    // WordPress/Jetpack: strip resize params
    if (u.searchParams.has("resize") || u.searchParams.has("w") || u.searchParams.has("fit")) {
      u.searchParams.delete("resize"); u.searchParams.delete("w"); u.searchParams.delete("h");
      u.searchParams.delete("fit"); u.searchParams.delete("crop");
      return u.toString();
    }

    // Generic: remove common resize params
    for (const key of ["width", "height", "w", "h", "quality", "q", "resize", "size", "maxwidth", "maxheight"]) {
      u.searchParams.delete(key);
    }

    // YouTube: upgrade to maxresdefault
    if (u.hostname.includes("ytimg.com") && u.pathname.includes("hqdefault")) {
      return imageUrl.replace("hqdefault", "maxresdefault");
    }

    return u.toString();
  } catch {
    return imageUrl;
  }
}

// Skip low-quality URLs (favicons, icons, tiny thumbnails)
function isLikelyHighQuality(url) {
  const lower = url.toLowerCase();
  if (lower.includes("favicon")) return false;
  if (lower.includes("/icon")) return false;
  if (lower.match(/\b(16|24|32|48|64|72|96)x\1\b/)) return false;
  if (lower.includes("thumbnail") && !lower.includes("maxresdefault")) return false;
  if (lower.includes("logo") && !lower.includes("article")) return false;
  return true;
}

async function handleGoogleImages(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    const query = requestUrl.searchParams.get("query")?.trim();
    if (!query) {
      sendJson(res, 400, { error: "A search query is required." });
      return;
    }

    let images = [];

    // Source 1: Bing (cloud-friendly)
    images = await tryBingImages(query, 8);

    // Source 2: Google (fallback — works locally, may be blocked on cloud)
    if (!images.length) {
      images = await tryGoogleImages(query, 8);
    }

    // Source 3: DuckDuckGo (last resort)
    if (!images.length) {
      images = await tryDuckDuckGoImages(query, 8);
    }

    sendJson(res, 200, { images, source: images.length ? "web" : "none" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Image search failed." });
  }
}


/* ═══════════════════════ Slide 2 video (yt-dlp + ffmpeg) ═══════════════════════

   Runs in-process rather than as a separate service. The split used to exist
   because Vercel caps serverless request bodies at 4.5 MB, so a 20-200 MB
   video upload could never transit a function — the browser had to POST
   straight to a second host, which needed a shared secret, HMAC tokens and
   CORS. On Railway that cap doesn't exist, so all of that is gone: these are
   ordinary same-origin routes.

   Branding is NOT drawn here. The browser renders the exact overlay it shows
   in the live preview to a transparent PNG and uploads it alongside the clip;
   ffmpeg only composites. That keeps fonts and layout identical to what the
   user approved on screen, and means design changes never touch this file.

   Env:
     YTDLP_COOKIES     base64 Netscape cookies.txt — required for YouTube from
                       a datacenter IP, and for most of Instagram
     MAX_CLIP_SECONDS  output length cap (default 90)
     MAX_UPLOAD_BYTES  local upload cap (default 300 MB)
*/

const MAX_CLIP_SECONDS = Number(process.env.MAX_CLIP_SECONDS || 90);
const MAX_VIDEO_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 300 * 1024 * 1024);
const RESOLVE_TIMEOUT_MS = 60_000;
const CLIP_TIMEOUT_MS = 600_000;

// Railway's variable UI is single-line, so the cookies file is passed base64.
// Written once at startup; yt-dlp reads it from disk.
const COOKIE_FILE = join(tmpdir(), "pix-ytdlp-cookies.txt");
const cookieFilePath = (() => {
  const raw = (env("YTDLP_COOKIES")).trim();
  if (!raw) return "";
  try {
    // Accept either base64 or the file pasted verbatim.
    const looksBase64 = /^[A-Za-z0-9+/=\s]+$/.test(raw) && !raw.includes("\t");
    const data = looksBase64 ? Buffer.from(raw, "base64") : Buffer.from(raw, "utf-8");
    if (data.length < 20) return "";
    writeFileSync(COOKIE_FILE, data);
    return COOKIE_FILE;
  } catch {
    return "";
  }
})();

if (cookieFilePath) {
  console.log("✓ yt-dlp cookies loaded");
} else {
  console.warn("⚠ No YTDLP_COOKIES — YouTube may bot-check this server and Instagram will mostly fail.");
}

// Probe the two binaries once at startup so /health can report a misbuilt
// image directly, instead of every export failing with a confusing ENOENT.
/* yt-dlp needs a JavaScript runtime to solve YouTube's challenge. The Docker
   image puts deno on PATH; locally it is more polite to keep a copy in
   ./.bin than to modify the developer's PATH, so point yt-dlp at it
   explicitly when that copy exists. Without a runtime, the web-based player
   clients fail outright and cookies make extraction worse rather than
   better. */
const LOCAL_DENO = (() => {
  for (const name of ["deno.exe", "deno"]) {
    const p = join(process.cwd(), ".bin", name);
    if (existsSync(p)) return p;
  }
  return "";
})();
if (LOCAL_DENO) console.log("✓ using local deno at .bin");

// Declared BEFORE the availability probe below: that probe runs during
// module evaluation, so a const declared further down is still in its
// temporal dead zone when the probe reads it. The throw happened inside
// an async IIFE, so it surfaced as a late unhandled rejection rather than
// a clean startup error, which made it look unrelated to this line.
let ffmpegAvailable = false;
let ytdlpAvailable = false;
let jsRuntimeAvailable = false;
(async () => {
  const [ff, yt, deno] = await Promise.all([
    run("ffmpeg", ["-version"], 10_000),
    run("yt-dlp", ["--version"], 10_000),
    run(LOCAL_DENO || "deno", ["--version"], 10_000),
  ]);
  ffmpegAvailable = ff.code === 0;
  ytdlpAvailable = yt.code === 0;
  jsRuntimeAvailable = deno.code === 0;

  if (ffmpegAvailable && ytdlpAvailable) {
    console.log(`✓ Video ready (yt-dlp ${yt.stdout.toString().trim()})`);
  } else {
    if (!ffmpegAvailable) console.warn("⚠ ffmpeg not found — video export will fail.");
    if (!ytdlpAvailable) console.warn("⚠ yt-dlp not found — link fetching will fail.");
  }

  // This combination is a trap, so it gets its own warning.
  //
  // Authenticated YouTube requests are served formats whose URLs must be
  // deciphered by running YouTube's JavaScript. Anonymous requests get
  // simpler ones. So without a JS runtime, adding cookies makes extraction
  // FAIL where it previously worked: measured locally, android_vr resolves
  // fine with no cookies and fails with "Requested format is not available"
  // once cookies are supplied. Cookies and deno are a package deal.
  if (!jsRuntimeAvailable) {
    if (cookieFilePath) {
      console.warn(
        "⚠ YTDLP_COOKIES is set but no JS runtime (deno) was found. Authenticated " +
        "YouTube extraction REQUIRES one — every fetch will fail with \"Requested " +
        "format is not available\". Deploy the current Dockerfile, or unset YTDLP_COOKIES."
      );
    } else {
      console.warn("⚠ No JS runtime (deno) — YouTube extraction is limited and cookies will not work.");
    }
  }
})();

/* ── YouTube client fallback ──
   YouTube bot-checks datacenter IPs, which is what any cloud host is. Which
   "player client" yt-dlp impersonates changes how often that happens, and no
   single one is reliable — so rather than failing on the first block, try a
   ladder. Cookies remain the dependable fix, but this clears a good share of
   requests without them.

   The empty first entry is yt-dlp's own default (currently android_vr-led),
   which is fastest when it works. android_vr and tv_embedded are the two
   clients that need no JS challenge, so they still work even if the deno
   runtime is missing from the image. */
const YOUTUBE_CLIENT_LADDER = ["", "android_vr", "tv_embedded", "web_safari", "mweb"];

/* A proxy is the only thing that actually fixes the root cause. YouTube
   blocks by IP reputation, and every cloud host — Railway included — sits in
   a flagged datacenter range. Cookies work around it by proving there's an
   account behind the request; a residential proxy removes the reason for the
   challenge in the first place, with nothing to expire and no account to
   ban. Accepts any yt-dlp proxy URL:
     http://user:pass@host:port   socks5://user:pass@host:port          */
const ytdlpProxy = env("YTDLP_PROXY");
if (ytdlpProxy) {
  // Never log the proxy URL itself — it usually carries credentials.
  let host = "configured";
  try { host = new URL(ytdlpProxy).host.replace(/^.*@/, ""); } catch { /* keep generic */ }
  console.log(`✓ yt-dlp proxy enabled (${host})`);
}


function ytdlpArgs(extra, client = "") {
  const base = ["--no-playlist", "--no-warnings"];
  if (LOCAL_DENO) base.push("--js-runtimes", `deno:${LOCAL_DENO}`);
  if (ytdlpProxy) base.push("--proxy", ytdlpProxy);
  if (cookieFilePath) base.push("--cookies", cookieFilePath);
  if (client) base.push("--extractor-args", `youtube:player_client=${client}`);
  return base.concat(extra);
}

// Only bot-checks and format-availability failures are worth another client;
// a private or deleted video will fail identically every time, and retrying
// just burns a minute.
function worthRetryingWithAnotherClient(stderr) {
  const low = String(stderr || "").toLowerCase();
  return low.includes("sign in to confirm")
      || low.includes("not a bot")
      || low.includes("requested format is not available")
      || low.includes("failed to extract")
      || low.includes("unable to extract")
      || low.includes("http error 403")
      || low.includes("http error 429");
}

/**
 * Run yt-dlp, walking the client ladder while the failure looks like a
 * block rather than a genuinely missing video. Non-YouTube URLs get one
 * attempt — the player_client arg means nothing to other extractors.
 */
async function runYtdlp(extra, timeoutMs) {
  const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(extra.join(" "));
  const ladder = isYouTube ? YOUTUBE_CLIENT_LADDER : [""];
  let last = null;

  for (const client of ladder) {
    const r = await run("yt-dlp", ytdlpArgs(extra, client), timeoutMs);
    if (r.code === 0) {
      if (client) console.log(`✓ yt-dlp succeeded with player_client=${client}`);
      return r;
    }
    last = r;
    if (r.timedOut) break;
    if (!worthRetryingWithAnotherClient(r.stderr || r.stdout)) break;
    if (client !== ladder[ladder.length - 1]) {
      console.warn(`⚠ yt-dlp blocked on client "${client || "default"}" — trying the next one`);
    }
  }
  return last;
}

// Spawn a binary, capture stdout/stderr, enforce a wall-clock timeout.
function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(err.message)) });
      return;
    }
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);

    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.concat(out), stderr: Buffer.from(String(e.message)) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

// yt-dlp's stderr is a wall of text; turn the known failures into something
// the user can actually act on.
function friendlyYtdlpError(stderr) {
  const text = String(stderr || "");
  const low = text.toLowerCase();
  if (low.includes("sign in to confirm") || low.includes("not a bot")) {
    return "YouTube blocked this server as automated — cloud IPs are flagged by default. " +
           "Fix it with YTDLP_COOKIES (cookies from a throwaway logged-in account) or " +
           "YTDLP_PROXY (a residential proxy). Uploading a file works either way.";
  }
  if (low.includes("login required") || low.includes("requested content is not available")) {
    return "This content requires a login. Set YTDLP_COOKIES with cookies from an account that can view it.";
  }
  if (low.includes("private video")) return "That video is private.";
  if (low.includes("video unavailable") || low.includes("removed")) return "That video is unavailable or has been removed.";
  if (low.includes("unsupported url")) return "That link isn't a supported video URL.";
  if (low.includes("rate-limit") || low.includes("429")) return "The source is rate-limiting this server. Try again in a few minutes.";
  if (low.includes("enoent")) return "yt-dlp is not installed on this server.";
  const lines = text.trim().split("\n").filter(Boolean);
  return (lines[lines.length - 1] || "Download failed.").slice(0, 300);
}

async function handleVideoResolve(req, res) {
  try {
    const body = await readJson(req);
    const url = String(body.url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      sendJson(res, 400, { error: "A http(s) URL is required." });
      return;
    }

    const r = await runYtdlp(["--dump-single-json", "--skip-download", url], RESOLVE_TIMEOUT_MS);
    if (r.timedOut) { sendJson(res, 504, { error: "Resolving the video timed out." }); return; }
    if (r.code !== 0) { sendJson(res, 502, { error: friendlyYtdlpError(r.stderr || r.stdout) }); return; }

    let info;
    try {
      info = JSON.parse(r.stdout.toString("utf-8"));
    } catch {
      sendJson(res, 502, { error: "Could not parse video metadata." });
      return;
    }

    sendJson(res, 200, {
      title: info.title || "",
      duration: info.duration || 0,
      thumbnail: info.thumbnail || "",
      uploader: info.uploader || info.channel || "",
      extractor: info.extractor_key || "",
      width: info.width || 0,
      height: info.height || 0,
      webpage_url: info.webpage_url || url,
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Resolve failed." });
  }
}


/* ── Scrubbable preview for linked videos ──
   A browser can't play a YouTube/Instagram *page* URL, so a linked video
   used to show only a poster: you picked trim points blind, against a video
   you couldn't watch. That makes trimming guesswork.

   So the server fetches a small copy and streams it back same-origin. Kept
   deliberately low-res — this exists to be scrubbed, not to be the output;
   the export still downloads full quality separately.

   Direct CDN URLs aren't an option: YouTube's googlevideo links are bound to
   the IP that requested them (ours, not the viewer's) and Instagram's are
   CORS-restricted. Proxying is what makes it play at all. */

// Preview doubles as the export source (see handleVideoClip), so this is a
// real quality knob, not just scrubbing resolution. 720 upscales acceptably
// to the 1080-wide output and downloads far faster than 4K.
const PREVIEW_HEIGHT = Number(process.env.VIDEO_QUALITY || 720);
const PREVIEW_DIR = join(tmpdir(), "pix-preview");
const PREVIEW_TTL_MS = 60 * 60 * 1000;          // 1 hour
const PREVIEW_MAX_BYTES = 120 * 1024 * 1024;
mkdirSync(PREVIEW_DIR, { recursive: true });

// One in-flight download per URL — a <video> element will happily fire
// several overlapping range requests the moment it gets a src.
const previewInFlight = new Map();

function previewPathFor(url) {
  const key = createHash("sha1").update(url).digest("hex").slice(0, 20);
  return join(PREVIEW_DIR, `${key}.mp4`);
}

// Evict old previews so /tmp doesn't grow without bound.
function sweepPreviewCache() {
  try {
    for (const name of readdirSync(PREVIEW_DIR)) {
      const p = join(PREVIEW_DIR, name);
      try {
        if (Date.now() - statSync(p).mtimeMs > PREVIEW_TTL_MS) rmSync(p, { force: true });
      } catch { /* raced with another sweep */ }
    }
  } catch { /* dir vanished */ }
}
setInterval(sweepPreviewCache, 15 * 60 * 1000).unref();

async function ensurePreviewFile(url) {
  const dest = previewPathFor(url);
  if (existsSync(dest) && statSync(dest).size > 1000) return dest;
  if (previewInFlight.has(dest)) return previewInFlight.get(dest);

  const job = (async () => {
    // The temp name MUST end in .mp4. yt-dlp derives the merge container
    // from the output extension, so a ".part" suffix makes a DASH merge
    // write its result elsewhere and the existence check below fails —
    // which looked exactly like a download failure while progressive
    // (single-file) downloads kept working.
    const tmp = dest.replace(/\.mp4$/, ".downloading.mp4");
    const r = await runYtdlp([
      // Order matters: YouTube's progressive (single-file) streams top out at
      // 360p, so asking for "best single file" quietly gets you 360p. Prefer
      // the DASH video+audio pair, which is where 720p actually lives, and
      // fall back to progressive only if the merge isn't possible.
      "-f", `bv*[ext=mp4][height<=${PREVIEW_HEIGHT}]+ba[ext=m4a]/bv*[height<=${PREVIEW_HEIGHT}]+ba/b[ext=mp4][height<=${PREVIEW_HEIGHT}]/b[ext=mp4]/b`,
      "--merge-output-format", "mp4",
      "-o", tmp,
      url,
    ], 180_000);
    if (r.code !== 0 || !existsSync(tmp)) {
      try { rmSync(tmp, { force: true }); } catch {}
      throw new Error(friendlyYtdlpError(r.stderr || r.stdout));
    }
    if (statSync(tmp).size > PREVIEW_MAX_BYTES) {
      rmSync(tmp, { force: true });
      throw new Error("Preview copy is too large.");
    }
    renameSync(tmp, dest);
    return dest;
  })().finally(() => previewInFlight.delete(dest));

  previewInFlight.set(dest, job);
  return job;
}

/**
 * GET /api/video/preview?u=<encoded page url>
 * Streams the cached preview copy, honouring Range so the <video> element
 * can seek. Without range support scrubbing doesn't work at all in Safari.
 */
async function handleVideoPreview(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    const target = (requestUrl.searchParams.get("u") || "").trim();
    if (!/^https?:\/\//i.test(target)) {
      sendJson(res, 400, { error: "A http(s) URL is required." });
      return;
    }

    let file;
    try {
      file = await ensurePreviewFile(target);
    } catch (err) {
      sendJson(res, 502, { error: err.message || "Could not build a preview." });
      return;
    }

    const size = statSync(file).size;
    const range = req.headers.range;

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= size) end = size - 1;
      if (start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    });
    createReadStream(file).pipe(res);
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: error.message || "Preview failed." });
  }
}

// Stream a multipart body to disk. Buffering a 300 MB upload in memory would
// put the whole container at risk, so files go straight to /tmp and only the
// small text fields are kept in memory.
function receiveClipUpload(req, dir) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = {};
    const pending = [];
    let aborted = null;

    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 2, fileSize: MAX_VIDEO_UPLOAD_BYTES } });
    } catch (err) {
      reject(new Error("Malformed upload: " + err.message));
      return;
    }

    bb.on("field", (name, value) => { fields[name] = value; });

    bb.on("file", (name, stream, info) => {
      if (name !== "video" && name !== "overlay") { stream.resume(); return; }
      const dest = join(dir, name === "video" ? "source.bin" : "overlay.png");
      files[name] = { path: dest, name: info.filename || "", bytes: 0 };
      const ws = createWriteStream(dest);
      const done = new Promise((res2, rej2) => {
        stream.on("data", (d) => { files[name].bytes += d.length; });
        stream.on("limit", () => { aborted = `${name} exceeds the ${Math.round(MAX_VIDEO_UPLOAD_BYTES / 1048576)} MB limit`; });
        ws.on("finish", res2);
        ws.on("error", rej2);
      });
      pending.push(done);
      stream.pipe(ws);
    });

    bb.on("error", reject);
    bb.on("close", async () => {
      try {
        await Promise.all(pending);
        if (aborted) { reject(new Error(aborted)); return; }
        resolve({ fields, files });
      } catch (err) { reject(err); }
    });

    req.pipe(bb);
  });
}

async function handleVideoClip(req, res) {
  const job = randomUUID().replace(/-/g, "");
  const dir = join(tmpdir(), `pix-clip-${job}`);
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, "out.mp4");

  try {
    const { fields, files } = await receiveClipUpload(req, dir);

    const start = Number(fields.start || 0);
    const end = Number(fields.end || 0);
    const width = Math.trunc(Number(fields.width || 1080));
    const height = Math.trunc(Number(fields.height || 1920));
    const mute = String(fields.mute || "") === "true";
    // Where the preview framed the crop, normalised 0..1. Defaults to centre
    // so an older client that does not send these still behaves as before.
    const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);
    const focusX = clamp01(Number(fields.focusX));
    const focusY = clamp01(Number(fields.focusY));
    const url = String(fields.url || "").trim();

    const duration = Math.round((end - start) * 1000) / 1000;
    if (!Number.isFinite(duration) || duration <= 0) {
      sendJson(res, 400, { error: "End must be after start." });
      return;
    }
    if (duration > MAX_CLIP_SECONDS) {
      sendJson(res, 400, { error: `Clip is ${duration.toFixed(0)}s; the limit is ${MAX_CLIP_SECONDS}s.` });
      return;
    }
    if (!(width > 0 && height > 0) || width % 2 || height % 2) {
      sendJson(res, 400, { error: "Width and height must be positive even numbers." });
      return;
    }
    if (!url && !files.video) {
      sendJson(res, 400, { error: "Supply either a url or a video file." });
      return;
    }

    // Source: local upload, or fetch with yt-dlp.
    let srcPath;
    if (files.video) {
      if (files.video.bytes < 1000) { sendJson(res, 400, { error: "Empty or invalid video file." }); return; }
      srcPath = files.video.path;
    } else {
      // Scrubbing already pulled this exact video down. Re-downloading it
      // wastes a minute and — because two fetches of the same media in quick
      // succession look like scraping — reliably earns an HTTP 403 from
      // YouTube. Reuse the cached copy when it's there.
      const cached = previewPathFor(url);
      if (existsSync(cached) && statSync(cached).size > 1000) {
        srcPath = cached;
        console.log("✓ clip reusing the cached preview download");
      } else {
        srcPath = join(dir, "source.mp4");
        const dl = await runYtdlp([
          "-f", `bv*[ext=mp4][height<=${PREVIEW_HEIGHT}]+ba[ext=m4a]/b[ext=mp4][height<=${PREVIEW_HEIGHT}]/b[ext=mp4]/b`,
          "--merge-output-format", "mp4",
          "-o", srcPath,
          url,
        ], CLIP_TIMEOUT_MS);
        if (dl.timedOut) { sendJson(res, 504, { error: "Downloading the video timed out." }); return; }
        if (dl.code !== 0 || !existsSync(srcPath)) {
          sendJson(res, 502, { error: friendlyYtdlpError(dl.stderr || dl.stdout) });
          return;
        }
      }
    }

    // Scale-to-cover + centre-crop to the target frame, then composite the
    // overlay. `-ss` before `-i` seeks fast; accuracy still holds because we
    // re-encode. `0:a?` makes audio optional so silent sources don't fail.
    // scale-to-cover leaves one axis overflowing; crop that overflow at the
    // offset the user framed rather than always centring. in_w/in_h are the
    // POST-scale dimensions, so (in_w-out_w) is exactly the slack available,
    // which keeps the expression valid whatever the source resolution.
    const cover =
      `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height}:(in_w-${width})*${focusX.toFixed(4)}:(in_h-${height})*${focusY.toFixed(4)},` +
      `setsar=1`;
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-i", srcPath];
    let filter;
    if (files.overlay && files.overlay.bytes > 0) {
      args.push("-i", files.overlay.path);
      filter = `[0:v]${cover}[bg];[1:v]scale=${width}:${height}[ov];[bg][ov]overlay=0:0[v]`;
    } else {
      filter = `[0:v]${cover}[v]`;
    }
    args.push("-t", String(duration), "-filter_complex", filter, "-map", "[v]");
    if (mute) args.push("-an");
    else args.push("-map", "0:a?", "-c:a", "aac", "-b:a", "128k");
    args.push(
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",      // required for Safari / iOS playback
      "-movflags", "+faststart",  // metadata up front so it streams
      outPath,
    );

    const enc = await run("ffmpeg", args, CLIP_TIMEOUT_MS);
    if (enc.timedOut) { sendJson(res, 504, { error: "Encoding timed out." }); return; }
    if (enc.code !== 0) {
      const tail = enc.stderr.toString("utf-8").slice(-300);
      const msg = /enoent/i.test(tail) ? "ffmpeg is not installed on this server." : `Encoding failed: ${tail}`;
      sendJson(res, 500, { error: msg });
      return;
    }

    const stat = statSync(outPath);
    if (stat.size < 1000) { sendJson(res, 500, { error: "The encoder produced an empty file." }); return; }

    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": stat.size,
      "X-Clip-Duration": String(duration),
      "Content-Disposition": 'attachment; filename="clip.mp4"',
    });
    createReadStream(outPath).pipe(res);
    res.on("close", () => rmSync(dir, { recursive: true, force: true }));
    return;   // cleanup happens on stream close, not in finally
  } catch (error) {
    if (!res.headersSent) {
      const message = error.message || "Clip failed.";
      const status = /exceeds the .* limit/i.test(message)
        ? 413
        : /^(Malformed upload:|Unexpected end of form)/i.test(message)
          ? 400
          : 500;
      sendJson(res, status, { error: message });
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

/* Uploaded media → Supabase Storage → a URL the row can hold.
   
   Signed-in users only: this writes to a bucket with the service_role key,
   and an open upload endpoint backed by that key is a free file host for
   anyone who finds it. */
/* ── Direct-to-Storage upload ───────────────────────────────────────────────

   Two calls around an upload this server never sees the bytes of:

     POST /api/media/sign     -> { uploadUrl, key }
     ...browser PUTs the file straight to Supabase Storage...
     POST /api/media/confirm  -> { url, bytes }

   The split exists so that "stored" is something this server has checked
   rather than something the browser asserts. The old single-shot route
   buffered the whole file in memory here and answered with a URL the moment
   the forward succeeded; when that leg failed after Storage had already
   written the object, the bytes stayed in the bucket with nothing pointing at
   them. Twenty-seven clips in this bucket are that failure.

   The signed URL is scoped to one object path under the caller's own folder,
   so a writer cannot aim an upload at someone else's prefix. */
async function handleMediaSign(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to upload media." });
    return;
  }
  if (!isStorageConfigured()) {
    sendJson(res, 503, { error: "Media storage is not configured on this server." });
    return;
  }

  let body = {};
  try {
    body = await readJson(req, { limit: 10_000 });
  } catch {
    sendJson(res, 400, { error: "Invalid request." });
    return;
  }

  const contentType = String(body.contentType || "application/octet-stream").slice(0, 100);
  const filename = String(body.filename || "").slice(0, 200);

  try {
    // Path is built here, never from anything the browser sent: a filename off
    // a client is attacker-controlled and has no business steering a key.
    const key = `${user.id}/${randomUUID()}${extensionFor(contentType, filename)}`;
    const signed = await createSignedUploadUrl(key);
    sendJson(res, 200, { uploadUrl: signed.uploadUrl, key: signed.key });
  } catch (err) {
    console.warn("⚠ could not sign an upload:", err.message);
    sendJson(res, 502, { error: err.message || "Could not prepare the upload." });
  }
}

async function handleMediaConfirm(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to upload media." });
    return;
  }

  let body = {};
  try {
    body = await readJson(req, { limit: 10_000 });
  } catch {
    sendJson(res, 400, { error: "Invalid request." });
    return;
  }

  const key = String(body.key || "");
  /* Confirm only within the caller's own folder. Without this, a signed-in
     writer could ask the server to vouch for any object in the bucket and
     attach someone else's video to their post. */
  if (!key || !key.startsWith(`${user.id}/`) || key.includes("..")) {
    sendJson(res, 400, { error: "That upload does not belong to this account." });
    return;
  }

  try {
    const stat = await statMedia(key);
    if (!stat.ok) {
      // The reference is refused, so the post cannot record a video that is
      // not there — which is the whole point of this round trip.
      sendJson(res, 404, {
        error: "The upload did not arrive in storage. Nothing was saved — please try again.",
      });
      return;
    }
    if (!stat.bytes) {
      sendJson(res, 422, { error: "The upload arrived empty. Please try again." });
      return;
    }
    console.log(`✓ media confirmed ${Math.round(stat.bytes / 1024)} KB → ${key}`);
    sendJson(res, 200, { url: stat.url, bytes: stat.bytes, contentType: stat.contentType });
  } catch (err) {
    console.warn("⚠ could not confirm an upload:", err.message);
    sendJson(res, 502, { error: err.message || "Could not confirm the upload." });
  }
}

/* Delete one stored object.
 
   Two guards, because this is the only irreversible thing in the media path
   and Storage keeps no undo:
 
     1. Admin only. QA can delete a POST, but a post is a row and the bytes it
        points at may be shared with another; removing media is a different
        act with a different blast radius.
     2. Refused if any post still references the key. An admin reaching for
        this is tidying up, not trying to break a live story, so the server
        checks rather than trusting the caller to have checked. This is the
        guard that makes the endpoint safe to leave in place. */
const MEDIA_KEY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/i;

/* Sweep the bucket for objects no post points at.
 
   The orphan question is a join between storage.objects and pix_posts, and
   both live in the same database — so it is answered here in one query rather
   than by shuttling twelve hundred object names to a client and back.
 
   Matching is on the file's own uuid, not its full path. A stored picture can
   be referenced through the image proxy, where the path arrives percent-encoded
   and the '/' is '%2F'; a path match would miss that and call a live image an
   orphan. The uuid survives any encoding.
 
   Defaults to a dry run. Deleting is the caller's explicit decision, and the
   list it returns is exactly what a confirm=true call will remove. */
async function handleMediaCleanup(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to manage media." });
    return;
  }
  if (!isAdmin(user.role)) {
    sendJson(res, 403, { error: "Only an admin can clean up stored media." });
    return;
  }
  if (!isStorageConfigured()) {
    sendJson(res, 503, { error: "Media storage is not configured on this server." });
    return;
  }

  const params = new URL(req.url, "http://localhost").searchParams;
  const confirm = params.get("confirm") === "true";
  const limit = Math.min(Math.max(Number(params.get("limit") || 500), 1), 2000);

  let rows;
  try {
    ({ rows } = await readQuery(
      `with objs as (
         select o.name, (o.metadata->>'size')::bigint as bytes,
                regexp_replace(split_part(o.name, '/', 2), '\.[a-z0-9]+$', '') as fid
           from storage.objects o
          where o.bucket_id = 'pix-media'
       )
       select name, bytes from objs o
        where o.fid <> ''
          and not exists (
            select 1 from pix_posts p
             where p.design::text like '%' || o.fid || '%'
                or coalesce(p.main_image_url, '')   like '%' || o.fid || '%'
                or coalesce(p.source_image_url, '') like '%' || o.fid || '%'
                or coalesce(p.published_history::text, '') like '%' || o.fid || '%')
        order by o.name
        limit $1`,
      [limit]
    ));
  } catch (err) {
    console.warn("⚠ cleanup scan failed:", err.message);
    sendJson(res, 502, { error: `Could not scan for orphans: ${err.message}` });
    return;
  }

  const bytes = rows.reduce((sum, r) => sum + Number(r.bytes || 0), 0);
  if (!confirm) {
    sendJson(res, 200, {
      dryRun: true, found: rows.length, bytes,
      sample: rows.slice(0, 10).map((r) => r.name),
    });
    return;
  }

  let deleted = 0;
  const failures = [];
  for (const row of rows) {
    try {
      await deleteMedia(row.name);
      deleted += 1;
    } catch (err) {
      failures.push({ name: row.name, error: err.message });
    }
  }
  console.log(`✓ media cleanup by ${user.username}: ${deleted} deleted, ${failures.length} failed`);
  sendJson(res, 200, { dryRun: false, found: rows.length, deleted, bytes, failures: failures.slice(0, 10) });
}

async function handleMediaDelete(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to manage media." });
    return;
  }
  if (!isAdmin(user.role)) {
    sendJson(res, 403, { error: "Only an admin can delete stored media." });
    return;
  }
  if (!isStorageConfigured()) {
    sendJson(res, 503, { error: "Media storage is not configured on this server." });
    return;
  }

  const key = new URL(req.url, "http://localhost").searchParams.get("key") || "";
  // Shape-checked rather than merely escaped: every key this app writes is
  // <uuid>/<uuid>.<ext>, so anything else is not ours to delete.
  if (!MEDIA_KEY_RE.test(key)) {
    sendJson(res, 400, { error: "That is not a valid media key." });
    return;
  }

  try {
    /* Every column a media URL can be reached from, not just design.
 
       design alone is the video-shaped question. An image is also reachable
       through main_image_url and source_image_url, and a published story
       records what it sent in published_history — so checking design only
       would happily delete the picture off the front of a live post. If a new
       column ever carries a URL, it belongs in this list. */
    const { rows } = await readQuery(
      `select id from pix_posts
        where design::text like $1
           or coalesce(main_image_url, '') like $1
           or coalesce(source_image_url, '') like $1
           or coalesce(published_history::text, '') like $1
        limit 1`,
      [`%${key}%`]
    );
    if (rows.length) {
      sendJson(res, 409, {
        error: `Still in use by post ${rows[0].id}. Nothing was deleted.`,
        postId: rows[0].id,
      });
      return;
    }
  } catch (err) {
    // A reference check that could not run is not a licence to delete.
    console.warn("⚠ could not check media references:", err.message);
    sendJson(res, 503, { error: "Could not verify whether this file is in use. Nothing was deleted." });
    return;
  }

  try {
    await deleteMedia(key);
    console.log(`✓ media deleted by ${user.username}: ${key}`);
    sendJson(res, 200, { deleted: true, key });
  } catch (err) {
    console.warn("⚠ media delete failed:", err.message);
    sendJson(res, 502, { error: err.message || "Could not delete that file." });
  }
}

async function handleMediaUpload(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to upload media." });
    return;
  }
  if (!isStorageConfigured()) {
    sendJson(res, 503, { error: "Media storage is not configured on this server." });
    return;
  }

  let payload;
  try {
    payload = await readMediaUpload(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message || "Upload failed." });
    return;
  }

  if (!payload.buffer?.length) {
    sendJson(res, 400, { error: "No file received." });
    return;
  }

  try {
    const key = `${user.id}/${randomUUID()}${extensionFor(payload.contentType, payload.filename)}`;
    const url = await uploadMedia(key, payload.buffer, payload.contentType);
    console.log(`✓ media ${Math.round(payload.buffer.length / 1024)} KB → ${key}`);
    sendJson(res, 200, { url, bytes: payload.buffer.length, contentType: payload.contentType });
  } catch (err) {
    console.warn("⚠ media upload failed:", err.message);
    sendJson(res, 502, { error: err.message || "Could not store that file." });
  }
}

/* Buffered rather than streamed: Storage wants a length, and the cap below is
   well inside what a request body can hold in memory. */
const MAX_MEDIA_BYTES = Number(env("MAX_MEDIA_BYTES") || 0) || 314_572_800;

function readMediaUpload(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_MEDIA_BYTES } });
    } catch (err) {
      reject(new Error("Malformed upload: " + err.message));
      return;
    }

    const chunks = [];
    let contentType = "application/octet-stream";
    let filename = "";
    let tooBig = false;

    bb.on("file", (name, stream, info) => {
      if (name !== "file") { stream.resume(); return; }
      contentType = info.mimeType || contentType;
      filename = info.filename || "";
      stream.on("data", (d) => chunks.push(d));
      stream.on("limit", () => { tooBig = true; });
    });

    bb.on("error", reject);
    bb.on("close", () => {
      if (tooBig) {
        reject(new Error(`File exceeds the ${Math.round(MAX_MEDIA_BYTES / 1048576)} MB limit.`));
        return;
      }
      resolve({ buffer: Buffer.concat(chunks), contentType, filename });
    });

    req.pipe(bb);
  });
}

/* The extension is cosmetic — it only makes the object readable in the
   Supabase dashboard — so a guess from the MIME type is enough, and a name
   from the browser is never trusted for anything but its suffix. */
function extensionFor(contentType, filename) {
  const known = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
    "image/gif": ".gif", "image/avif": ".avif",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
  };
  if (known[contentType]) return known[contentType];
  const match = String(filename || "").match(/(\.[a-z0-9]{1,5})$/i);
  return match ? match[1].toLowerCase() : "";
}

/* Saved pix library — see lib/pix-api.js for the routes and lib/db.js for the
   schema. Storage is optional, so this never propagates an error: a failed
   save answers with a message the editor shows in the status line and then
   carries on. */
async function handlePix(req, res) {
  const parsed = new URL(req.url, "http://localhost");
  const query = Object.fromEntries(parsed.searchParams);
  let body = {};
  if (req.method === "POST" || req.method === "DELETE") {
    try {
      body = await readJson(req, { limit: 2_000_000 });
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Invalid JSON body." });
      return;
    }
  }
  const user = await currentUser(req);
  const result = await handlePixRequest({ method: req.method, path: parsed.pathname, query, body, user });
  sendJson(res, result.status, result.body);
}

/* ── Auth ──
   Pix has its own accounts (see lib/auth.js). Sessions are opaque tokens in an
   HttpOnly cookie; every /api/pix call resolves one before doing anything. */

/* DailyMattr integration.
   The browser sends exported slide PNGs here; this server adds the external
   credentials and forwards the publish request so the API key never reaches
   the client. */
/* Which categories QA may publish into, and in what order.

   DailyMattr offers 12; Shortly uses a subset, and the dropdown reads better
   in editorial priority than in whatever order their API returns. The names
   here are matched case-insensitively against their list and the IDs always
   come from them — we never hard-code an ID, so if they renumber anything
   this keeps working.

   A name we ask for that they do not offer is skipped with a warning rather
   than guessed at: sending an invented category_id would file the story under
   the wrong section, which is worse than not offering it.

   Override with DAILYMATTR_CATEGORIES="Entertainment,Technology,…", or set it
   empty to show everything they offer. */
const DAILYMATTR_CATEGORY_ORDER = (
  env("DAILYMATTR_CATEGORIES") ||
  "Entertainment,Technology,Lifestyle,State,International,National,Finance,Sports"
).split(",").map((s) => s.trim()).filter(Boolean);

let warnedMissingCategories = false;

function applyCategoryPolicy(categories) {
  if (!DAILYMATTR_CATEGORY_ORDER.length) return categories;

  const byName = new Map(categories.map((c) => [String(c.name).trim().toLowerCase(), c]));
  const kept = [];
  const missing = [];
  for (const name of DAILYMATTR_CATEGORY_ORDER) {
    const hit = byName.get(name.toLowerCase());
    if (hit) kept.push(hit);
    else missing.push(name);
  }

  if (missing.length && !warnedMissingCategories) {
    warnedMissingCategories = true;
    console.warn(`⚠ DailyMattr does not offer: ${missing.join(", ")} — not shown to QA. Ask them to add it, or drop it from DAILYMATTR_CATEGORIES.`);
  }
  // Never hand QA an empty dropdown; if nothing matched, their names have
  // changed and showing all of them beats showing none.
  return kept.length ? kept : categories;
}

async function handleDailyMattrMeta(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to use the DailyMattr integration." });
    return;
  }
  /* Readable by writers as well as reviewers. Writers choose the section their
     story belongs in while they build it — they have the context, reviewers would be
     guessing at review time — and to offer that choice they need the list.
     Publishing stays reviewer-only; this is reference data, not an action. */

  try {
    const meta = await fetchDailyMattrMeta(dailyMattrConfig());
    sendJson(res, 200, { ...meta, categories: applyCategoryPolicy(meta.categories) });
  } catch (err) {
    console.warn("⚠ DailyMattr meta failed:", err.message);
    sendJson(res, 502, { error: err.message || "Could not load DailyMattr options." });
  }
}

// 25 MB was fine while page 2 was always a PNG. Slide 2 can be a trimmed MP4,
// which clears that easily, so the default is raised. DailyMattr has not told
// us their own per-file limit yet — if they reject a large clip, lower this
// rather than assuming the encode failed.
const MAX_DAILYMATTR_MEDIA_BYTES = Number(env("MAX_DAILYMATTR_MEDIA_BYTES") || 0) || 64 * 1024 * 1024;

/* Shrink a clip so DailyMattr will take it, without a visible quality drop.

   We publish H.264 at CRF 20 with preset veryfast, which for a 31s 1080x1996
   clip came to 12.58 MB — accepted by their API with success:true and then
   not stored. Their per-file limit is undocumented; 10 MB is the usual one.

   The technique is capped CRF: -crf drives quality as normal while
   -maxrate/-bufsize impose a ceiling the encoder cannot cross. Easy footage
   stays governed by CRF and comes out well under the cap; difficult footage
   hits the cap instead of ballooning. One pass, so no doubling of encode time.

   Measured on that exact 12.58 MB clip, targeting 9 MB:
     7.54 MB, SSIM 0.9935, PSNR 43.84 dB  (>40 dB is the usual
     visually-lossless threshold, and this is a second-generation encode, so
     the real figure from source is better)
   A 90s clip — the longest we allow — came out at 7.67 MB against the same
   ceiling, so the bound holds at the worst case, not just the average.

   Set DAILYMATTR_TARGET_VIDEO_MB=0 to disable. */
// Mirrors the one in lib/pix-api.js; validating here keeps a malformed id
// from ever reaching a query.
const PIX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Stands in for DailyMattr's buzz id when they accept a post but return
   nothing we can read as one. Stored so published_id is non-null, which is the
   flag separating "confirmed live" from "sent, outcome unknown" everywhere
   else — a null there makes a publish we watched succeed look like one that
   may never have happened. */
/* Their answer, bounded. A response we cannot store is worse than a trimmed
   one, and the interesting part — any media list, any error detail — is short
   next to the content echo. Kept as JSON when it fits and as a marked-up
   string when it does not, so a reader always knows which they are looking
   at. */
function truncateForStorage(value, limit = 8000) {
  if (value == null) return null;
  let text;
  try { text = JSON.stringify(value); } catch { return { unserialisable: String(value).slice(0, limit) }; }
  if (text.length <= limit) return value;
  return { truncated: true, bytes: text.length, head: text.slice(0, limit) };
}

const PUBLISH_ID_MISSING = "(accepted, no id returned)";

const DAILYMATTR_TARGET_VIDEO_BYTES =
  Math.round(Number(env("DAILYMATTR_TARGET_VIDEO_MB") || 9) * 1024 * 1024);
const COMPRESS_CRF = String(env("DAILYMATTR_VIDEO_CRF") || 23);
const COMPRESS_TIMEOUT_MS = 600_000;
const COMPRESS_AUDIO_BPS = 128_000;

/* Bring a clip under DailyMattr's cap, or refuse the publish.

   Every failure here used to `return file` — the ORIGINAL, oversized. That is
   the quietest way to lose a video: DailyMattr accepts the post, drops the
   clip it will not store, and answers 200 with a buzz id. Our side records a
   successful publish, QA sees "published", and the story is live on the app
   without its video. Nothing in the response says so, their API is write-only
   so it cannot be checked afterwards, and the post cannot be corrected — only
   republished as a second copy.

   So this now throws instead. The caller runs it in its own try precisely
   because a throw here provably means nothing was sent, which leaves the post
   unpublished, the claim released, and QA holding an actionable message. A
   refused publish costs a retry; a silently clipless one costs the video.

   The output is also VERIFIED against the cap rather than merely compared
   against the input: -maxrate is a rate-control hint, not a guarantee, so
   "smaller than it was" was never the same as "small enough". */
async function compressForDailyMattr(file) {
  if (DAILYMATTR_TARGET_VIDEO_BYTES <= 0) return file;
  if (!/^video\//i.test(file.contentType || "")) return file;
  if (file.buffer.length <= DAILYMATTR_TARGET_VIDEO_BYTES) return file;

  const mb = (n) => (n / 1048576).toFixed(1);
  const capMb = mb(DAILYMATTR_TARGET_VIDEO_BYTES);
  const tooBig = (why) => new Error(
    `the ${mb(file.buffer.length)} MB video could not be brought under DailyMattr's ${capMb} MB limit (${why}). ` +
    `Shorten the trim range on the Video page and publish again.`,
  );

  /* No encoder, no way to shrink it — and no reason to pretend otherwise by
     sending a file we know will be dropped. */
  if (!ffmpegAvailable) {
    throw tooBig("ffmpeg is not installed on this server");
  }

  const job = randomUUID().replace(/-/g, "");
  const dir = join(tmpdir(), `pix-compress-${job}`);
  mkdirSync(dir, { recursive: true });
  const inPath = join(dir, "in.mp4");

  try {
    writeFileSync(inPath, file.buffer);

    const probe = await run("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", inPath,
    ], 30_000);
    const duration = Number(probe.stdout.toString("utf-8").trim());
    if (!Number.isFinite(duration) || duration <= 0) {
      throw tooBig("its duration could not be read");
    }

    /* Two passes at most. The first aims at the cap; if rate control overshoots
       — which it does on high-motion footage — the second aims at whatever
       fraction of the cap the first actually achieved. Beyond that the clip is
       genuinely too long for the budget and the honest answer is to say so
       rather than grind. */
    let best = null;
    let aim = DAILYMATTR_TARGET_VIDEO_BYTES;

    for (let pass = 1; pass <= 2; pass += 1) {
      const outPath = join(dir, `out-${pass}.mp4`);
      // 0.92 leaves headroom for container overhead and rate-control overshoot;
      // without it the result lands slightly OVER the number we promised.
      const budgetBps = (aim * 8 * 0.92) / duration;
      const maxrate = Math.max(200_000, Math.round(budgetBps - COMPRESS_AUDIO_BPS));

      const t0 = Date.now();
      const enc = await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-i", inPath,
        "-c:v", "libx264", "-preset", "slow", "-crf", COMPRESS_CRF,
        "-maxrate", String(maxrate), "-bufsize", String(maxrate * 2),
        "-c:a", "aac", "-b:a", "128k",
        "-pix_fmt", "yuv420p",      // required for Safari / iOS playback
        "-movflags", "+faststart",  // metadata up front so it streams
        outPath,
      ], COMPRESS_TIMEOUT_MS);

      if (enc.code !== 0 || !existsSync(outPath)) {
        throw tooBig(`ffmpeg failed: ${enc.stderr.toString("utf-8").slice(-160) || `exit ${enc.code}`}`);
      }

      const shrunk = readFileSync(outPath);
      if (!shrunk.length) throw tooBig("the encoder produced an empty file");
      if (!best || shrunk.length < best.length) best = shrunk;

      console.log(
        `· compress pass ${pass} ${file.fieldName}: ${mb(file.buffer.length)} MB → ${mb(shrunk.length)} MB ` +
        `(${duration.toFixed(1)}s, crf ${COMPRESS_CRF}, maxrate ${Math.round(maxrate / 1000)}k, ${Date.now() - t0}ms)`,
      );

      if (shrunk.length <= DAILYMATTR_TARGET_VIDEO_BYTES) {
        console.log(`✓ compressed ${file.fieldName} to ${mb(shrunk.length)} MB, under the ${capMb} MB cap`);
        return { ...file, buffer: shrunk };
      }

      // Overshot. Aim the next pass proportionally lower.
      aim = Math.max(
        Math.round(DAILYMATTR_TARGET_VIDEO_BYTES * 0.5),
        Math.round(aim * (DAILYMATTR_TARGET_VIDEO_BYTES / shrunk.length) * 0.9),
      );
    }

    throw tooBig(`the closest encode was still ${mb(best.length)} MB`);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

/* The publish route used to be one big try whose catch answered 502 "Could not
   publish" for everything — the encode, the upload, the logging, the approval
   write and the response send alike. That is what let a failure AFTER
   DailyMattr had accepted the post be reported to QA as a failed publish.

   runDailyMattrPublish() now classifies its own failures and always answers,
   so this wrapper exists only to stop an unforeseen throw becoming an
   unhandled rejection (the http.createServer callback has no catch of its
   own). It reports the outcome as unknown, because by definition it does not
   know where the throw came from. */
async function handleDailyMattrPublish(req, res) {
  try {
    await runDailyMattrPublish(req, res);
  } catch (err) {
    console.error("✗ DailyMattr publish handler crashed:", err);
    if (res.headersSent || res.writableEnded) return;
    sendJson(res, 500, {
      error: "The publish failed in an unexpected way and this server cannot tell whether the post reached DailyMattr. Check their portal before publishing again.",
      indeterminate: true,
    });
  }
}

async function runDailyMattrPublish(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to publish to DailyMattr." });
    return;
  }
  // Publishing is the last editorial gate before content is live on
  // shortlyindia.com, so it belongs to review roles alone. Use the shared
  // capability check so a new review role cannot see the panel and get a 403.
  if (!canReview(user.role)) {
    sendJson(res, 403, { error: "Only QA or admin can publish to DailyMattr." });
    return;
  }

  let payload;
  try {
    payload = await readDailyMattrPublish(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message || "Invalid DailyMattr publish request." });
    return;
  }

  if (!payload.contentEn) {
    sendJson(res, 400, { error: "A caption is required." });
    return;
  }
  if (!payload.categoryId) {
    sendJson(res, 400, { error: "Choose a category before publishing." });
    return;
  }
  if (!payload.files.length) {
    sendJson(res, 400, { error: "At least one media file is required." });
    return;
  }
  if (payload.sourceUrl) {
    try {
      const source = new URL(payload.sourceUrl);
      if (!/^https?:$/.test(source.protocol)) throw new Error("unsupported protocol");
    } catch {
      sendJson(res, 400, { error: "Source URL must be a valid HTTP or HTTPS URL." });
      return;
    }
  }

  /* DailyMattr requires a state whenever the category is "State" — a regional
     story filed against no region is rejected at their end. Checked here so it
     fails before the video encode and the upload rather than after several
     megabytes have gone over the wire, and matched by NAME against their live
     list so it survives them renumbering the category. */
  try {
    const meta = await fetchDailyMattrMeta(dailyMattrConfig());
    const stateCategory = (meta.categories || []).find((c) => /^state$/i.test(String(c.name).trim()));
    if (stateCategory && String(payload.categoryId) === String(stateCategory.id) && !payload.stateId) {
      sendJson(res, 400, { error: "The State category needs a state. Choose one before publishing." });
      return;
    }
  } catch (err) {
    // Their lookup being unreachable must not block a publish that would
    // otherwise succeed — DailyMattr will still enforce its own rule.
    console.warn("⚠ could not check the State rule, continuing:", err.message);
  }
  const mediaValidationError = validateDailyMattrMedia(payload.files);
  if (mediaValidationError) {
    sendJson(res, 400, { error: mediaValidationError });
    return;
  }

  /* ── Claim the publish before anything can be sent ──
     DailyMattr's integration API is write-only: no delete, no lookup, no
     idempotency key. A second POST for the same post is a second live story on
     shortlyindia.com that can only be removed by hand from their portal, and
     until this claim existed nothing anywhere recorded that a row had already
     gone out — so a bookmarked editor tab, a browser refresh, or two QA users
     working the same queue entry all produced one.

     Taken here, before the encode and the upload, for two reasons: the window
     between "decided to publish" and "sent" is minutes long on a compressed
     clip, and a claim taken after the send guards nothing. */
  let claimed = false;
  if (payload.pixId) {
    let claim;
    try {
      /* `republish` lifts the already-published guard, and only that guard —
         the rejection check below still applies, because a republish is a
         correction and not a way around a verdict. It has to arrive as an
         explicit field: the whole value of the claim is that an accidental
         second send (a reload, a stray click, a retry after a timeout) is
         refused, and that only survives if the deliberate case is a different
         request rather than the same one tried twice. */
      claim = await claimPublish(payload.pixId, {
        byId: user.id,
        republish: payload.republish === true,
      });
    } catch (err) {
      /* The database being unreachable must NOT degrade into publishing
         unguarded. Everywhere else in this app storage is optional and a
         failure costs a saved row; here it would cost a duplicate on a public
         site, which is the one loss that cannot be undone. */
      console.warn(`⚠ could not claim the publish for ${payload.pixId}: ${err.message}`);
      sendJson(res, 503, {
        error: "The post library is unreachable, so this publish cannot be checked against earlier ones. Nothing was sent — try again once storage is back.",
        indeterminate: false,
      });
      return;
    }

    if (!claim.claimed) {
      const row = claim.row;
      if (!row) {
        sendJson(res, 404, { error: "That post is no longer in the library. Nothing was sent.", indeterminate: false });
        return;
      }
      if (row.rejected) {
        /* Refused outright rather than offered an override. Publishing a
           rejected post used to be allowed and the auto-approve below then
           erased rejected_by, rejected_at and rejected_by_name — the live
           story kept no trace it had been turned down, and the reviewer lost
           the credit for the decision. Withdrawing the rejection is one click
           in Review ("Undo reject"), it is recorded, and it makes the
           override a deliberate, attributable act instead of a flag on an
           upload nobody sees. */
        const who = row.rejected_by_name || "a reviewer";
        const when = row.rejected_at ? new Date(row.rejected_at).toISOString() : "";
        sendJson(res, 409, {
          error: `This post was rejected by ${who}${when ? ` on ${when}` : ""}. Nothing was sent. Withdraw the rejection in Review ("Undo reject") before publishing.`,
          indeterminate: false,
          rejected: true,
          rejectedByName: row.rejected_by_name || null,
          rejectedAt: row.rejected_at || null,
        });
        return;
      }
      /* The claim's WHERE clause is `published_at is null and rejected =
         false`, so reaching here with neither set means the row changed
         between the UPDATE and this read — another request released a claim,
         or a rejection was withdrawn. Nothing was sent and the next attempt
         will be decided on the settled state, so say exactly that rather than
         guessing at one of the two messages below. */
      if (!row.published_at) {
        sendJson(res, 409, {
          error: "This post's status changed while the publish was being checked. Nothing was sent — reload the post and try again.",
          indeterminate: false,
        });
        return;
      }
      /* published_at set with published_id still null is the unconfirmed case:
         an earlier attempt reached DailyMattr and never heard back, so nobody
         knows whether the story is live. Refusing is the only safe answer —
         the alternative is a blind retry that may well duplicate it. */
      const when = new Date(row.published_at).toISOString();
      sendJson(res, 409, {
        error: row.published_id
          ? `Already published to DailyMattr as ID ${row.published_id} on ${when}. Nothing was sent — publishing again would put a second copy on the live site, and their API has no delete.`
          : `A publish of this post was started on ${when} and never confirmed, so it may already be live. Nothing was sent. Check the DailyMattr portal before doing anything else.`,
        indeterminate: false,
        alreadyPublished: true,
        publishedId: row.published_id || null,
        publishedAt: row.published_at,
        unconfirmed: !row.published_id,
      });
      return;
    }
    claimed = true;
  }
  /* No pixId means QA built the poster without ever saving it, so there is no
     row to claim and this one publish is unguarded. Accepted knowingly rather
     than blocked: the library row is what makes the guard possible, and
     refusing here would break the ad-hoc poster workflow. The exposure is one
     browser session — nothing persists an unsaved poster, so the duplicate
     needs the same tab and a second deliberate click. */

  /* Compression is entirely local — temp files and ffmpeg — so a throw from it
     provably means nothing was sent. Kept in its own try for exactly that
     reason: folded in with the publish call below it would be classified as
     indeterminate and would lock the post out of publishing for no reason. */
  try {
    // Applies to every video part whatever its origin — a freshly rendered
    // clip, the stored copy from our bucket, or a file QA attached by hand.
    payload.files = await Promise.all(payload.files.map(compressForDailyMattr));
  } catch (err) {
    console.warn("⚠ DailyMattr publish failed before sending (media preparation):", err.message);
    if (claimed) await releasePublishClaim(payload.pixId).catch(() => {});
    sendJson(res, 502, {
      error: `The media could not be prepared: ${err.message || "unknown error"}. Nothing was sent.`,
      indeterminate: false,
    });
    return;
  }

  /* Log what actually goes out, per file. "3 files" alone cannot answer the
     only question that matters when something is missing at the other end —
     WHICH file, and was it a video? Without the type and size here there is
     no way to tell "we never attached the clip" from "we sent it and
     DailyMattr dropped it". */
  const manifest = payload.files
    .map((f) => `${f.fieldName}=${f.contentType} ${(f.buffer.length / 1048576).toFixed(2)}MB "${f.filename}"`)
    .join(", ");
  const videoCount = payload.files.filter((f) => /^video\//i.test(f.contentType || "")).length;
  console.log(
    `→ DailyMattr publish by ${user.username}: ${payload.files.length} file(s), ${videoCount} video — ${manifest}`,
  );
  /* The same manifest as data, to be stored beside their answer. The log line
     above is for whoever is watching at the time; this is for whoever asks a
     week later why a story has no video. */
  const sentParts = payload.files.map((f) => ({
    field: f.fieldName,
    type: f.contentType || null,
    bytes: f.buffer.length,
    filename: f.filename || null,
  }));

  /* The irreversible call, alone in its own try so its failure can be
     classified rather than lumped in with everything else in the handler. */
  let result;
  try {
    result = await publishDailyMattrBuzzContent(payload, dailyMattrConfig());
  } catch (err) {
    const neverSent = publishDefinitelyNotSent(err);
    console.warn(
      `⚠ DailyMattr publish failed (${neverSent ? "nothing sent" : "OUTCOME UNKNOWN"}, ` +
      `status=${err?.status ?? "n/a"}) for ${payload.pixId || "unsaved poster"}: ${err.message}`,
    );

    /* Keep the evidence. A refusal is a response, and the indeterminate case —
       sent, no usable answer — is the single hardest state to reconstruct a
       week later, because the row looks untouched and the log has rotated.
       Best-effort: this must never turn a publish failure into a 500. */
    if (payload.pixId) {
      await recordPublishAttempt(payload.pixId, {
        at: new Date().toISOString(),
        by: user.username,
        outcome: neverSent ? "refused-before-storing" : "outcome-unknown",
        status: err?.status ?? null,
        error: String(err?.message || "").slice(0, 2000),
        details: Array.isArray(err?.details) ? err.details.slice(0, 8) : undefined,
        sent: sentParts,
        response: truncateForStorage(err?.rawPayload ?? null),
      }).catch((e) => console.warn("⚠ could not record the failed attempt:", e.message));
    }

    if (neverSent) {
      // Provably nothing was stored at their end, so hand the claim back and
      // let QA fix the problem and publish again.
      if (claimed) await releasePublishClaim(payload.pixId).catch(() => {});
      sendJson(res, 502, {
        error: err.message || "Could not publish to DailyMattr.",
        /* The per-field refusals, listed rather than run together into the
           sentence above. Without these the dialog could only say that the
           post was refused, never which slide or which field caused it, and
           "fix the problem and publish again" is not an instruction anyone
           can follow when the problem was never named. */
        details: Array.isArray(err.details) && err.details.length ? err.details.slice(0, 8) : undefined,
        // The headline without the field lines glued on, so a dialog that
        // lists them as rows does not also print them inside its sentence.
        summary: err.summary || undefined,
        indeterminate: false,
      });
      return;
    }

    /* Unknown: the request left this server and no usable answer came back — a
       reset connection, a gateway 504, a body timeout on a slow media
       endpoint. DailyMattr may have created the story. The claim is
       deliberately KEPT so a retry is refused rather than silently doubling a
       live post, and the response says so instead of the old "Nothing was
       sent — publish again", which is what turned this into duplicates. */
    sendJson(res, 409, {
      error: (err.message || "The connection to DailyMattr failed.")
        + " The post may already be live — this was sent and no confirmation came back."
        + " Check the DailyMattr portal before publishing again.",
      indeterminate: true,
    });
    return;
  }

  // Their response is the only record of what they accepted. Log it whole:
  // a 200 that quietly stored fewer items than we sent is exactly the
  // failure we are chasing, and it is invisible without this.
  // 600 chars cut off before the interesting part — their content_en echo
  // alone eats most of it, and any media list they return comes after.
  console.log(`✓ DailyMattr accepted (id=${result.publishedId ?? "none"}): ${JSON.stringify(result.response).slice(0, 4000)}`);

  /* Turn the claim into a receipt. The claim itself is already committed, so
     the duplicate guard holds whatever happens here — what a failure costs is
     the buzz id, which is the only handle anyone has for pulling the story
     from DailyMattr's portal later. That is worth an error-level log and a
     line in the response rather than the silent warn the approval below gets. */
  let publishRecord = { ok: false, reason: "post not saved" };
  if (payload.pixId) {
    try {
      /* A confirmed publish must never be recorded as an unconfirmed one.
         published_id is what tells those apart, so when DailyMattr answers 200
         without an id we can recognise (it normally returns buzz_id), the
         column takes this marker rather than staying null — otherwise the row
         reads "sent, never confirmed" and every later reader is told the story
         may not be live when we watched them accept it. */
      /* The receipt, written in the same statement as the id.

         `sent` is what left this server, part by part; `response` is their
         verbatim answer. Together they answer the question their write-only
         API cannot be asked afterwards: when a story appears without its
         video, was the clip forwarded and dropped, or never forwarded?

         Their answer is capped rather than trusted whole — the content_en
         echo alone can be large, and this column exists to be readable, not
         to mirror their payload. */
      const receipt = {
        at: new Date().toISOString(),
        by: user.username,
        buzzId: result.publishedId ?? null,
        sent: sentParts,
        videoBytes: sentParts.filter((f) => /^video\//i.test(f.type || ""))
          .reduce((n, f) => n + f.bytes, 0) || null,
        response: truncateForStorage(result.response),
      };
      const row = await recordPublishedId(
        payload.pixId,
        result.publishedId ?? PUBLISH_ID_MISSING,
        receipt,
      );
      publishRecord = row
        ? {
            ok: true,
            publishedId: row.published_id,
            publishedAt: row.published_at,
            // The superseded copies still on the public site, so a republish
            // can name what is left to delete without waiting for a reload.
            publishedHistory: row.published_history || [],
          }
        : { ok: false, reason: "post not found" };
    } catch (err) {
      console.error(
        `✗ PUBLISHED but the DailyMattr id was not recorded on ${payload.pixId} ` +
        `(buzz id ${result.publishedId ?? "none"}): ${err.message}`,
      );
      publishRecord = { ok: false, reason: err.message };
    }
  }

  /* Publishing IS approval — QA would otherwise have to remember a second
     click for a decision they have already made by sending the story live.

     Deliberately in its own guard, outside anything that could be reported as
     a failed publish. The DailyMattr publish has already happened and cannot
     be undone; if an approval write threw and was reported as a publish
     error, QA would assume nothing was sent and publish again — posting the
     story to the live site twice. A failed approval must cost a checkbox,
     never a duplicate.

     Only approves a post that is not already approved, so re-publishing
     does not rewrite the original approver's name or reset approved_at
     (which would skew the approval-time figures on the analytics screen). */
  let approval = null;
  if (payload.pixId) {
    try {
      const current = await getPix(payload.pixId);
      if (!current) {
        approval = { ok: false, reason: "post not found" };
      } else if (current.approved) {
        approval = { ok: true, alreadyApproved: true };
      } else {
        const row = await setApproval(payload.pixId, {
          approved: true,
          byId: user.id,
          byName: user.displayName || user.username,
        });
        approval = row ? { ok: true, approvedAt: row.approved_at } : { ok: false, reason: "post not found" };
        if (row) console.log(`✓ auto-approved ${payload.pixId} on publish by ${user.username}`);
      }
    } catch (err) {
      console.warn(`⚠ published but could not auto-approve ${payload.pixId}: ${err.message}`);
      approval = { ok: false, reason: err.message };
    }
  } else {
    // Unsaved poster: nothing in the library to mark.
    approval = { ok: false, reason: "post not saved" };
  }

  sendJson(res, 200, { ...result, approval, publishRecord });
}

/**
 * Did this failure provably never reach DailyMattr?
 *
 * Only "yes" is safe to act on, because "yes" is what lets the server release
 * the publish claim and tell QA to try again. Everything unrecognised
 * therefore answers no: the cost of a false "yes" is a duplicate live story
 * that cannot be deleted, and the cost of a false "no" is a post that has to
 * be checked by hand in their portal.
 *
 * The markers come from lib/dailymattr.js; see the note there for why the HTTP
 * status could not previously be read at all.
 */
function publishDefinitelyNotSent(err) {
  if (err?.beforeSend) return true;
  if (err?.upstreamRejected) {
    const status = Number(err.status);
    /* A 4xx is DailyMattr having looked at the request and declined it, so
       nothing was stored. The three exceptions are 4xx codes that mean "not
       now" rather than "no" — a 408 or 429 can be raised by an intermediary
       that already forwarded the body, and 425 is explicitly "retry later". */
    return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
  }
  // transportFailed, an upstream 5xx, or something with no marker at all.
  return false;
}

function readDailyMattrPublish(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { files: 5, fileSize: MAX_DAILYMATTR_MEDIA_BYTES, fields: 12 },
      });
    } catch (err) {
      reject(new Error("Malformed upload: " + err.message));
      return;
    }

    const fields = {};
    const files = [];
    let tooBig = false;
    let tooMany = false;
    let invalidMediaField = false;

    bb.on("field", (name, value) => {
      fields[name] = String(value || "").trim();
    });

    bb.on("file", (name, stream, info) => {
      const pageMatch = /^media_page_([1-5])$/i.exec(name);
      if (!pageMatch) {
        if (/^media_page_/i.test(name)) invalidMediaField = true;
        stream.resume();
        return;
      }

      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("limit", () => { tooBig = true; });
      stream.on("end", () => {
        const buffer = Buffer.concat(chunks);
        if (!buffer.length) return;
        files.push({
          fieldName: name,
          page: Number(pageMatch[1]),
          filename: info.filename || `${name}${extensionFor(info.mimeType, info.filename)}`,
          contentType: info.mimeType || "application/octet-stream",
          buffer,
        });
      });
    });

    bb.on("filesLimit", () => { tooMany = true; });
    bb.on("error", reject);
    bb.on("close", () => {
      if (tooBig) {
        reject(new Error(`A DailyMattr media file exceeds the ${Math.round(MAX_DAILYMATTR_MEDIA_BYTES / 1048576)} MB limit.`));
        return;
      }
      if (tooMany) {
        reject(new Error("A maximum of five media files can be published."));
        return;
      }
      if (invalidMediaField) {
        reject(new Error("Media fields must be media_page_1 through media_page_5."));
        return;
      }
      resolve({
        contentEn: fields.content_en || "",
        categoryId: fields.category_id || "",
        keywords: fields.keywords || "",
        stateId: fields.state_id || "",
        sourceUrl: fields.source_url || "",
        // Which library row this poster came from, so publishing can approve
        // it. Empty when QA built the poster without ever saving it.
        pixId: PIX_UUID_RE.test(String(fields.pix_id || "")) ? String(fields.pix_id) : "",
        /* Deliberate second send of a story that is already live. Compared
           against the exact string so a stray "false"/"0" cannot enable it —
           this is the one field that unlocks putting a second copy on a site
           we cannot delete from. */
        republish: fields.republish === "true",
        files: files.sort((a, b) => a.page - b.page),
      });
    });

    req.pipe(bb);
  });
}

function validateDailyMattrMedia(files) {
  if (files.length > 5) return "A maximum of five media files can be published.";

  const pages = files.map((file) => file.page);
  if (new Set(pages).size !== pages.length) return "Each media output can only be supplied once.";

  const kindOf = (file) => {
    const type = String(file.contentType || "").toLowerCase();
    if (/^image\/(jpeg|png|webp)$/.test(type)) return "image";
    if (/^video\/(mp4|quicktime)$/.test(type)) return "video";
    return "unsupported";
  };
  const kinds = files.map(kindOf);
  if (kinds.includes("unsupported")) return "Media must be JPG, PNG, WEBP, MP4 or MOV.";
  return "";
}

/* ═══════════════════════ Writer accounts (QA only) ═══════════════════════

   Accounts could previously only be made by running `npm run users:seed`,
   which creates a fixed roster of six and nothing else — there was no way to
   add a seventh writer without shell access to the server. QA manages the
   team, so QA gets the screen.

   Deliberately narrow: create, reset a password, enable/disable. No delete —
   user_login_id on pix_posts is a bare text column with no foreign key, so
   removing a row would leave every post that writer produced pointing at an
   id that resolves to nobody. Disabling keeps the audit trail. */
async function handleUsers(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to manage accounts." });
    return;
  }
  /* The roster belongs to the admin, not to QA.

     One exception, and it is the difference between a policy and a locked
     door: if no admin account exists yet, QA may still manage accounts. The
     alternative is a system where the only way to make the first admin is a
     shell on the server, and where tightening this rule would have locked the
     existing team out of their own tool the moment it deployed. The exception
     closes by itself the instant an admin exists. */
  if (!isAdmin(user.role)) {
    const adminExists = (await listUsers()).some((u) => u.role === "admin" && u.active);
    if (adminExists || user.role !== "qa") {
      sendJson(res, 403, { error: "Only an admin can manage accounts." });
      return;
    }
    console.warn(`⚠ no admin account yet — allowing ${user.username} (qa) to manage accounts`);
  }
  if (!dbConfigured()) {
    sendJson(res, 503, { error: "The database is not configured." });
    return;
  }

  const parsed = new URL(req.url, `http://localhost:${port}`);
  const path = parsed.pathname.replace(/\/+$/, "");

  try {
    if (req.method === "GET" && path === "/api/users") {
      const rows = await listUsers();
      sendJson(res, 200, {
        users: rows.map((r) => ({
          id: r.id,
          username: r.username,
          role: r.role,
          displayName: r.display_name,
          active: r.active,
          createdAt: r.created_at,
          lastLoginAt: r.last_login_at,
        })),
      });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed." });
      return;
    }

    const body = await readJson(req, { limit: 10_000 });

    if (path === "/api/users") {
      const username = normaliseUsername(body?.username);
      const password = String(body?.password || "");
      const role = String(body?.role || "writer");
      const displayName = String(body?.displayName || "").trim() || null;

      if (!username) { sendJson(res, 400, { error: "A username is required." }); return; }
      if (!ROLES.includes(role)) { sendJson(res, 400, { error: `Role must be one of: ${ROLES.join(", ")}` }); return; }
      if (password.length < 6) { sendJson(res, 400, { error: "Passwords must be at least 6 characters." }); return; }

      try {
        const created = await createUser({ username, password, role, displayName });
        console.log(`✓ ${user.username} created ${role} account "${created.username}"`);
        sendJson(res, 201, {
          user: {
            id: created.id, username: created.username, role: created.role,
            displayName: created.display_name, active: true, createdAt: created.created_at,
          },
        });
      } catch (err) {
        // The unique constraint is the only thing stopping duplicates, and it
        // surfaces as a raw Postgres 23505 — translate it before QA sees it.
        if (err?.code === "23505") sendJson(res, 409, { error: `"${username}" already exists.` });
        else throw err;
      }
      return;
    }

    if (path === "/api/users/password") {
      const username = normaliseUsername(body?.username);
      const password = String(body?.password || "");
      if (password.length < 6) { sendJson(res, 400, { error: "Passwords must be at least 6 characters." }); return; }
      const changed = await setPassword(username, password);
      if (!changed) { sendJson(res, 404, { error: `No account named "${username}".` }); return; }
      console.log(`✓ ${user.username} reset the password for "${username}"`);
      sendJson(res, 200, { ok: true, username });
      return;
    }

    if (path === "/api/users/active") {
      const username = normaliseUsername(body?.username);
      const active = Boolean(body?.active);
      // Locking yourself out mid-session is the one mistake this screen can
      // make irreversible from the UI — there would be no QA left to undo it.
      if (username === normaliseUsername(user.username) && !active) {
        sendJson(res, 400, { error: "You cannot disable your own account." });
        return;
      }
      const row = await setUserActive(username, active);
      if (!row) { sendJson(res, 404, { error: `No account named "${username}".` }); return; }
      console.log(`✓ ${user.username} ${active ? "enabled" : "disabled"} "${username}"`);
      sendJson(res, 200, { user: { username: row.username, role: row.role, active: row.active } });
      return;
    }

    if (path === "/api/users/update") {
      const oldUsername = normaliseUsername(body?.oldUsername);
      const username = normaliseUsername(body?.username);
      const role = String(body?.role || "writer");
      const displayName = String(body?.displayName || "").trim() || null;
      if (!username) { sendJson(res, 400, { error: "A username is required." }); return; }
      try {
        const row = await updateUser(oldUsername, { username, role, displayName });
        if (!row) { sendJson(res, 404, { error: `No account named "${oldUsername}".` }); return; }
        console.log(`✓ ${user.username} updated "${oldUsername}" to "${username}"`);
        sendJson(res, 200, { user: { username: row.username, role: row.role, active: row.active, displayName: row.display_name } });
      } catch (err) {
        if (err?.code === "23505") sendJson(res, 409, { error: `"${username}" already exists.` });
        else throw err;
      }
      return;
    }

    if (path === "/api/users/delete") {
      const username = normaliseUsername(body?.username);
      if (username === normaliseUsername(user.username)) {
        sendJson(res, 400, { error: "You cannot delete your own account." });
        return;
      }
      const deleted = await deleteUser(username);
      if (!deleted) { sendJson(res, 404, { error: `No account named "${username}".` }); return; }
      console.log(`✓ ${user.username} deleted "${username}"`);
      sendJson(res, 200, { ok: true, username });
      return;
    }

    sendJson(res, 404, { error: "Unknown users route." });
  } catch (err) {
    console.warn("⚠ user management failed:", err.message);
    sendJson(res, 500, { error: err.message || "Could not complete that." });
  }
}

async function handlePixAnalytics(req, res) {
  const user = await currentUser(req);
  const query = new URL(req.url, "http://localhost").searchParams;
  const result = await handlePixAnalyticsRequest({ user, query });
  sendJson(res, result.status, result.body);
}

/* Where the resolved session is parked for the rest of the request. A Symbol
   so it cannot collide with anything Node puts on the request object, and so
   nothing that enumerates the request picks it up. */
const REQUEST_USER = Symbol("pixSessionUser");

/* Resolved at most once per request. sessionUser() is a database round trip,
   and since the /api/* gate above resolves the session before dispatching,
   every handler that asks again would otherwise cost a second query — on
   /api/pix that is two per autosave, per open editor. `undefined` means "not
   looked up yet"; null is a real answer meaning nobody is signed in, so the
   check has to be against undefined rather than falsiness. */
async function currentUser(req) {
  if (req[REQUEST_USER] !== undefined) return req[REQUEST_USER];
  let user = null;
  try {
    const cookies = parseCookies(req.headers.cookie);
    user = await sessionUser(cookies[SESSION_COOKIE]);
  } catch (err) {
    // The caller cannot tell this apart from "not signed in", so the user just
    // gets bounced to the login screen. Name it in the log as what it is.
    console.warn(`⚠ session lookup failed (user will appear signed out): ${err.code || "no-code"} ${err.message}`);
    user = null;
  }
  req[REQUEST_USER] = user;
  return user;
}

/* Railway terminates TLS in front of the app, so req.socket is plain HTTP and
   only the forwarded header reveals the real scheme. Getting this wrong drops
   the cookie: Secure on http, or a session cookie sent in the clear. */
function requestIsSecure(req) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (forwarded) return forwarded === "https";
  return Boolean(req.socket?.encrypted);
}

function clientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

async function handleLogin(req, res) {
  if (!dbConfigured()) {
    sendJson(res, 503, { error: "No database configured — logins are unavailable." });
    return;
  }

  let body;
  try {
    body = await readJson(req, { limit: 10_000 });
  } catch {
    sendJson(res, 400, { error: "Invalid request." });
    return;
  }

  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) {
    sendJson(res, 400, { error: "Enter your username and password." });
    return;
  }

  const key = `${clientKey(req)}:${username.toLowerCase()}`;
  const gate = throttleCheck(key);
  if (!gate.allowed) {
    sendJson(res, 429, {
      error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfterSeconds / 60)} minute(s).`,
    });
    return;
  }

  try {
    const session = await login({ username, password, userAgent: req.headers["user-agent"] });
    if (!session) {
      throttleRecordFailure(key);
      // One message for both a bad username and a bad password: naming which
      // was wrong tells an attacker which accounts exist.
      sendJson(res, 401, { error: "Incorrect username or password." });
      return;
    }

    throttleClear(key);
    res.setHeader("Set-Cookie", sessionCookie(session.token, {
      secure: requestIsSecure(req),
      expiresAt: session.expiresAt,
    }));
    sendJson(res, 200, { user: session.user });
  } catch (err) {
    // Log the code too. "Login is unavailable right now" is all the user gets,
    // so without this an intermittent failure leaves nothing to diagnose from.
    console.warn(`⚠ login failed for "${username}": ${err.code || "no-code"} ${err.message}`);
    sendJson(res, 503, { error: "Login is unavailable right now." });
  }
}

async function handleLogout(req, res) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    await logout(cookies[SESSION_COOKIE]);
  } catch { /* clearing the cookie is what matters */ }
  res.setHeader("Set-Cookie", clearedSessionCookie({ secure: requestIsSecure(req) }));
  sendJson(res, 200, { ok: true });
}

async function handleMe(req, res) {
  if (!dbConfigured()) {
    sendJson(res, 503, { error: "No database configured — logins are unavailable." });
    return;
  }
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Not signed in." });
    return;
  }
  sendJson(res, 200, { user });
}

async function handleFluxImage(req, res) {
  try {
    const falKey = env("FAL_KEY", "falKey");
    if (!falKey) {
      sendJson(res, 503, { error: "FAL_KEY is missing." });
      return;
    }

    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    const query = requestUrl.searchParams.get("query")?.trim();
    const context = requestUrl.searchParams.get("context")?.trim() || "";
    if (!query) {
      sendJson(res, 400, { error: "A prompt is required." });
      return;
    }

    const prompt = buildFluxPrompt(query, context);
    const result = await runFalFlux(falKey, prompt);
    const images = (result.images || [])
      .map((image, index) => {
        const url = image.url;
        return {
          id: `flux-${result.seed || Date.now()}-${index}`,
          alt: query,
          preview: url ? `/api/image?url=${encodeURIComponent(url)}` : null,
          image: url,
          imageProxy: url ? `/api/image?url=${encodeURIComponent(url)}` : null,
          source: "flux",
        };
      })
      .filter((image) => image.preview && image.imageProxy);

    if (!images.length) {
      sendJson(res, 502, { error: "Flux returned no images." });
      return;
    }

    sendJson(res, 200, { images, source: "flux" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Flux image generation failed." });
  }
}

async function handleAnalyzeImage(req, res) {
  try {
    const apiKey = env("OPENAI_API_KEY");
    if (!apiKey) {
      sendJson(res, 503, { error: "OPENAI_API_KEY is missing." });
      return;
    }

    const body = await readJson(req, { limit: 8_000_000 });
    const imageData = (body.imageData || "").trim();
    if (!imageData || !imageData.startsWith("data:image/")) {
      sendJson(res, 400, { error: "A base64 image data URL is required." });
      return;
    }

    const analysis = await analyzeImageWithOpenAI(apiKey, imageData);
    sendJson(res, 200, { analysis });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Image analysis failed." });
  }
}

async function analyzeImageWithOpenAI(apiKey, imageData) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "Analyze this product image for a poster background generator.",
              "Use OCR/text recognition carefully. Also identify repeated patterns, product type, packaging shape, colors, materials, logos, labels, icons, and visible brand cues.",
              "Return only compact JSON with these keys:",
              "visibleText: exact text strings you can read,",
              "productType: short product category,",
              "brandCues: short array,",
              "patterns: short array of visual patterns or repeated motifs,",
              "colors: short array,",
              "promptHints: one concise sentence for image generation.",
              "If no text is readable, visibleText must be an empty array. Do not guess unreadable text.",
            ].join(" "),
          },
          { type: "input_image", image_url: imageData, detail: "high" },
        ],
      }],
      max_output_tokens: 500,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error?.message || `OpenAI returned ${response.status}`;
    throw new Error(detail);
  }

  const text = extractOpenAIOutputText(payload).trim();
  try {
    return normalizeImageAnalysis(JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")));
  } catch {
    return normalizeImageAnalysis({ promptHints: text });
  }
}

function extractOpenAIOutputText(payload) {
  if (payload.output_text) return payload.output_text;
  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function normalizeImageAnalysis(value) {
  const arrayOfStrings = (items) => Array.isArray(items)
    ? items.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    visibleText: arrayOfStrings(value.visibleText),
    productType: String(value.productType || "").trim().slice(0, 120),
    brandCues: arrayOfStrings(value.brandCues),
    patterns: arrayOfStrings(value.patterns),
    colors: arrayOfStrings(value.colors),
    promptHints: String(value.promptHints || "").trim().slice(0, 500),
  };
}

function buildFluxPrompt(query, context = "") {
  const parts = [
    "Create a high-quality editorial news background image.",
    `Subject: ${query}.`,
  ];
  if (context) {
    parts.push(`Use these product-image recognition details as visual guidance: ${context}.`);
    parts.push("Respect any readable product text exactly if it appears, and preserve the identified pattern/motif style without inventing fake labels.");
  }
  parts.push(
    "Photorealistic, dramatic but natural lighting, sharp focus, premium newsroom/social poster style.",
    "Do not add unrelated text, captions, fake logos, or watermarks.",
  );
  return parts.join(" ");
}

async function runFalFlux(falKey, prompt) {
  const response = await fetch("https://fal.run/fal-ai/flux/schnell", {
    method: "POST",
    headers: {
      "Authorization": `Key ${falKey}`,
      "Content-Type": "application/json",
      "X-Fal-Store-IO": "0",
    },
    body: JSON.stringify({
      prompt,
      image_size: "portrait_16_9",
      num_images: 1,
      enable_safety_checker: true,
      output_format: "jpeg",
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.detail || payload.error || `fal returned ${response.status}`;
    throw new Error(Array.isArray(detail) ? detail.map((item) => item.msg || item.message || String(item)).join("; ") : detail);
  }
  return payload;
}

async function tryBingImages(query, max) {
  try {
    // filterui:imagesize-wallpaper = extra large images only
    const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&qft=+filterui:imagesize-wallpaper&form=IRFLTR&first=1`;
    const response = await fetch(bingUrl, {
      headers: {
        "user-agent": USER_AGENT,
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9"
      }
    });
    if (!response.ok) return [];
    const html = await response.text();

    const results = [];
    const seen = new Set();
    const matches = html.matchAll(/"murl"\s*:\s*"(https?:[^"]+)"/gi);
    for (const m of matches) {
      if (results.length >= max) break;
      let url = m[1].replace(/\\u002f/gi, "/").replace(/\\u0026/gi, "&");
      if (url.includes("bing.com") || url.includes("bing.net") || url.includes("microsoft.com")) continue;
      if (!isLikelyHighQuality(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      const upgraded = upgradeImageUrl(url);
      results.push({
        id: results.length,
        alt: "Related Image",
        preview: `/api/image?url=${encodeURIComponent(upgraded)}`,
        image: upgraded,
        imageProxy: `/api/image?url=${encodeURIComponent(upgraded)}`,
        source: "bing"
      });
    }

    // If wallpaper size returned nothing, try large
    if (!results.length) {
      const fallbackUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&qft=+filterui:imagesize-large&form=IRFLTR&first=1`;
      const fbRes = await fetch(fallbackUrl, {
        headers: { "user-agent": USER_AGENT, "accept": "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" }
      });
      if (fbRes.ok) {
        const fbHtml = await fbRes.text();
        const fbMatches = fbHtml.matchAll(/"murl"\s*:\s*"(https?:[^"]+)"/gi);
        for (const m of fbMatches) {
          if (results.length >= max) break;
          let url = m[1].replace(/\\u002f/gi, "/").replace(/\\u0026/gi, "&");
          if (url.includes("bing.com") || url.includes("bing.net") || url.includes("microsoft.com")) continue;
          if (!isLikelyHighQuality(url)) continue;
          if (seen.has(url)) continue;
          seen.add(url);
          const upgraded = upgradeImageUrl(url);
          results.push({
            id: results.length,
            alt: "Related Image",
            preview: `/api/image?url=${encodeURIComponent(upgraded)}`,
            image: upgraded,
            imageProxy: `/api/image?url=${encodeURIComponent(upgraded)}`,
            source: "bing"
          });
        }
      }
    }

    return results;
  } catch { return []; }
}

async function tryGoogleImages(query, max) {
  try {
    // tbs=isz:lt,islt:2mp = images larger than 2 megapixels
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch&tbs=isz:lt,islt:2mp`;
    const response = await fetch(googleUrl, {
      headers: {
        "user-agent": USER_AGENT,
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9"
      }
    });
    if (!response.ok) return [];
    const html = await response.text();

    const results = [];
    const seen = new Set();
    const scriptMatches = html.matchAll(/\["(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)",[0-9]+,[0-9]+\]/gi);
    for (const m of scriptMatches) {
      if (results.length >= max) break;
      let url = m[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").replace(/\\\/\//g, "//");
      if (url.includes("gstatic.com") || url.includes("google.com") || url.includes("googleapis.com")) continue;
      if (url.includes("x-raw-image")) continue;
      if (!isLikelyHighQuality(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      const upgraded = upgradeImageUrl(url);
      results.push({
        id: results.length,
        alt: "Google Image",
        preview: `/api/image?url=${encodeURIComponent(upgraded)}`,
        image: upgraded,
        imageProxy: `/api/image?url=${encodeURIComponent(upgraded)}`,
        source: "google"
      });
    }
    return results;
  } catch { return []; }
}

async function tryDuckDuckGoImages(query, max) {
  try {
    const tokenRes = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, {
      headers: { "user-agent": USER_AGENT }
    });
    if (!tokenRes.ok) return [];
    const tokenHtml = await tokenRes.text();
    const vqd = tokenHtml.match(/vqd=([\d-]+)/)?.[1];
    if (!vqd) return [];

    const ddgUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=size:Large&p=1`;
    const ddgRes = await fetch(ddgUrl, {
      headers: { "user-agent": USER_AGENT, "accept": "application/json" }
    });
    if (!ddgRes.ok) return [];
    const data = await ddgRes.json();

    return (data.results || []).filter(r => isLikelyHighQuality(r.image || "")).slice(0, max).map((r, i) => {
      const upgraded = upgradeImageUrl(r.image);
      return {
        id: i,
        alt: r.title || "DuckDuckGo Image",
        preview: `/api/image?url=${encodeURIComponent(r.thumbnail || upgraded)}`,
        image: upgraded,
        imageProxy: `/api/image?url=${encodeURIComponent(upgraded)}`,
        source: "duckduckgo"
      };
    });
  } catch { return []; }
}

async function handleScrape(req, res) {
  try {
    const { url: targetUrl } = parseScrapeRequest(await readJson(req, { limit: 10_000 }));
    const { html, finalUrl } = await fetchPublicHtml(targetUrl, { userAgent: USER_AGENT });
    const candidates = extractItems(html, new URL(finalUrl));
    const items = await enrichItems(candidates);
    sendJson(res, 200, { items });
  } catch (error) {
    sendScrapeError(res, error, "Scrape failed.");
  }
}

async function handleScrapeArticle(req, res) {
  try {
    const { url: targetUrl } = parseScrapeRequest(await readJson(req, { limit: 10_000 }));
    const { html, finalUrl } = await fetchPublicHtml(targetUrl, { userAgent: USER_AGENT });

    // Extract title: og:title > twitter:title > <title> tag
    let title = extractMetaContent(html, ["og:title", "twitter:title"]);
    if (!title) {
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = titleMatch ? cleanupText(stripTags(titleMatch[1])) : "";
    }
    // Strip any leftover HTML tags and clean up
    title = cleanupText(stripTags(title));
    // Clean up common suffixes like " - BBC News", " | Times of India"
    title = title.replace(/\s*[-|–—]\s*[^-|–—]{2,30}$/i, "").trim();

    // Extract image: try secure_url first, then og:image, twitter:image
    let image = extractMetaContent(html, ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]);
    if (image) {
      image = resolveMaybeRelative(image, finalUrl);
      image = upgradeImageToHighestQuality(image);
    }

    if (!title) {
      sendJson(res, 422, { error: "Could not extract a title from this page." });
      return;
    }

    const metaDescription = extractMetaContent(html, ["og:description", "twitter:description", "description"]);
    const articleText = extractArticleText(html, title);

    // Entity-focused image search query via gpt-4o-mini (fail-soft). The old
    // client-side keyword extractor produced garbage like "KARAN JOHARS
    // DHARMA PRODUCTIONS SEALS" → sports photos for a Bollywood story.
    const imageQuery = await buildImageSearchQuery(title, articleText);

    const result = parseScrapeArticleResult({
      title: cleanupText(title),
      image: image || null,
      imageProxy: image ? `/api/image?url=${encodeURIComponent(image)}` : null,
      sourceUrl: finalUrl,
      articleText,
      detailText: limitCharacters(articleText || metaDescription || title, TEXT_DETAIL_CHAR_LIMIT),
      imageQuery,
    });
    sendJson(res, 200, result);
  } catch (error) {
    sendScrapeError(res, error, "Article scrape failed.");
  }
}

function sendScrapeError(res, error, fallback) {
  const status = error instanceof ScrapeValidationError ? error.status : 500;
  sendJson(res, status, { error: error?.message || fallback });
}

/* Ask gpt-4o-mini for a 3-6 word image-search query: the names/entities a
   photo editor would search for. ~$0.0001, fails soft to "". */
async function buildImageSearchQuery(title, articleText = "") {
  if (!openaiApiKey || !title) return "";
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{
          role: "user",
          content:
            "You pick image-search queries for news posters. Given the story below, output ONLY a 3-6 word search query — the specific people, places or things a photo editor would search to find a fitting photo. Prefer full person names. No numbers, currencies, quotes or filler words.\n\n" +
            `Headline: ${title}\n` +
            (articleText ? `Article: ${articleText.slice(0, 500)}` : ""),
        }],
        temperature: 0.2,
        max_tokens: 24,
      }),
    });
    if (!r.ok) return "";
    const data = await r.json();
    const q = (data?.choices?.[0]?.message?.content || "")
      .replace(/["'\n]/g, " ").replace(/\s+/g, " ").trim();
    if (q) console.log(`✓ image query: "${q}"`);
    return q.slice(0, 80);
  } catch {
    return "";
  }
}

async function handleStockImages(req, res) {
  try {
    if (!pexelsApiKey) {
      sendJson(res, 503, { error: "Pexels API key is missing." });
      return;
    }

    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    const query = requestUrl.searchParams.get("query")?.trim();
    if (!query) {
      sendJson(res, 400, { error: "A search query is required." });
      return;
    }

    const pexelsUrl = new URL("https://api.pexels.com/v1/search");
    pexelsUrl.searchParams.set("query", query);
    pexelsUrl.searchParams.set("per_page", "6");
    pexelsUrl.searchParams.set("orientation", "portrait");

    const response = await fetch(pexelsUrl, {
      headers: {
        Authorization: pexelsApiKey,
        "user-agent": USER_AGENT
      }
    });

    if (!response.ok) {
      sendJson(res, 502, { error: `Pexels returned ${response.status}.` });
      return;
    }

    const payload = await response.json();
    const images = (payload.photos || []).map((photo) => ({
      id: photo.id,
      alt: photo.alt || query,
      photographer: photo.photographer || "Pexels",
      pageUrl: photo.url,
      preview: photo.src?.medium || photo.src?.large || photo.src?.original,
      image: photo.src?.large2x || photo.src?.large || photo.src?.original,
      imageProxy: photo.src?.large2x || photo.src?.large || photo.src?.original
        ? `/api/image?url=${encodeURIComponent(photo.src?.large2x || photo.src?.large || photo.src?.original)}`
        : null
    })).filter((item) => item.preview && item.imageProxy);

    sendJson(res, 200, { images });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Image search failed." });
  }
}

async function handleImageProxy(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    const target = requestUrl.searchParams.get("url");
    if (!target) {
      sendJson(res, 400, { error: "Image URL is required." });
      return;
    }

    const { buffer, contentType } = await fetchPublicImage(target, { userAgent: USER_AGENT });
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(buffer);
  } catch (error) {
    const status = error instanceof ScrapeValidationError ? error.status : 500;
    sendJson(res, status, { error: error.message || "Image proxy failed." });
  }
}

function extractItems(html, baseUrl) {
  const matches = [...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const items = [];
  const seen = new Set();

  for (const match of matches) {
    const href = match[1]?.trim();
    const rawInner = match[2] ?? "";
    const title = cleanupText(stripTags(rawInner));
    if (!href || !looksLikeHeadline(title)) {
      continue;
    }

    let absoluteUrl;
    try {
      absoluteUrl = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    if (!looksLikeArticleUrl(absoluteUrl, baseUrl)) {
      continue;
    }

    const normalizedKey = `${normalizeText(title)}|${normalizeUrl(absoluteUrl)}`;
    if (seen.has(normalizedKey)) {
      continue;
    }

    seen.add(normalizedKey);
    items.push({
      title: trimTitle(title),
      url: absoluteUrl,
      image: extractImageUrl(rawInner, baseUrl)
    });

    if (items.length >= 16) {
      break;
    }
  }

  return items;
}

async function enrichItems(items) {
  const enriched = [];

  for (const item of items) {
    const next = { ...item };
    try {
      const { html, finalUrl } = await fetchPublicHtml(item.url, { userAgent: USER_AGENT });
      const metaTitle = extractMetaContent(html, ["og:title", "twitter:title"]);
      const metaImage = extractMetaContent(html, ["og:image", "twitter:image", "twitter:image:src"]);
      if (metaTitle && looksLikeHeadline(metaTitle)) {
        next.title = trimTitle(cleanupText(metaTitle));
      }
      if (metaImage) {
        next.image = resolveMaybeRelative(metaImage, finalUrl);
      }
    } catch {
    }

    next.posterText = next.posterText || buildPosterText(next.title, "", "");
    next.keywords = next.keywords?.length ? next.keywords : extractKeywords(next.title, next.posterText);
    next.imageProxy = next.image ? `/api/image?url=${encodeURIComponent(next.image)}` : null;
    enriched.push(next);
  }

  return enriched.filter((item, index, array) => array.findIndex((candidate) => normalizeUrl(candidate.url) === normalizeUrl(item.url)) === index);
}

function extractMetaContent(html, names) {
  for (const name of names) {
    const propertyRegex = new RegExp(`<meta[^>]+(?:property|name)=["']${escapeForRegex(name)}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
    const contentFirstRegex = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escapeForRegex(name)}["'][^>]*>`, "i");
    const match = html.match(propertyRegex) || html.match(contentFirstRegex);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1]);
    }
  }
  return null;
}

function extractImageUrl(htmlChunk, baseUrl) {
  const src = findAttributeValue(htmlChunk, ["src", "data-src", "data-lazy-src", "data-original"]);
  const srcset = findAttributeValue(htmlChunk, ["srcset", "data-srcset"]);
  const candidate = src || firstSrcFromSet(srcset);
  return candidate ? resolveMaybeRelative(candidate, baseUrl) : null;
}

function findAttributeValue(htmlChunk, names) {
  for (const name of names) {
    const regex = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i");
    const match = htmlChunk.match(regex);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function resolveMaybeRelative(value, baseUrl) {
  try {
    return new URL(value.trim(), baseUrl).toString();
  } catch {
    return null;
  }
}

function firstSrcFromSet(value) {
  if (!value) {
    return null;
  }
  return value.split(",")[0]?.trim().split(/\s+/)[0] || null;
}

function stripTags(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function cleanupText(value) {
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&hellip;/gi, "...");
}

function upgradeImageToHighestQuality(imageUrl) {
  try {
    const u = new URL(imageUrl);
    const host = u.hostname;

    // --- Cloudinary ---
    if (host.includes("cloudinary.com")) {
      // Replace upload transformations with just w_auto,q_auto:best
      u.pathname = u.pathname.replace(/\/upload\/[^/]+\//, "/upload/q_auto:best,f_auto/");
      return u.toString();
    }

    // --- imgix ---
    if (host.includes("imgix.net") || u.searchParams.has("ixid")) {
      u.searchParams.delete("w");
      u.searchParams.delete("h");
      u.searchParams.delete("fit");
      u.searchParams.delete("crop");
      u.searchParams.delete("q");
      u.searchParams.delete("auto");
      u.searchParams.set("q", "100");
      u.searchParams.set("auto", "format,compress");
      return u.toString();
    }

    // --- WordPress / Jetpack resize (e.g. ?resize=800,450 or ?w=800) ---
    if (u.searchParams.has("resize") || (u.searchParams.has("w") && !host.includes("twitter"))) {
      u.searchParams.delete("resize");
      u.searchParams.delete("w");
      u.searchParams.delete("h");
      u.searchParams.delete("fit");
      u.searchParams.delete("strip");
      u.searchParams.delete("quality");
      return u.toString();
    }

    // --- Times of India / HT Media (thumb/ in path) ---
    const toi = u.pathname.match(/^(.*?)\/thumb\/(\d+)x(\d+)(\/.*)?$/);
    if (toi) {
      u.pathname = toi[1] + (toi[4] || "");
      return u.toString();
    }

    // --- BBC / Akamai image service (/ichef/) ---
    if (host.includes("bbci.co.uk") || u.pathname.includes("/ichef/")) {
      u.pathname = u.pathname.replace(/\/\d+\//, "/1280/");
      return u.toString();
    }

    // --- Generic: strip common resize query params ---
    ["width", "height", "w", "h", "size", "quality", "q", "maxwidth", "maxheight", "scale"].forEach(p => {
      u.searchParams.delete(p);
    });

    return u.toString();
  } catch {
    return imageUrl;
  }
}

function looksLikeHeadline(value) {
  if (!value) {
    return false;
  }
  const text = cleanupText(value);
  const words = text.split(/\s+/).filter(Boolean);
  if (text.length < 30 || text.length > 180) {
    return false;
  }
  if (words.length < 5 || words.length > 28) {
    return false;
  }
  if (/^(sign in|home|live|menu|search|open source|bbc news|british broadcasting corporation)$/i.test(text)) {
    return false;
  }
  return /[a-zA-Z]/.test(text);
}

function looksLikeArticleUrl(candidate, baseUrl) {
  const url = new URL(candidate);
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    return false;
  }
  const path = url.pathname.toLowerCase();
  if (url.origin === base.origin && (path === "/" || path === "")) {
    return false;
  }
  if (/\/(signin|account|weather|sport\/scores-and-fixtures|newsround)$/.test(path)) {
    return false;
  }
  return path.split("/").filter(Boolean).length >= 1;
}

function trimTitle(value) {
  return value.length > 110 ? `${value.slice(0, 107).trimEnd()}...` : value;
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

function readJson(req, options = {}) {
  const limit = options.limit || 1_000_000;
  return new Promise((resolve, reject) => {
    // Collect Buffers and decode once at the end. Concatenating chunks as
    // strings decodes each one on its own, so a multi-byte character split
    // across a chunk boundary comes out as replacement characters — which for
    // a password with an accent means a correct one is rejected at random.
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Turn an OpenAI error body into something the user can act on.
 *
 * "OpenAI 401" on its own is useless — it doesn't distinguish a revoked key
 * from a malformed header from a key belonging to the wrong project. OpenAI
 * says which in the response body; surface it.
 */
function openaiErrorMessage(status, body) {
  let detail = "";
  try {
    detail = JSON.parse(body)?.error?.message || "";
  } catch {
    detail = String(body || "").slice(0, 200);
  }
  const low = detail.toLowerCase();

  if (status === 401) {
    if (low.includes("incorrect api key")) {
      return "OpenAI rejected this key as invalid. It was most likely revoked or regenerated — " +
             "create a fresh one at platform.openai.com/api-keys and update OPENAI_API_KEY.";
    }
    if (low.includes("no api key") || low.includes("provide an api key")) {
      return "OpenAI received no key. OPENAI_API_KEY is set but empty or malformed — " +
             "check for quotes or line breaks in the value.";
    }
    return `OpenAI rejected the key (401). ${detail}`.trim();
  }
  if (status === 429) {
    return low.includes("quota")
      ? "OpenAI quota exhausted — add credit at platform.openai.com/settings/organization/billing."
      : "OpenAI is rate-limiting this key. Wait a moment and retry.";
  }
  if (status === 403) {
    return `OpenAI denied access (403). The key may lack permission for this model. ${detail}`.trim();
  }
  if (status >= 500) return "OpenAI is having problems (5xx). Try again shortly.";
  return `OpenAI ${status}. ${detail}`.trim();
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function extractArticleText(html, title = "") {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(?:header|footer|nav|aside|form|button)\b[\s\S]*?<\/(?:header|footer|nav|aside|form|button)>/gi, " ");

  const scopes = extractArticleScopes(stripped);
  const scoredScopes = scopes.map((scope, index) => {
    const paragraphs = extractParagraphCandidates(scope.html, title);
    const score = paragraphs.reduce((sum, item) => sum + item.score, 0) + scope.priority - index;
    return { paragraphs, score };
  });

  scoredScopes.sort((a, b) => b.score - a.score);
  const best = scoredScopes.find((scope) => scope.paragraphs.length >= 2) || scoredScopes[0];
  return (best?.paragraphs || []).slice(0, 10).map((item) => item.text).join(" ");
}

function extractArticleScopes(html) {
  const scopes = [];
  const scopePatterns = [
    { regex: /<article\b[^>]*>([\s\S]*?)<\/article>/gi, priority: 120 },
    { regex: /<main\b[^>]*>([\s\S]*?)<\/main>/gi, priority: 80 },
    { regex: /<(?:section|div)\b[^>]*(?:class|id)=["'][^"']*(?:article|story|content|entry|post|body)[^"']*["'][^>]*>([\s\S]*?)<\/(?:section|div)>/gi, priority: 55 },
  ];

  for (const pattern of scopePatterns) {
    let match;
    while ((match = pattern.regex.exec(html)) !== null) {
      scopes.push({ html: match[1], priority: pattern.priority });
    }
  }

  scopes.push({ html, priority: 0 });
  return scopes;
}

function extractParagraphCandidates(scope, title) {
  const seen = new Set();
  const candidates = [];
  for (const match of scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = cleanupText(stripTags(match[1] || ""));
    const key = normalizeText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const score = scoreArticleParagraph(text, title);
    if (score > 0) candidates.push({ text, score });
  }
  return candidates;
}

function scoreArticleParagraph(text, title = "") {
  const normalized = normalizeText(text);
  const words = normalized.split(/\s+/).filter(Boolean);
  if (text.length < 45 || text.length > 1200 || words.length < 8) return 0;
  if (title && normalizeText(title) === normalized) return 0;
  if (isBoilerplateParagraph(normalized)) return 0;

  const sentenceCount = (text.match(/[.!?](?:\s|$)/g) || []).length;
  const hasNewsTerms = /\b(said|according|reported|minister|police|court|government|company|team|match|official|source|agency|statement)\b/i.test(text);

  // Relevance: paragraphs that mention the story's own proper nouns (from
  // the title) far outrank generic page copy like author bios. "Ranbir
  // Kapoor" appearing in a paragraph is a much stronger signal than length.
  let overlapBonus = 0;
  if (title) {
    const titleNouns = (title.match(/\b[A-Z][a-zA-Z''-]{3,}\b/g) || [])
      .map((w) => w.toLowerCase())
      .filter((w, i, a) => a.indexOf(w) === i);
    const hits = titleNouns.filter((n) => normalized.includes(n)).length;
    overlapBonus = Math.min(hits, 3) * 140;
  }

  return Math.min(text.length, 320) + sentenceCount * 35 + (hasNewsTerms ? 80 : 0) + overlapBonus;
}

function isBoilerplateParagraph(normalized) {
  return /\b(privacy policy|cookie policy|cookies|terms of use|sign in|sign up|subscribe|subscription|advertisement|sponsored|newsletter|all rights reserved|copyright|follow us|read more|related stories|enable javascript|disable ad blocker|allow notifications|manage settings|accept all|our privacy policy has been revised|please review updated privacy policy|news desk|entertainment desk|sports desk|is a dynamic and dedicated team|team of journalists|bring the pulse|about the author|written by|contributed to this report|catch all the|stay updated with|download the app|for more (?:updates|news)|end of article)\b/i.test(normalized);
}

function limitWords(value, maxWords) {
  const words = cleanupText(value || "").split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}

function limitCharacters(value, maxChars) {
  const text = cleanupText(value || "");
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars + 1);
  const boundary = clipped.lastIndexOf(" ");
  return clipped.slice(0, boundary > Math.floor(maxChars * 0.84) ? boundary : maxChars).trim();
}

function buildPosterText(title, metaDescription, articleText) {
  const source = cleanupText(metaDescription || articleText || title);
  const sentences = source.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  let summary = "";
  for (const sentence of sentences) {
    const candidate = `${summary} ${sentence}`.trim();
    if (candidate.length > 120) {
      break;
    }
    summary = candidate;
    if (summary.length >= 72) {
      break;
    }
  }
  const output = summary || source;
  return output.length > 120 ? `${output.slice(0, 117).trimEnd()}...` : output;
}

function extractKeywords(title, posterText) {
  const found = [];
  const phraseMatches = cleanupText(title).match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}|[A-Z]{2,})\b/g) || [];
  for (const match of phraseMatches) {
    const upper = match.toUpperCase();
    if (!STOPWORDS.has(upper) && !found.includes(upper)) {
      found.push(upper);
    }
    if (found.length >= 3) {
      return found;
    }
  }

  const frequency = new Map();
  for (const word of cleanupText(`${title} ${posterText}`).toUpperCase().match(/[A-Z]{3,}/g) || []) {
    if (STOPWORDS.has(word) || word.length < 4) {
      continue;
    }
    frequency.set(word, (frequency.get(word) || 0) + 1);
  }

  for (const word of [...frequency.entries()].sort((a, b) => b[1] - a[1]).map(([word]) => word)) {
    if (!found.includes(word)) {
      found.push(word);
    }
    if (found.length >= 4) {
      break;
    }
  }

  return found.slice(0, 4);
}

/* ── Twitter / X — Post poster image with caption ── */
async function handleTwitterPost(req, res) {
  /* Publishing to the org's X account is an irreversible external write with
     the same standing as a DailyMattr publish, so it takes the same review
     role rather than merely a session — a writer must not be able to put a
     poster in front of the audience without QA. Checked through canReview()
     (as handleDailyMattrPublish does) so a future review role inherits it
     instead of hitting a 403. Dormant today because TWITTER_* is unset and the
     503 below fires first; the gate goes in before those keys ever appear. */
  const user = await currentUser(req);
  if (!canReview(user?.role)) {
    sendJson(res, 403, { error: "Only QA or admin can post to X." });
    return;
  }
  if (!twitterClient) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Twitter not configured. Set TWITTER_* keys in .env." }));
    return;
  }

  try {
    const caption = decodeURIComponent(req.headers["x-caption"] || "").trim();
    if (!caption) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Caption header." }));
      return;
    }
    if (caption.length > 280) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Caption is ${caption.length} chars; max is 280.` }));
      return;
    }

    // Read raw PNG body into a buffer (10 MB safety cap)
    const MAX_BYTES = 10 * 1024 * 1024;
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BYTES) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Image exceeds 10 MB." }));
        return;
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length < 100) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Empty or invalid image body." }));
      return;
    }

    console.log(`→ Twitter post: ${buffer.length} bytes, caption "${caption.slice(0, 40)}…"`);

    // 1) Upload media (v1.1 endpoint, OAuth 1.0a)
    const mediaId = await twitterClient.v1.uploadMedia(buffer, { mimeType: "image/png" });

    // 2) Create tweet (v2) referencing the media
    const tweet = await twitterClient.v2.tweet({
      text: caption,
      media: { media_ids: [mediaId] },
    });

    const tweetId = tweet?.data?.id;
    const tweetUrl = tweetId ? `https://x.com/i/status/${tweetId}` : null;
    console.log(`✓ Tweet posted: ${tweetUrl}`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, tweetUrl, id: tweetId }));
  } catch (err) {
    const code = err?.code || err?.data?.status || err?.status || 500;
    const msg  = err?.data?.detail || err?.data?.errors?.[0]?.message || err?.message || "Twitter post failed.";
    console.error("✗ Twitter post error:", code, msg);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg, code }));
  }
}

/* ── OpenAI — generate AI tweet caption + hashtags from a headline ── */
async function handleGenerateCaption(req, res) {
  if (!openaiApiKey) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "OPENAI_API_KEY not set on server." }));
    return;
  }

  try {
    // Read JSON body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf-8");
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { /* ignore */ }

    const headline = (body.headline || "").trim();
    if (!headline) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'headline' in body." }));
      return;
    }

    const systemPrompt = [
      "You are a senior social-media editor at a news outlet. You write tweets that accompany a news image poster — the image already shows the headline, so the tweet adds VALUE on top.",
      "",
      "Goal: make people stop scrolling and engage.",
      "",
      "RULES (follow strictly):",
      "1. NEVER repeat the headline verbatim. Rewrite it as a hook: a sharp angle, a question, a striking fact, or a one-line takeaway.",
      "2. Write 1–2 short sentences. Punchy. Active voice. No filler words ('In a major development', 'It is reported that', etc.).",
      "3. Add 2–4 hashtags at the end, each highly relevant — mix one broad (e.g. #IndianPolitics) with one specific (e.g. #TamilNadu, #DMK). No #BreakingNews unless it actually is. Hashtags must be CamelCase, no spaces, no special chars.",
      "4. Total length ≤ 270 characters INCLUDING hashtags. Count carefully.",
      "5. Tone: neutral and professional for politics/conflict/tragedy. Conversational and curious for tech/business/culture. Light-hearted (still classy) for entertainment/sports.",
      "6. No emojis. No clickbait phrasing ('You won't believe…'). No moralizing. No editorializing on contested issues — stay factual.",
      "7. Output ONLY the final tweet text. No quotes, no labels, no preamble, no explanation.",
      "",
      "EXAMPLES of the style we want:",
      "",
      "Headline: \"Modi tables Finance Bill 2026 in Parliament amid opposition uproar\"",
      "Tweet: Finance Bill 2026 hits the floor — and the opposition isn't letting it pass quietly. Key clauses on capital gains and digital tax are already drawing fire. #FinanceBill2026 #Parliament #IndianPolitics",
      "",
      "Headline: \"Apple unveils Vision Pro 2 with 50% lighter design at WWDC\"",
      "Tweet: Apple's second swing at spatial computing is half the weight — and apparently twice the battery life. The price tag? Still TBD. #VisionPro2 #WWDC #Apple",
      "",
      "Headline: \"India crowned T20 World Cup champions after 11-year drought\"",
      "Tweet: 11 years. One trophy back home. India's T20 wait is over. #T20WorldCup #TeamIndia #Cricket"
    ].join("\n");

    const t0 = Date.now();
    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Headline:\n${headline}` },
        ],
        temperature: 0.8,
        max_tokens: 140,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      console.error(`✗ OpenAI ${aiRes.status}:`, errText.slice(0, 300));
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: openaiErrorMessage(aiRes.status, errText) }));
      return;
    }

    const data = await aiRes.json();
    let caption = data?.choices?.[0]?.message?.content?.trim() || "";

    // Strip surrounding quotes if model added any
    caption = caption.replace(/^["“”']+|["“”']+$/g, "").trim();

    // Hard-trim to 280 just in case
    if (caption.length > 280) caption = caption.slice(0, 277) + "…";

    const ms = Date.now() - t0;
    console.log(`✓ AI caption (${ms}ms, ${caption.length} chars): "${caption.slice(0, 60)}…"`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ caption }));
  } catch (err) {
    console.error("✗ generate-caption error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Caption generation failed." }));
  }
}

/* ── OpenAI — full article package (headline + 3 bullets + tweet) ──
   Local-dev mirror of api/generate-article.js. Editorial rules live in the
   shared prompt below; keep both copies in sync when editing. */
/* == Editorial spec ==
   One place for the numbers that the prompt, the validator, the repair
   pass and the deterministic clamp all have to agree on. They used to be
   scattered literals, which is how a spec change silently half-lands. */
const BULLET_COUNT = 4;
const BULLET_MIN_CHARS = 115;
const BULLET_MAX_CHARS = 125;
// Slack the validator tolerates before paying for a repair round-trip.
// The floor sits close to the target because the model systematically
// UNDERSHOOTS: measured output landed at 90-111 against a 115-125 spec, and
// a floor of 100 let most of that through untouched.
const BULLET_SOFT_MIN = 110;
const BULLET_SOFT_MAX = 132;
// Character counts are something an LLM cannot actually measure, so the
// prompt also states a word target, which models track far more reliably.
// English news prose averages ~6.2 characters per word including the space.
const BULLET_MIN_WORDS = Math.round(BULLET_MIN_CHARS / 6.2);
const BULLET_MAX_WORDS = Math.round(BULLET_MAX_CHARS / 6.0);
const HEADLINE_MAX_CHARS = 90;

// The base prompt is register-agnostic; buildEditorialPrompt() appends the
// register-specific rules chosen per story.
const EDITORIAL_SYSTEM_PROMPT = [
  "You are a journalist and content writer for Shortly (@SHORTLY__NEWS), a Twitter/X-style news app. Given a source headline and, when available, the article text, produce a news package in STRICT JSON with this exact shape:",
  "",
  '{ \"headline\": string, \"bullets\": [string, string, string, string], \"tweet\": string, \"register\": string, \"flags\": [string] }',
  "",
  "CARD 1 — the \"headline\" field:",
  "- Witty, informative and curiosity-driven. Engaging and click-worthy.",
  "- Be SPECIFIC. Never vague or generic. Name the tournament, the year, the city, the amount, the person.",
  "- Strike the balance between intrigue and clarity: the reader should know what this is about AND want to swipe.",
  "- Mention the subject EARLY. The brand, person, institution or place appears near the beginning.",
  "- Use numbers only when they are central to the story (for example $2.4 billion, 20%, 1:778). Do not decorate with numbers that do not carry the story.",
  "- MATCH THE TONE TO THE STORY:",
  "  * HARD NEWS (courts, money, deaths, policy, disasters, crime, conflict): straightforward and informative. No wordplay, no wink, no playfulness.",
  "  * INFOTAINMENT or FEATURE: witty, playful, conversational. The kind of line that makes someone stop scrolling.",
  "- Avoid vague filler such as 'boosts sentiment', 'makes waves', 'set to change everything'.",
  `- Maximum ${HEADLINE_MAX_CHARS} characters, so it fits on the poster.`,
  "- Correct sentence capitalisation. No periods between initials (write MS Dhoni, PM, US, UK, never M.S. Dhoni).",
  "- Never reuse the headline's exact phrasing in the bullets.",
  "",
  `CARD 2 — the \"bullets\" field: EXACTLY ${BULLET_COUNT} bullet points.`,
  `- LENGTH: each bullet must be ${BULLET_MIN_WORDS} to ${BULLET_MAX_WORDS} words (${BULLET_MIN_CHARS}-${BULLET_MAX_CHARS} characters). Count the WORDS. A bullet of ${BULLET_MIN_WORDS - 4} words is too short and must be developed with more of the source detail, not padded with filler.`,
  "- INVERTED PYRAMID: bullet 1 carries the single most important fact. Each following bullet adds the next most important detail. Background and context come LAST, never first.",
  "- EVERY BULLET MUST CARRY A FACT THE OTHERS DO NOT — a different figure, name, date, place, cause, consequence or reaction. Four bullets restating one fact in different words is a failure even if each sentence is well written.",
  "- Prefer concrete detail from the source over summary: the amount, the deadline, the vote, the sample size, the institution, the date. If the source gives a number, a bullet should carry it.",
  "- Do NOT end every bullet with an attribution tag. Attribute where a claim genuinely needs a source, usually one or two bullets; state the rest as fact. Four 'researchers said' endings read as a template, not as reporting.",
  "- At most ONE hedge per sentence. 'Studies indicate that X may improve Y' hedges twice and commits to nothing. Write what was actually found.",
  "- Never pad to reach the length. If the source does not support four distinct bullets, write the most specific ones you can from what is there rather than repeating yourself.",
  "- PLAIN IS NOT SIMPLISTIC. Short sentences and precise, ordinary words — the register of a wire-service report, not of a childrens book. Never pad, never talk down, never explain the obvious.",
  "- Use the correct term rather than a vague substitute. If a term genuinely needs unpacking, gloss it in a short clause instead of replacing it.",
  "- Each bullet is ONE complete sentence ending in a full stop. Never cut off midway, never trailing off.",
  "- Attribute anything contested, forward-looking or opinionated to a named person, body or document, using the verb 'said'. Never 'claimed', 'admitted', 'conceded' or 'slammed' — those read as judgemental.",
  "- Active voice with strong verbs. Exact figures, dates and titles wherever the source has them; never 'a lot of', 'several' or 'recently' in their place.",
  "- No judgement adjectives (shocking, stunning, massive, historic). No exclamation marks. Third person throughout — never address the reader as 'you'.",
  "- No em dashes; let sentences flow naturally. No periods between initials (MS Dhoni not M.S. Dhoni).",
  "- Only use a direct quote when quoting verbatim, immediately followed by the person's name; otherwise rephrase in third person.",
  "- Strictly sourced from the provided material. No extrapolation, no outside knowledge.",
  "- Neutral, professional, British English.",
  "",
  "TWEET — the \"tweet\" field. Build it in three parts separated by newlines:",
  "- Part 1: one or two short sentences, maximum 200 characters including the call to action. Professional but Gen Z-friendly tone. Neutral, no political lean, no editorialising. No em dashes.",
  "- Part 2 (new line), exactly: Follow @SHORTLY__NEWS for more 👇",
  "- Part 3 (new line): relevant @handles and #hashtags, ALL in lowercase (for example @bcci @icc #indvsaus #t20worldcup). 3 to 6 tags, most specific first, no generic filler like #news or #trending.",
  "",
  "PEOPLE IDENTIFICATION:",
  "- On first mention of a person, add a brief identifier: their role, title or what they are known for (for example 'Sunil Mittal, chairman of Bharti Enterprises', not just 'Sunil Mittal'). Never assume the audience knows the name.",
  "",
  "EDITORIAL RULES:",
  "- Use ONLY the provided material. Never fabricate statistics, records or quotes, and never add outside knowledge.",
  "- If a headline claim is not supported by the article text, if the story is communal, religious, politically sensitive or otherwise unverified, or if it reads as older than yesterday, add a short note to flags. flags is an empty array when there is nothing to raise.",
  "- Both sides represented on political or contested stories. No one-sided framing.",
  "- Do not present promotional or sponsored content as news.",
  "- Safe reporting for deaths, suicide and tragedy: no method details, no sensationalising, neutral tone.",
  "",
  "EXAMPLE headline — hard news (straightforward, subject first, the number carries the story):",
  '- "RBI holds the repo rate at 6.5% for an eighth straight meeting"',
  "EXAMPLE headline — feature (playful, still specific):",
  '- "Amitabh Bachchan bought an Ayodhya plot in a single day"',
  "",
  `EXAMPLE bullets (${BULLET_COUNT}, inverted pyramid, each a complete sentence of ${BULLET_MIN_CHARS}-${BULLET_MAX_CHARS} characters):`,
  '- "The Reserve Bank of India has kept its key interest rate at 6.5% for the eighth meeting in a row, holding steady again."',
  '- "Governor Shaktikanta Das said food prices remain unpredictable, so the bank is not ready to start cutting rates yet."',
  '- "Home and car loan borrowers will see no change to their monthly payments, with EMIs staying exactly where they are."',
  '- "The bank has now held rates steady for well over a year, after raising them sharply through 2022 to bring inflation down."',
  "",
  "Output ONLY the JSON object. No prose around it.",
].join("\n");

/**
 * Compose the system prompt for one story: the shared editorial spec plus the
 * register-specific rules for THIS story's type. A single fixed tone
 * instruction is what produced summaries that read as written for a child —
 * a court ruling and a film premiere need different registers, not the same
 * flattened one.
 */
function buildEditorialPrompt(register) {
  return EDITORIAL_SYSTEM_PROMPT +
    "\n\n" + registerRules(register) +
    "\n\nSet the \"register\" field in your JSON to the register you actually wrote in: " +
    "\"wire\" for hard news, \"feature\" for infotainment, \"explainer\" for technical stories. " +
    "Override the suggested register if the story is plainly a different type.";
}


// Spec: every @handle/#hashtag after the CTA line is lowercase. The model
// occasionally keeps official casing (@RBI) — enforce deterministically.
function lowercaseTagLines(tweet) {
  const lines = String(tweet).split("\n");
  const ctaIdx = lines.findIndex((l) => /follow\s+@shortly__news/i.test(l));
  if (ctaIdx >= 0) {
    for (let i = ctaIdx + 1; i < lines.length; i++) lines[i] = lines[i].toLowerCase();
  }
  return lines.join("\n");
}

// Keep the tweet ≤280 chars, trimming at whitespace so a trailing hashtag
// is never cut mid-word.
function clampTweet(s) {
  s = lowercaseTagLines(String(s).replace(/[ \t]+\n/g, "\n").trim());
  if (s.length <= 280) return s;
  let cut = s.slice(0, 280);
  const boundary = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  if (boundary > 240) cut = cut.slice(0, boundary);
  return cut.trim();
}

// A bullet is "good" when it is a complete sentence inside the target band.
// The soft bounds are wider than the spec so a bullet that is only a few
// characters out is left alone rather than paying for a repair round-trip.
function bulletIsValid(b) {
  const t = String(b).trim();
  if (t.length < BULLET_SOFT_MIN || t.length > BULLET_SOFT_MAX) return false;
  if (!/[.!?]["')\]]?$/.test(t)) return false;
  const core = t.replace(/[.!?"')\]]+$/, "").trim();
  return !TRAILING_STOPWORDS.test(core);
}

const REGISTER_KEYS = ["wire", "feature", "explainer"];

/**
 * Rectification pass. Rewrites bullets that failed either the length check or
 * the tone check, told exactly which faults to fix and which register to
 * write in.
 *
 * Naming the specific faults matters: "make it more professional" is the kind
 * of instruction that makes a model rewrite everything and drift off the
 * facts. A list of concrete defects keeps the edit surgical.
 */
async function rectifyBullets({ headline, articleText, bullets, register, issues }) {
  const instruction = rectifyInstruction({
    issues,
    register,
    min: BULLET_MIN_CHARS,
    max: BULLET_MAX_CHARS,
    count: BULLET_COUNT,
    minWords: BULLET_MIN_WORDS,
    maxWords: BULLET_MAX_WORDS,
  });
  const prompt =
    instruction + "\n\n" +
    (headline ? `Headline: ${headline}\n` : "") +
    (articleText ? `Source article: ${articleText.slice(0, 900)}\n` : "") +
    "Bullets to rewrite:\n" + bullets.map((b, i) => `${i + 1}. ${b}`).join("\n");

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openaiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
        // Low temperature: this is a correction, not a fresh draft.
        temperature: 0.25,
        max_tokens: 800,
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}");
    const b = Array.isArray(parsed.bullets)
      ? parsed.bullets.slice(0, BULLET_COUNT).map((x) => String(x).replace(/\s+/g, " ").trim())
      : null;
    return b && b.length === BULLET_COUNT && b.every(Boolean) ? b : null;
  } catch {
    return null;
  }
}

const TRAILING_STOPWORDS = /\s+(and|or|but|to|of|in|on|at|for|with|the|a|an|its|his|her|their|our|your|this|that|these|those|as|by|from|into|onto|over|under|about|after|before|while|amid|is|are|was|were|has|have|had|will|would|which|who|when|where|during|through|throughout|across|among|amongst|between|against|within|without|since|until|till|unless|though|although|because|per|via|upon|toward|towards|despite|beyond|near|off|out|up|down|than|then|so|yet|nor|if|nearly|almost|only|just|also|both|either|neither|whether|following|include|including)$/i;

// Last-resort deterministic trim, used only when the model and the repair
// pass both leave a bullet too long. It never cuts mid-sentence or mid-word:
// prefer the longest run of whole sentences that fits, else trim at a word
// boundary, strip any dangling conjunction, and close with a full stop so
// the result never reads as chopped.
function clampBullet(s) {
  s = String(s).replace(/\s+/g, " ").trim();
  // Trim to the SPEC ceiling, not the tolerance ceiling. The soft bound
  // exists to decide whether a repair call is worth paying for; it should
  // not leak into the output, or every bullet between the spec max and the
  // tolerance shows red in the UI having never been touched.
  if (s.length <= BULLET_MAX_CHARS) return s;

  // Mask decimal points before splitting, or "6.5%" is treated as a
  // sentence end and the bullet gets truncated to "...at 6."
  const MASK = String.fromCharCode(0xE000);
  const masked = s.replace(/(\d)\.(\d)/g, `$1${MASK}$2`);
  const sentences = masked.match(/[^.!?]+[.!?]+/g) || [];
  let acc = "";
  for (const sen of sentences) {
    if ((acc + sen).trim().length <= BULLET_MAX_CHARS) acc += sen; else break;
  }
  acc = acc.split(MASK).join(".").trim();
  if (acc.length >= BULLET_MIN_CHARS - 25) return acc;

  let cut = s.slice(0, BULLET_MAX_CHARS - 2);
  const sp = cut.lastIndexOf(" ");
  if (sp > BULLET_MIN_CHARS - 45) cut = cut.slice(0, sp);
  cut = cut.replace(/[\s,;:.\-–—]+$/, "").trim();
  while (TRAILING_STOPWORDS.test(cut)) cut = cut.replace(TRAILING_STOPWORDS, "").trim();
  cut = cut.replace(/[\s,;:.\-–—]+$/, "").trim();
  return cut ? cut + "." : cut;
}

async function handleGenerateArticle(req, res) {
  if (!openaiApiKey) {
    sendJson(res, 503, { error: "OPENAI_API_KEY not set on server." });
    return;
  }

  try {
    const body = await readJson(req);
    const headline = (body?.headline || "").trim();
    const sourceUrl = (body?.sourceUrl || "").trim();
    if (!headline) {
      sendJson(res, 400, { error: "Missing 'headline' in body." });
      return;
    }

    // Grounding is everything here. Without source text the model has only a
    // headline to work from, and it fills four bullets by restating that
    // headline behind hedges — which is exactly what "over-simplified" output
    // turns out to be. So prefer text the client already scraped, and only
    // re-fetch as a fallback.
    let articleText = String(body?.articleText || "").trim().slice(0, 6000);
    let grounding = articleText ? "client" : "none";

    if (!articleText && sourceUrl) {
      try {
        const { html } = await fetchPublicHtml(sourceUrl, { userAgent: USER_AGENT });
        const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
        const scope = articleMatch?.[1] || html;
        articleText = [...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
          .map((m) => cleanupText(stripTags(m[1] || "")))
          .filter((t) => t.length >= 50 && t.length <= 500)
          .filter((t) => !/^(sign up|read more|copyright|follow live|watch:|also read)/i.test(t))
          .slice(0, 10)
          .join("\n");
        if (articleText) grounding = "refetch";
      } catch { /* grounding is best-effort */ }
    }

    if (grounding === "none") {
      console.warn("\u26a0 generate-article has NO source text — bullets will be thin. Headline:", headline.slice(0, 60));
    } else {
      console.log(`\u2713 grounded via ${grounding} (${articleText.length} chars)`);
    }

    const userContent = articleText
      ? `Source headline:\n${headline}\n\nArticle text:\n${articleText}`
      : `Source headline:\n${headline}\n\n(No article text available — write from the headline only and flag that facts could not be verified against source text.)`;

    const t0 = Date.now();
    // Pick a register from the source before generating. This is only a hint —
    // the model returns the register it actually used and that value wins.
    const suggestedRegister = suggestRegister(headline, articleText);

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildEditorialPrompt(suggestedRegister) },
          { role: "user", content: userContent },
        ],
        temperature: 0.6,
        max_tokens: 600,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      console.error(`✗ OpenAI ${aiRes.status}:`, errText.slice(0, 300));
      sendJson(res, 502, { error: openaiErrorMessage(aiRes.status, errText) });
      return;
    }

    const data = await aiRes.json();
    let parsed = {};
    try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}"); } catch { /* handled below */ }

    const out = {
      headline: (parsed.headline || "").slice(0, HEADLINE_MAX_CHARS),
      // Raw-normalize only (no clamp yet) so the repair pass sees full text.
      bullets: Array.isArray(parsed.bullets)
        ? parsed.bullets.slice(0, BULLET_COUNT).map((x) => String(x).replace(/\s+/g, " ").trim())
        : [],
      tweet: clampTweet(parsed.tweet || ""),
      flags: Array.isArray(parsed.flags) ? parsed.flags.map(String) : [],
      // Ship the spec with the payload so the UI can label counts without
      // keeping its own copy of these numbers in sync.
      // Surfaced so thin bullets are explainable rather than mysterious: if
      // sourceChars is 0 the model wrote from the headline alone.
      grounding,
      sourceChars: articleText.length,
      spec: {
        headlineMax: HEADLINE_MAX_CHARS,
        bulletCount: BULLET_COUNT,
        bulletMin: BULLET_MIN_CHARS,
        bulletMax: BULLET_MAX_CHARS,
      },
    };
    if (!out.headline || out.bullets.length < BULLET_COUNT || !out.tweet) {
      sendJson(res, 502, { error: "AI returned an incomplete package.", raw: parsed });
      return;
    }

    // The model reports the register it wrote in; fall back to our guess.
    const register = REGISTER_KEYS.includes(parsed.register) ? parsed.register : suggestedRegister;
    out.register = register;

    // Two independent failure modes, so two checks:
    //   length  — bullets outside the character band or reading as fragments
    //   tone    — writing that talks down, hedges, or drops attribution
    // The tone check is deterministic and free, so it costs nothing to run on
    // every request and only spends a model call when something is wrong.
    const lengthBad = out.bullets.some((b) => !bulletIsValid(b));
    const tone = assessTone(out.bullets, { register, sourceText: articleText || headline });

    if (lengthBad || !tone.ok) {
      if (!tone.ok) console.log(`⚠ tone (${register}):`, tone.issues.join(" | "));
      const issues = tone.issues.slice();
      if (lengthBad) {
        issues.push(`Some bullets are outside the ${BULLET_MIN_CHARS}-${BULLET_MAX_CHARS} character range or do not end as complete sentences.`);
      }
      const repaired = await rectifyBullets({
        headline, articleText, bullets: out.bullets, register, issues,
      });
      if (repaired) {
        const after = assessTone(repaired, { register, sourceText: articleText || headline });
        console.log(`✓ bullets rectified (${register})${after.ok ? "" : " — residual: " + after.issues.join(" | ")}`);
        out.bullets = repaired;
        out.toneIssues = after.ok ? [] : after.issues;
      } else {
        // Rectification failed; surface what we found rather than pretending.
        out.toneIssues = tone.issues;
      }
    } else {
      out.toneIssues = [];
    }

    out.bullets = out.bullets.map(clampBullet);

    console.log(`✓ AI article (${Date.now() - t0}ms): "${out.headline}"`);
    sendJson(res, 200, out);
  } catch (err) {
    console.error("✗ generate-article error:", err);
    sendJson(res, 500, { error: err.message || "Article generation failed." });
  }
}

/* ── OpenAI — context-aware, identity-preserving background enhance ──
   Local-dev mirror of api/upscale-image.js. Two stages:
     1. gpt-4o-mini vision describes the photo (people, faces, text, setting)
     2. gpt-image-1 (quality=high, input_fidelity=high) enhances with that
        description embedded so it knows what it must NOT change. */

// This description is embedded in the image-generation prompt, so anything
// it quotes is at risk of being RENDERED into the photo. It therefore
// describes where text sits without reproducing the words — enough for the
// model to know a sign is there and leave it alone, without handing it a
// string to draw.
const VISION_PROMPT =
  "You are assisting a photo-restoration pipeline for a news organisation. " +
  "Describe this photograph in 2-4 sentences, factually and precisely: the people " +
  "(count, apparent age, facial hair, glasses, expressions, clothing), the setting, " +
  "and the lighting. If text, logos or signage appear, say only WHERE they are and " +
  "how large (for example 'a sponsor banner across the back wall') — do NOT transcribe " +
  "or quote the words themselves. " +
  "Do NOT guess names. Output only the description.";

// The headline is deliberately NOT given to the image model.
//
// Image models treat a quoted string in the prompt as text to RENDER, so
// `It accompanies this news story: "<headline>"` reliably produced photos
// with the headline burned into them. The renderer already draws the
// headline on the canvas — the model never needs to know it.
function buildEnhancePrompt(description, _headlineNotUsed, ratioLabel) {
  return [
    "Professional photo restoration of a REAL news photograph.",
    description ? `CONTEXT — the photo shows: ${description}` : "",
    "",
    "TASK: upscale and enhance — recover fine detail, increase sharpness,",
    "remove compression artifacts and noise, correct exposure and colour balance.",
    ratioLabel
      ? `The output canvas is ${ratioLabel}. If the original photo has a different shape, EXTEND the scene naturally (continue the background/setting) to fill the ${ratioLabel} frame — keep the main subject fully visible, at the same relative scale, never cropped, stretched or distorted.`
      : "",
    "",
    "ABSOLUTE RULES:",
    "- Every person's face must stay PIXEL-FAITHFUL to the original identity:",
    "  same facial structure, skin texture, wrinkles, expression and age.",
    "  Do NOT beautify, smooth skin, or idealise anyone.",
    "- DO NOT ADD ANY TEXT OR GRAPHICS. No headline, caption, title, label,",
    "  subtitle, watermark, banner, lower-third or logo. Write no words",
    "  anywhere in the image.",
    "- Text physically present in the photograph (signage, jerseys, banners",
    "  held by people) is preserved exactly as it already appears — never",
    "  invented, completed, translated or extended.",
    "- The original content itself is unchanged — only the surrounding scene",
    "  may be extended to fill the frame. Add no new people or objects of",
    "  interest. This is journalism, not art.",
    "",
    "The result is a clean photograph with no added lettering or graphics.",
  ].filter(Boolean).join("\n");
}

// Map the poster's aspect ratio to the closest gpt-image output size.
/* Ask for the SOURCE's shape, not the poster's.

   This used to follow the poster ratio, so a landscape photo on a 9:16 poster
   was requested as 1024x1536 and the model outpainted the missing height —
   inventing sky and floor to fill a frame the photograph never had.

   That was deliberate, to stop the canvas cropping a wide photo to shreds.
   But the invented margin is not the photograph, and it shows: the enhanced
   result carried a hard-edged band of model-drawn background above and below
   the real picture, which is visible as a box on the published card. It also
   breaks the merge — a reframed output cannot be aligned pixel-for-pixel with
   the original, which is what preserves the subject's face.

   Matching the source keeps the model doing the one job asked of it, which is
   detail. Framing stays where it belongs: the poster canvas already crops and
   pans to the chosen ratio, under the writer's control, using real pixels. */
function sizeForRatio(ratio, orientationHint) {
  if (orientationHint === "landscape") return "1536x1024";
  if (orientationHint === "portrait")  return "1024x1536";
  /* No hint: let the model match the input rather than guessing from the
     poster, which is what produced the outpainting in the first place. */
  if (ratio === "1:1") return "1024x1024";
  return "auto";
}

async function describeImageForEnhance(buffer, mime) {
  try {
    const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: VISION_PROMPT },
            { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
          ],
        }],
        temperature: 0.2,
        max_tokens: 220,
      }),
    });
    if (!r.ok) {
      console.warn(`⚠ vision describe failed (${r.status}) — enhancing without context`);
      return "";
    }
    const data = await r.json();
    return (data?.choices?.[0]?.message?.content || "").trim();
  } catch (e) {
    console.warn("⚠ vision describe error — enhancing without context:", e.message);
    return "";
  }
}

// Primary engine: the self-hosted CodeFormer + Real-ESRGAN service on Railway
// (pixel-faithful, never regenerates faces). Returns a PNG data URL, or null
// if the service isn't configured / errors / times out — caller then falls
// back to gpt-image-1.5.
async function tryRailwayUpscale(buffer, mime, strength) {
  const base = (env("UPSCALER_URL")).replace(/\/+$/, "");
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 285000);
  try {
    const r = await fetch(`${base}/enhance`, {
      method: "POST",
      headers: {
        "Content-Type": mime,
        "X-Secret": env("UPSCALER_SECRET"),
        // How much of the model output to keep. Passed through from the
        // client so the slider is live, rather than baked in per deploy.
        ...(strength ? { "X-Enhance-Strength": String(strength) } : {}),
      },
      body: buffer,
      signal: ctrl.signal,
    });
    if (!r.ok) {
      console.warn(`⚠ Railway upscaler ${r.status} — falling back to gpt-image`);
      return null;
    }
    const out = Buffer.from(await r.arrayBuffer());
    if (out.length < 1000) return null;
    return {
      dataUrl: `data:image/png;base64,${out.toString("base64")}`,
      engine: r.headers.get("x-engine") || "railway",
    };
  } catch (e) {
    console.warn("⚠ Railway upscaler unreachable — falling back to gpt-image:", e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function handleUpscaleImage(req, res) {
  if (!openaiApiKey) {
    sendJson(res, 503, { error: "OPENAI_API_KEY not set on server." });
    return;
  }

  try {
    // Read raw image body (10 MB cap)
    const MAX_BYTES = 10 * 1024 * 1024;
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BYTES) {
        sendJson(res, 413, { error: "Image exceeds 10 MB." });
        return;
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length < 1000) {
      sendJson(res, 400, { error: "Empty or invalid image body." });
      return;
    }
    const mime = req.headers["content-type"]?.includes("jpeg") ? "image/jpeg" : "image/png";
    const headline = decodeURIComponent(req.headers["x-headline"] || "").trim().slice(0, 200);

    // PRIMARY: self-hosted upscaler on Railway (pixel-faithful).
    const railwayT0 = Date.now();
    const strength = (req.headers["x-enhance-strength"] || "").toString();
    const railway = await tryRailwayUpscale(buffer, mime, strength);
    if (railway) {
      console.log(`✓ AI enhance via Railway (${railway.engine}) in ${Date.now() - railwayT0}ms`);
      sendJson(res, 200, { image: railway.dataUrl, engine: railway.engine });
      return;
    }
    // The paid fallback is opt-out. Without this guard a momentary failure of
    // the self-hosted upscaler silently spends OpenAI credits — the caller
    // still gets an enhanced image, so nothing looks wrong until the bill
    // arrives. Set DISABLE_GPT_IMAGE=true to make that spend impossible and
    // surface the real problem instead.
    if (gptImageDisabled) {
      console.warn("⚠ upscaler unavailable and DISABLE_GPT_IMAGE is set — refusing to spend OpenAI credits");
      sendJson(res, 503, {
        error: upscalerConfigured
          ? "The self-hosted upscaler did not respond, and the paid gpt-image fallback is disabled (DISABLE_GPT_IMAGE). Check that the upscaler service is running."
          : "No upscaler is configured (UPSCALER_URL unset) and the paid gpt-image fallback is disabled (DISABLE_GPT_IMAGE).",
      });
      return;
    }

    // else fall through to gpt-image-1.5 ↓

    // The SELECTED POSTER RATIO drives the output size, so a 9:16 poster
    // gets a portrait image (outpainted if the source is landscape) instead
    // of a landscape image that the canvas then crops to shreds.
    const posterRatio = (req.headers["x-poster-ratio"] || "").toString();
    const sizeHint = (req.headers["x-image-orientation"] || "").toString();
    const size = sizeForRatio(posterRatio, sizeHint);

    /* Default low. high≈$0.25, medium≈$0.06, low≈$0.016 — so this is roughly
       a quarter of what medium cost, on the single biggest line item in the
       app's running cost.

       Safe to drop because of the line below it: input_fidelity=high is what
       preserves faces and identity, and that is kept. `quality` buys texture
       and fine detail on top of that. On a news photo destined to be scaled
       into a 920px poster slot and then re-encoded by DailyMattr, that extra
       texture does not survive the trip — we were paying for detail that was
       thrown away downstream.

       Raise it per-deployment with IMAGE_QUALITY=medium if a particular set
       of images needs it. Note that variable is already set in Railway, and
       an env value overrides this default. */
    const quality = (process.env.IMAGE_QUALITY || "low").toLowerCase();

    const t0 = Date.now();

    // Stage 1 — understand the image (cheap, fails soft)
    const description = await describeImageForEnhance(buffer, mime);
    if (description) console.log(`✓ vision context (${Date.now() - t0}ms): ${description.slice(0, 140)}…`);

    // Stage 2 — context-aware enhancement.
    // gpt-image-1.5 first; automatic fallback to gpt-image-1 if the account
    // doesn't have the newer model.
    const prompt = buildEnhancePrompt(description, headline, posterRatio);
    const callEdit = async (model) => {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", prompt);
      form.append("size", size);
      form.append("quality", quality);
      form.append("input_fidelity", "high");   // OpenAI's face/identity preservation control
      form.append("image", new Blob([buffer], { type: mime }), mime === "image/jpeg" ? "input.jpg" : "input.png");
      return fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { "Authorization": `Bearer ${openaiApiKey}` },
        body: form,
      });
    };

    let modelUsed = "gpt-image-1.5";
    let aiRes = await callEdit(modelUsed);
    if (!aiRes.ok && [400, 403, 404].includes(aiRes.status)) {
      const firstErr = await aiRes.text().catch(() => "");
      console.warn(`⚠ gpt-image-1.5 unavailable (${aiRes.status}) — falling back to gpt-image-1:`, firstErr.slice(0, 160));
      modelUsed = "gpt-image-1";
      aiRes = await callEdit(modelUsed);
    }

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      console.error(`✗ ${modelUsed} ${aiRes.status}:`, errText.slice(0, 400));
      sendJson(res, 502, { error: `OpenAI image ${aiRes.status}`, detail: errText.slice(0, 300) });
      return;
    }

    const data = await aiRes.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      sendJson(res, 502, { error: "OpenAI returned no image data." });
      return;
    }

    console.log(`✓ AI enhance done in ${Date.now() - t0}ms (${modelUsed}, ${size}, quality=${quality})`);
    sendJson(res, 200, { image: `data:image/png;base64,${b64}`, context: description, engine: modelUsed });
  } catch (err) {
    console.error("✗ upscale-image error:", err);
    sendJson(res, 500, { error: err.message || "Image enhance failed." });
  }
}
