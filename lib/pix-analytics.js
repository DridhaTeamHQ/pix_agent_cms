import { describeConnectionError, getPixAnalytics, isConfigured } from "./db.js";

export async function handlePixAnalyticsRequest({ user = null }) {
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

  try {
    const analytics = await getPixAnalytics({
      role: user.role,
      userLoginId: null,
      approverId: user.id,
    });
    return {
      status: 200,
      body: {
        role: user.role,
        analytics,
      },
    };
  } catch (err) {
    const message = describeConnectionError(err);
    console.warn("⚠ /api/pix-analytics failed:", message);
    return { status: 502, body: { error: message } };
  }
}
