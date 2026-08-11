/* ── Supabase Storage ──
   Where uploaded images and videos actually live. The database row keeps a
   URL; the bytes go in a bucket.

   Two values configure it, both from the Supabase dashboard:

     SUPABASE_URL               https://<project-ref>.supabase.co
     SUPABASE_SERVICE_ROLE_KEY  Settings → API Keys → service_role

   The service_role key bypasses row-level security, which is exactly why it
   must never reach the browser. Every upload goes through /api/media on this
   server, which checks the session first — the key stays server-side.

   No SDK: the Storage REST API is three fetch calls, and the alternative is a
   dependency an order of magnitude larger than the code it replaces. */

const BUCKET = "pix-media";

let baseUrl = "";
let serviceKey = "";
let bucketReady = null;

export function configureStorage({ url, serviceRoleKey } = {}) {
  baseUrl = clean(url).replace(/\/+$/, "");
  serviceKey = clean(serviceRoleKey);
  bucketReady = null;
  return isStorageConfigured();
}

function clean(value) {
  return String(value || "").trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
}

export function isStorageConfigured() {
  return Boolean(baseUrl && serviceKey);
}

function headers(extra = {}) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    ...extra,
  };
}

/* Created on first upload and then memoised. Public so the poster image can
   be loaded straight into a <canvas> — these are news posters headed for
   social media, not private documents, and a signed URL that expires would
   mean a saved post silently losing its image later. */
async function ensureBucket() {
  if (bucketReady) return bucketReady;
  bucketReady = (async () => {
    const res = await fetch(`${baseUrl}/storage/v1/bucket`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      // No file_size_limit: a bucket cannot ask for more than the project's
      // global upload limit, and requesting more fails the whole create with
      // a 413 that reads like the *bucket* was too large. Omitting it inherits
      // whatever the project allows, whatever plan it is on.
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
    });
    if (res.ok) return true;

    // Already there is success, not failure.
    const body = await res.clone().text().catch(() => "");
    if (res.status === 409 || /already exists|Duplicate/i.test(body)) return true;

    bucketReady = null;
    throw new Error(await storageError(res, `Could not create the ${BUCKET} bucket`));
  })();
  return bucketReady;
}

/**
 * Store one file and return its public URL.
 *
 * `key` is the object path inside the bucket. Callers build it from a random
 * id, never from the uploaded filename — a name arriving from a browser is
 * attacker-controlled and has no business steering a storage path.
 */
export async function uploadMedia(key, body, contentType = "application/octet-stream") {
  if (!isStorageConfigured()) throw new Error("Storage is not configured.");
  await ensureBucket();

  const res = await fetch(`${baseUrl}/storage/v1/object/${BUCKET}/${key}`, {
    method: "POST",
    headers: headers({
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "x-upsert": "true",
    }),
    body,
  });

  if (!res.ok) {
    throw new Error(await storageError(res, "Upload failed"));
  }
  return publicUrl(key);
}

/* Supabase wraps the real reason in a JSON body; the HTTP status alone is
   often misleading (a bucket create refused for asking too high a file limit
   comes back as a 413 "Payload too large"). Pull the message out, and say
   what to do about the one that actually happens. */
async function storageError(res, prefix) {
  let detail = "";
  try {
    const body = await res.json();
    detail = body?.message || body?.error || JSON.stringify(body);
    if (String(body?.statusCode) === "413" || body?.code === "EntityTooLarge") {
      return `${prefix}: the file is over this Supabase project's upload limit (50 MB on the free plan). Raise it in Settings → Storage, or use a smaller file.`;
    }
  } catch {
    detail = await res.text().catch(() => "");
  }
  return `${prefix} (${res.status}): ${String(detail).slice(0, 200)}`;
}

export function publicUrl(key) {
  return `${baseUrl}/storage/v1/object/public/${BUCKET}/${key}`;
}

/** True when a URL points at our own bucket — used to skip re-uploading. */
export function isStoredMediaUrl(url) {
  return Boolean(baseUrl) && String(url || "").startsWith(`${baseUrl}/storage/v1/object/public/${BUCKET}/`);
}

/* Health probe: proves the key works, not merely that it is set. */
export async function pingStorage() {
  if (!isStorageConfigured()) return { configured: false, ok: false, error: "SUPABASE_SERVICE_ROLE_KEY not set" };
  try {
    const res = await fetch(`${baseUrl}/storage/v1/bucket`, { headers: headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { configured: true, ok: false, error: `${res.status} ${text.slice(0, 120)}` };
    }
    const buckets = await res.json();
    return { configured: true, ok: true, buckets: buckets.map((b) => b.name) };
  } catch (err) {
    return { configured: true, ok: false, error: err.message };
  }
}
