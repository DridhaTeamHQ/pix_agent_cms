import { describeConnectionError, getPixAnalytics, isConfigured, UNCATEGORISED } from "./db.js";

/* Dates arrive as the browser's native <input type="date"> value. Anything that
   is not a real YYYY-MM-DD is dropped rather than passed to Postgres, so a
   malformed range reads as "no range" instead of erroring the whole panel.
   The shape test alone is not enough — "2025-13-45" matches it and then fails
   in the database — so the value has to survive a round trip through Date. */
function cleanDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === text ? text : null;
}

export async function handlePixAnalyticsRequest({ user = null, query = null }) {
  if (!isConfigured()) {
    return {
      status: 503,
      body: { error: "No database configured. Set SUPABASE_POOLER_URL to view analytics." },
    };
  }
  if (!user) {
    return { status: 401, body: { error: "Sign in to view analytics." } };
  }
  // Analytics covers the whole team's throughput, so it is QA-only. The UI
  // hides the tab; this is the part that actually enforces it.
  if (user.role !== "qa") {
    return { status: 403, body: { error: "Analytics is available to QA only." } };
  }

  let from = cleanDate(query?.get("from"));
  let to = cleanDate(query?.get("to"));
  // A backwards range would silently return nothing; read it as the range the
  // user meant rather than making them notice the order of two date pickers.
  if (from && to && from > to) [from, to] = [to, from];

  /* A DailyMattr category id, or the sentinel for posts with no section on
     them. Anything else — including a name, which an older client might send —
     is dropped rather than passed to an integer column. */
  const rawCategory = String(query?.get("category") || "").trim();
  const category = rawCategory === UNCATEGORISED ? UNCATEGORISED
    : /^\d+$/.test(rawCategory) ? rawCategory
    : null;

  try {
    const analytics = await getPixAnalytics({
      role: user.role,
      userLoginId: null,
      approverId: user.id,
      from,
      to,
      category,
    });
    return {
      status: 200,
      body: {
        role: user.role,
        filters: { from, to, category: category || "all", uncategorised: UNCATEGORISED },
        analytics,
      },
    };
  } catch (err) {
    const message = describeConnectionError(err);
    console.warn("⚠ /api/pix-analytics failed:", message);
    return { status: 502, body: { error: message } };
  }
}
