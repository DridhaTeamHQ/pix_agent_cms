const DEFAULT_BASE_URL = "https://api.dailymattr.com/api/integrations/sub-editor-states";

let authCache = {
  token: "",
  expiresAt: 0,
  cacheKey: "",
};
let authPromise = null;

export function getDailyMattrConfig(env = process.env) {
  const baseUrl = clean(env.DAILYMATTR_BASE_URL || env.DAILYMATTR_API_BASE_URL) || DEFAULT_BASE_URL;
  const apiKey = clean(env.DAILYMATTR_API_KEY);
  const email = clean(env.DAILYMATTR_EMAIL || env.DAILYMATTR_USERNAME);
  const password = clean(env.DAILYMATTR_PASSWORD);

  const missing = [];
  if (!apiKey) missing.push("DAILYMATTR_API_KEY");
  if (!email) missing.push("DAILYMATTR_EMAIL");
  if (!password) missing.push("DAILYMATTR_PASSWORD");

  return {
    ready: missing.length === 0,
    missing,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    email,
    password,
  };
}

export async function fetchDailyMattrMeta(config = getDailyMattrConfig()) {
  if (!config.ready) {
    return {
      configured: false,
      missing: config.missing,
      categories: [],
      states: [],
    };
  }

  const [categories, states] = await Promise.all([
    fetchOptionList("categories", config),
    fetchOptionList("states", config),
  ]);

  return {
    configured: true,
    missing: [],
    categories,
    states,
  };
}

export async function publishDailyMattrBuzzContent(
  {
    contentEn = "",
    categoryId = "",
    keywords = "",
    stateId = "",
    sourceUrl = "",
    files = [],
  },
  config = getDailyMattrConfig(),
) {
  if (!config.ready) {
    throw new Error(`DailyMattr is not configured on this server. Missing: ${config.missing.join(", ")}`);
  }

  const content = String(contentEn || "").trim();
  const category = String(categoryId || "").trim();
  const keywordText = String(keywords || "").trim();
  const chosenState = String(stateId || "").trim();
  const source = String(sourceUrl || "").trim();

  if (!content) throw new Error("content_en is required.");
  if (!category) throw new Error("category_id is required.");
  if (!Array.isArray(files) || !files.length) throw new Error("At least one media file is required.");

  const form = new FormData();
  form.append("content_en", content);
  form.append("category_id", category);
  if (keywordText) form.append("keywords", keywordText);
  if (chosenState) form.append("state_id", chosenState);
  if (source) form.append("source_link", source);

  files.forEach((file, index) => {
    const fieldName = file.fieldName || `media_page_${index + 1}`;
    const filename = file.filename || `${fieldName}${guessExtension(file.contentType)}`;
    form.append(
      fieldName,
      new Blob([file.buffer], { type: file.contentType || "application/octet-stream" }),
      filename,
    );
  });

  const payload = await apiFetch("buzz-contents", {
    method: "POST",
    body: form,
  }, config);

  return {
    ok: true,
    // DailyMattr returns "buzz_id"; without it in this list every publish
    // logged "id=none" even though the post was created (e.g. buzz_id 1379).
    publishedId: findValue(payload, ["buzz_id", "id", "buzz_content_id", "content_id", "_id"]),
    response: payload,
  };
}

async function fetchOptionList(path, config) {
  const payload = await apiFetch(path, { method: "GET" }, config);
  const list = extractArray(payload, [
    "data",
    "items",
    "results",
    path,
    path.slice(0, -1),
  ]);

  return list
    .map(normaliseOption)
    .filter((item) => item.id && item.name);
}

async function apiFetch(path, options, config, retrying = false) {
  const token = await getAuthToken(config, retrying);
  const response = await fetch(`${config.baseUrl}/${path}`, {
    ...options,
    headers: {
      "x-api-key": config.apiKey,
      Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  if (response.status === 401 && !retrying) {
    authCache = { token: "", expiresAt: 0, cacheKey: "" };
    authPromise = null;
    return apiFetch(path, options, config, true);
  }

  const payload = await readPayload(response);
  if (!response.ok) {
    const detail = formatErrorPayload(payload) || `HTTP ${response.status}`;
    throw new Error(`DailyMattr ${path} failed: ${detail}`);
  }
  return payload;
}

async function getAuthToken(config, forceRefresh = false) {
  const cacheKey = `${config.baseUrl}|${config.apiKey}|${config.email}`;
  if (
    !forceRefresh &&
    authCache.token &&
    authCache.cacheKey === cacheKey &&
    authCache.expiresAt > Date.now() + 15_000
  ) {
    return authCache.token;
  }

  // Categories and states load in parallel. Without sharing the in-flight
  // login, first load sends two credential requests and can create competing
  // tokens on providers that rotate sessions at login time.
  if (!forceRefresh && authPromise) return authPromise;

  const pending = requestAuthToken(config, cacheKey);
  authPromise = pending;
  try {
    return await pending;
  } finally {
    if (authPromise === pending) authPromise = null;
  }
}

async function requestAuthToken(config, cacheKey) {

  const response = await fetch(`${config.baseUrl}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
    },
    body: JSON.stringify({
      email: config.email,
      password: config.password,
    }),
  });

  const payload = await readPayload(response);
  if (!response.ok) {
    const detail = formatErrorPayload(payload) || `HTTP ${response.status}`;
    throw new Error(`DailyMattr login failed: ${detail}`);
  }

  const token = extractToken(payload);
  if (!token) {
    throw new Error("DailyMattr login succeeded but no access token was returned.");
  }

  authCache = {
    token,
    cacheKey,
    expiresAt: Date.now() + extractTokenLifetimeMs(payload),
  };
  return token;
}

function normaliseOption(item) {
  if (item == null) return { id: "", name: "", raw: item };
  if (typeof item !== "object") {
    const text = String(item).trim();
    return { id: text, name: text, raw: item };
  }

  const id = firstText(item, ["id", "_id", "category_id", "state_id", "value", "code"]);
  const name = firstText(item, ["name", "title", "label", "category_name", "state_name", "slug"]);
  return {
    id,
    name: name || id,
    raw: item,
  };
}

function extractToken(payload) {
  return firstText(payload, [
    "token",
    "access_token",
    "accessToken",
    "jwt",
    "bearer_token",
    "bearerToken",
  ]) || firstText(payload?.data, [
    "token",
    "access_token",
    "accessToken",
    "jwt",
    "bearer_token",
    "bearerToken",
  ]);
}

function extractTokenLifetimeMs(payload) {
  const seconds = Number(
    payload?.expires_in ??
    payload?.expiresIn ??
    payload?.data?.expires_in ??
    payload?.data?.expiresIn,
  );
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return 45 * 60 * 1000;
}

function extractArray(payload, candidateKeys = []) {
  if (Array.isArray(payload)) return payload;
  for (const key of candidateKeys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

function firstText(source, keys) {
  if (!source || typeof source !== "object") return "";
  for (const key of keys) {
    const value = source[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function findValue(source, keys) {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    if (source[key] != null) return source[key];
    if (source.data && source.data[key] != null) return source.data[key];
  }
  return null;
}

async function readPayload(response) {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text }; }
}

function formatErrorPayload(payload) {
  return firstText(payload, ["error", "message", "detail"]) ||
    firstText(payload?.data, ["error", "message", "detail"]);
}

// Slide 2 may be a trimmed MP4, not just a still, so the video types belong
// here too — DailyMattr accepts JPG, PNG, WEBP, MP4 and MOV. Without these a
// clip would be sent as a file with no extension at all.
function guessExtension(contentType) {
  const lower = String(contentType || "").toLowerCase();
  if (lower.includes("png")) return ".png";
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("gif")) return ".gif";
  if (lower.includes("quicktime") || lower.includes("mov")) return ".mov";
  if (lower.includes("mp4")) return ".mp4";
  return "";
}

function clean(value) {
  if (value == null) return "";
  return String(value).trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
}
