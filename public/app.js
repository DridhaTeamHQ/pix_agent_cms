/* ── PIXIE — Scrape + Edit ── */

const canvas = document.getElementById("post-canvas");
// `ctx` is `let` (not const) so renderToHighResCanvas() can temporarily swap
// it to an offscreen 2× context for export, without rewriting every draw
// function to take a ctx parameter.
let ctx = canvas.getContext("2d");
const screenCtx = ctx;   // permanent reference to the on-screen context

// ── Export resolution ──
// Downloads aim as high as the browser can actually encode: 8K long edge
// first, stepping down to 6K then 4K. Oversized canvases silently fail on
// iOS/low-end GPUs (toBlob returns null or a blank) — the fallback chain in
// renderExportBlob() keeps trying smaller until one really encodes.
//   8K target (7680 long edge):
//     9:16  920×1700  → ×4.52 → 4159×7680
//     4:5  1080×1350  → ×5.69 → 6144×7680
//     1:1  1080×1080  → ×7.11 → 7680×7680
//     16:9 1920×1080  → ×4.00 → 7680×4320 (8K UHD)
const EXPORT_LONG_EDGES = [7680, 6144, 3840];   // 8K → 6K → 4K
function scaleForLongEdge(target) {
  const longEdge = Math.max(canvas.width, canvas.height);
  return Math.max(2, target / longEdge);   // never below 2× (retina floor)
}

/**
 * Render + PNG-encode the poster at the highest resolution the browser can
 * handle, stepping down through EXPORT_LONG_EDGES on failure.
 * `cropOpts` (optional): { paddingBelow, minHeight } in DESIGN pixels —
 * multiplied by the chosen scale before cropping the trailing black gap.
 * Returns { blob, width, height } or null if every tier failed.
 */
/* `encode` picks the file format. PNG is right for a download — it is exact,
   and a writer saving a poster wants the original pixels. It is the wrong
   thing to put on the wire: a 2078×3840 poster PNG is 12 MB, and five of them
   is a 42 MB upload that DailyMattr answers with a bare "Validation Error".
   See the compression ladder near DAILYMATTR_COMPRESSION_LADDER. */
async function renderExportBlob(cropOpts = null, targetLongEdges = EXPORT_LONG_EDGES, encode = null) {
  const type = encode?.type || "image/png";
  const quality = encode?.quality;
  for (const target of targetLongEdges) {
    const scale = scaleForLongEdge(target);
    let out;
    try {
      out = renderToHighResCanvas(scale);
      if (cropOpts) {
        out = exportCanvasCroppedToContent(out, {
          paddingBelow: cropOpts.paddingBelow * scale,
          minHeight:    cropOpts.minHeight * scale,
        });
      }
    } catch {
      continue;   // allocation failed at this size — try smaller
    }
    // toBlob returns null (or throws) when the canvas is too large to encode.
    const blob = await new Promise((resolve) => {
      try { out.toBlob(resolve, type, quality); } catch { resolve(null); }
    });
    if (blob && blob.size > 2000) {
      return { blob, width: out.width, height: out.height };
    }
  }
  return null;
}

// The X export stays at 2× — X rejects PNG uploads over 5 MB, and a full
// 4K/8K poster PNG blows well past that.
const X_EXPORT_SCALE = 2;

// Text-preview paragraph font (the bullet copy drawn on the canvas in "Text"
// mode). Keep the paragraph copy firmly bold in both measure and draw passes
// so the rendered text doesn't drift between lighter/heavier states.
const PREVIEW_TEXT_WEIGHT = 700;
const PREVIEW_TEXT_FONT = "'Poppins', 'Segoe UI', Arial, sans-serif";

const IMAGE_PAN_LIMIT = 900;
const IMAGE_PAN_HEADROOM = 1.1;

/**
 * Render the poster onto an offscreen canvas at `scale`× the design size and
 * return that canvas. Used for exporting at higher resolution than the live
 * preview (Download, Post-to-X). All draw functions read `canvas.width` and
 * `canvas.height` for layout — those stay at design size, while the export
 * ctx is scaled, so pixels come out at scale× density without changing a
 * single coordinate in the renderer.
 */
function renderToHighResCanvas(scale = 2) {
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width  = canvas.width  * scale;
  exportCanvas.height = canvas.height * scale;
  const exportCtx = exportCanvas.getContext("2d");
  // High-quality image scaling for any upscale during cover-image draw
  exportCtx.imageSmoothingEnabled = true;
  exportCtx.imageSmoothingQuality = "high";
  exportCtx.scale(scale, scale);

  // Swap the module-level ctx → all draw calls inside renderPoster() now
  // target the offscreen canvas. Restore immediately after.
  const previous = ctx;
  const prevTargeted = state._targetedRender;
  ctx = exportCtx;
  state._targetedRender = true;   // paint this one canvas, not all three cards
  try {
    renderPoster();
  } finally {
    ctx = previous;
    state._targetedRender = prevTargeted;
  }
  return exportCanvas;
}

const scrapeForm = document.getElementById("scrape-form");
const scrapeUrlInput = document.getElementById("scrape-url");
const scrapeButton = document.getElementById("scrape-btn");
const scrapeStatus = document.getElementById("scrape-status");
const downloadButton = document.getElementById("download-btn");
const textDownloadButton = document.getElementById("text-download-btn");
const previewModeToggle = document.getElementById("preview-mode-toggle");
const authGate = document.getElementById("auth-gate");
const authMessage = document.getElementById("auth-message");
const loginForm = document.getElementById("login-form");
const loginUsername = document.getElementById("login-username");
const loginPassword = document.getElementById("login-password");
const loginSubmit = document.getElementById("login-submit");
const accountBox = document.getElementById("account-box");
const accountName = document.getElementById("account-name");
const accountRole = document.getElementById("account-role");
const logoutBtn = document.getElementById("logout-btn");
const analyticsView = document.getElementById("analytics-view");
const analyticsRefreshBtn = document.getElementById("analytics-refresh");
const analyticsStatus = document.getElementById("analytics-status");
const analyticsMetaTitle = document.getElementById("analytics-meta-title");
const analyticsMetaList = document.getElementById("analytics-meta-list");
const analyticsTodayDate = document.getElementById("analytics-today-date");
const analyticsDailyReset = document.getElementById("analytics-daily-reset");
const analyticsRosterToggle = document.getElementById("analytics-roster-toggle");
const analyticsRosterBody = document.getElementById("analytics-roster-body");
const analyticsRosterList = document.getElementById("analytics-roster-list");
const analyticsRosterCount = document.getElementById("analytics-roster-count");
const analyticsRosterTitle = document.getElementById("analytics-roster-title");
const analyticsRosterDesc = document.getElementById("analytics-roster-desc");
const analyticsSourceTrigger = document.getElementById("analytics-source-trigger");
const analyticsSourceMenu = document.getElementById("analytics-source-menu");
const analyticsSourceLabel = document.getElementById("analytics-source-label");
const analyticsCategoryTrigger = document.getElementById("analytics-category-trigger");
const analyticsCategoryMenu = document.getElementById("analytics-category-menu");
const analyticsCategoryLabel = document.getElementById("analytics-category-label");
const analyticsFrom = document.getElementById("analytics-from");
const analyticsTo = document.getElementById("analytics-to");
const analyticsRangeApply = document.getElementById("analytics-range-apply");
const analyticsRangeClear = document.getElementById("analytics-range-clear");
const analyticsUpdated = document.getElementById("analytics-updated");
const analyticsFilterSummary = document.getElementById("analytics-filter-summary");

const editPanel = document.getElementById("edit-panel");
const imagePanel = document.getElementById("image-panel");
const headlineEdit = document.getElementById("headline-edit");
const detailEdit = document.getElementById("detail-edit");
const imgOffsetX = document.getElementById("img-offset-x");
const imgOffsetY = document.getElementById("img-offset-y");
const storyOpacityControl = document.getElementById("story-opacity-control");
const storyOverlayOpacityInput = document.getElementById("story-overlay-opacity");
const imgResetBtn = document.getElementById("img-reset-btn");
const bgImageUpload = document.getElementById("bg-image-upload");
const bgUploadZone = document.getElementById("bg-upload-zone");
const bgPasteBtn = document.getElementById("bg-paste-btn");
const stockImagesSection = document.getElementById("stock-images-section");
const stockImagesGrid = document.getElementById("stock-images-grid");
const imgZoom = document.getElementById("img-zoom");
/* Bounds live with the input: the range attributes are the contract, and the
   - / + buttons must clamp to exactly the same numbers the restore path does. */
const ZOOM_MIN = 10;
const ZOOM_MAX = 300;
const ZOOM_STEP = 5;
const fontSizeInput = document.getElementById("font-size");
const accentColorInput = document.getElementById("accent-color");
const accentHexLabel = document.getElementById("accent-hex");
const tagPresetsContainer = document.getElementById("tag-presets");

const faceDetector =
  typeof window !== "undefined" && "FaceDetector" in window
    ? new FaceDetector({ fastMode: true, maxDetectedFaces: 1 })
    : null;

/* ── Aspect-ratio layout presets ──
   Each preset defines the canvas size + every key element's position so a
   single render path can produce posters in different aspect ratios.
   9:16 is the original Zeplin spec; the others are tuned to look right at
   their respective dimensions. Tweak numbers per preset, not in renderPoster. */
/* Each preset's `headline.bottomPadding` is the gap (px) between the bottom
   of the LAST headline line and the canvas bottom. The headline's actual y
   position is computed at render time from:
       top = canvas.height - bottomPadding - blockHeight
   so the headline always anchors to the bottom of the canvas no matter how
   many lines it wraps to. The gradient.fadeHeight defines how tall the
   transparent→black fade is above the headline. */
const LAYOUT_PRESETS = {
  "9:16": {
    label: "9:16",
    sub:   "Story / Reel",
    W: 920,  H: 1700,
    logo:     { centerX: 810, centerY: 150, slotPix: 100, slotShortly: 112 },
    /* 9:16 leaves room for the preview engagement + nav bars while keeping
       the headline closer to the likes row. */
    headline: { x: 64, bottomPadding: 305, maxWidth: 920 - 128, defaultSize: 49 },
    tag:      { x: 64, gapAboveHeadline: 16 },
    gradient: { fadeHeight: 330 },
    showPreviewBars: true,
  },
  "4:5": {
    label: "4:5",
    sub:   "Feed Portrait",
    W: 1080, H: 1350,
    logo:     { centerX: 970, centerY: 130, slotPix: 92,  slotShortly: 104 },
    headline: { x: 70, bottomPadding: 110, maxWidth: 1080 - 140, defaultSize: 52 },
    tag:      { x: 70, gapAboveHeadline: 14 },
    gradient: { fadeHeight: 300 },
    showPreviewBars: false,
  },
  "1:1": {
    label: "1:1",
    sub:   "Square",
    W: 1080, H: 1080,
    logo:     { centerX: 970, centerY: 120, slotPix: 90, slotShortly: 102 },
    headline: { x: 70, bottomPadding: 90, maxWidth: 1080 - 140, defaultSize: 50 },
    tag:      { x: 70, gapAboveHeadline: 14 },
    gradient: { fadeHeight: 280 },
    showPreviewBars: false,
  },
  "16:9": {
    label: "16:9",
    sub:   "Wide",
    W: 1920, H: 1080,
    logo:     { centerX: 1810, centerY: 110, slotPix: 90, slotShortly: 102 },
    /* Tighter maxWidth + bigger font so the headline wraps to ~3 lines
       and reads with the same prominence as the portrait presets. */
    headline: { x: 90, bottomPadding: 100, maxWidth: 1200, defaultSize: 64 },
    tag:      { x: 90, gapAboveHeadline: 14 },
    gradient: { fadeHeight: 300 },
    showPreviewBars: false,
  },
};

/* ── State ── */

const state = {
  aspectRatio: "9:16",         // key into LAYOUT_PRESETS
  accent: "#3979FF",
  headline: "",
  detailText: "",
  sourceUrl: "",               // article URL from the last scrape (grounds the AI writer)
  // Where the story is filed on the web app. Chosen by the writer, confirmed
  // by QA at publish.
  categoryId: "",
  stateId: "",
  articleText: "",             // full scraped body text — what actually grounds the AI writer
  mainImage: null,
  ready: false,
  imageOffset: { x: 0, y: 0 },
  imageZoom: 100,
  headlineStyle: "half-purple",
  fontSize: 0, // 0 = auto
  enhanceStrength: 20,      // percent of the AI upscale to keep
  logoX: 810,
  logoY: 80,
  logoSize: 110,
  logoImage: null,
  shortlyLogoImage: null,   // alt logo used when exporting for X
  useShortlyLogo: false,    // toggled by the X download handler
  previewMode: "pix",       // "pix" | "x" | "text" | "video"

  /* ── Slide 2 video ──
     Slide 2 is either the Text card or a trimmed, branded video clip.
     `videoEl` is the <video> element itself — drawn straight to the canvas
     in preview, and the source of truth for trim bounds. `videoFile` is set
     for local uploads, `videoUrl` for scraped YouTube/Instagram links; the
     export path picks whichever is present. */
  videoEl: null,
  // What the <video> element is actually playing. Kept so a video page that
  // loses the shared player can reload the same source into its own.
  videoSrc: "",
  videoUrl: "",             // resolved source URL (scrape path)
  videoFile: null,          // File object (local upload path)
  videoMeta: null,          // { title, duration, uploader, ... } from /resolve
  videoSourceKind: "file",  // new clips are direct uploads; "link" is legacy-only
  trimStart: 0,
  trimEnd: 0,
  videoMuted: false,
  videoExporting: false,
  // Framing for the video slide. A landscape clip cropped to 9:16 loses most
  // of its width, so which slice you keep matters — normalised 0..1 so the
  // same value drives the canvas preview and ffmpeg's crop regardless of
  // resolution.
  videoFocus: { x: 0.5, y: 0.5 },
  // null = use the current date at paint time. Only set to a Date if a
  // specific day ever needs pinning; leaving it null is what keeps an
  // open tab honest across midnight.
  // The date printed on the slide. Null means "use today", which is what it
  // did before this was editable.
  /* Live values for the selected story page. Like every other page field
     these are swapped in and out by setActivePage; the page keeps the copy. */
  storyHeading: "",
  storyBody: "",
  storyOverlayOpacity: 100,
  /* Unfinished until the writer says otherwise. Defaulting to false meant a
     brand-new post was born already marked "submitted", so anything that
     saved it — a mis-click, autosave once a row existed — handed work in
     progress to QA. Only an explicit Submit clears this. */
  isDraft: true,
  createdAt: null,
  // Sent to DailyMattr with the post. Chosen here rather than inferred at
  // publish so the writer's wording survives.
  keywords: "",
  showTimestamp: true,
  videoCaption: "",         // burned into the clip, bottom-anchored
  videoCaptionSize: 40,     // design px at 920×1700; scaled per ratio
  secondLogoImage: null,
  tag: "none",       // "none" | "trending" | "breaking" | "swipe-video" (+ "-text" variants)
  tagImages: {},     // { trending: Image, breaking: Image } — SVG-backed tags only
  isDownloading: false,
  forceTextExport: false,
  imageSelectionNonce: 0,
  productImageAnalysis: null,
  // The signed-in account: { id, username, role, displayName }. Null until
  // /api/auth/me answers, and the gate keeps the editor hidden until then.
  user: null,

  /* ── Saved pix (Supabase) ──
     `pixId` is the row this editing session owns: null until the first save,
     then reused so a scrape → write → export sequence updates one row instead
     of leaving three. `article` keeps the last AI payload so the save does not
     have to scrape it back out of the DOM. */
  pixId: null,
  article: null,

  /* ── The row's standing, as the library reported it ──
     Read from the post when it is opened and otherwise left alone: none of
     these are editor content, and nothing here writes them back. They exist so
     the editor can refuse an action the server is going to refuse anyway —
     which matters because "the server will catch it" arrives AFTER a video
     encode and an upload that can take minutes, and because publishing is the
     one action in this app that cannot be undone.

     `publishedAt` set with `publishedId` null means an earlier publish was
     started and never confirmed: the story may or may not be live. Treated
     exactly like a confirmed publish here — the button stays shut either
     way — but the wording differs, because only one of the two has an id
     anyone can look up. */
  publishedAt: null,
  publishedId: null,
  /* The ids of earlier copies of this story that are still on the public site.
     Kept because a correction does not replace anything — it adds a second
     entry — so the only way to finish the job is to delete the superseded ones
     by hand in DailyMattr's portal, and that needs their ids. They were being
     recorded in published_history all along and shown nowhere. */
  publishedHistory: [],
  /* QA's sign-off. Read here so the editor knows the post's review is settled:
     an approved post is one DailyMattr has, or is about to be given, and a
     rewrite underneath it leaves the approval stamp pointing at text no
     reviewer saw. What it stops is chiefly the unattended write — autosave
     refuses to fire on an approved row (see considerAutosave). */
  approved: false,
  rejected: false,
  rejectedByName: "",

  // Uploads already pushed to storage, remembered against their exact source
  // so pressing Save repeatedly uploads once.
  storedImageFor: null,
  storedImageUrl: null,
  storedVideoFor: null,
  storedVideoUrl: null,
  // The last MP4 the server rendered, kept so Export then Save does not
  // encode the same range twice.
  renderedClip: null,
  // Set the moment the writer edits the headline or paragraph by hand, so the
  // AI writer landing later cannot overwrite it.
  headlineTouched: false,
  detailTouched: false,
  scrapedTitle: "",         // the headline as scraped, before the AI rewrite
  imageQuery: "",           // AI-picked image search query from the scrape
  sourceImageUrl: null,     // og:image of the source article

  /* ── Image filters (CSS-style values applied via ctx.filter) ── */
  filterBrightness: 100,    // 0–200 (100 = neutral)
  filterContrast:   100,    // 0–200
  filterSaturation: 100,    // 0–200
  filterBlur:       0,      // 0–20 px
  filterPreset:     "none", // identifier of the active preset chip, if any
};

// initAuth() is started at the BOTTOM of this file, not here.
//
// Its first statement is a synchronous setAuthState("checking", …), and that
// touches module bindings declared further down. `const`/`let` are not hoisted
// the way `function` is, so calling it from line ~301 threw
//   ReferenceError: Cannot access 'dailymattrMetaLoaded' before initialization
// on every load, leaving the app stuck on "Checking your session…" forever.
//
// Moving the CALL after every declaration fixes the whole class of problem:
// otherwise each new module-level binding added below this point and touched
// by setAuthState silently re-breaks startup.

// Build the ctx.filter string from current state values.
function buildFilterString() {
  return [
    `brightness(${state.filterBrightness}%)`,
    `contrast(${state.filterContrast}%)`,
    `saturate(${state.filterSaturation}%)`,
    `blur(${state.filterBlur}px)`,
  ].join(" ");
}

// Filter presets — pure value bundles, applied by clicking a chip.
const FILTER_PRESETS = {
  "none":    { brightness: 100, contrast: 100, saturation: 100, blur: 0 },
  "vivid":   { brightness: 105, contrast: 120, saturation: 145, blur: 0 },
  "bw":      { brightness: 105, contrast: 110, saturation: 0,   blur: 0 },
  "warm":    { brightness: 102, contrast: 108, saturation: 130, blur: 0 },
  "cool":    { brightness: 100, contrast: 110, saturation: 90,  blur: 0 },
  "faded":   { brightness: 108, contrast: 88,  saturation: 80,  blur: 0 },
  "soft":    { brightness: 105, contrast: 95,  saturation: 105, blur: 1 },
};

// Active layout preset (always read through this; never hard-code coords).
function getLayout() {
  return LAYOUT_PRESETS[state.aspectRatio] || LAYOUT_PRESETS["9:16"];
}

/* ── Highlight bracket syntax ──
   Users wrap words to highlight them. All three pairs are equivalent:
       [Modi]     (Modi)     {Modi}
   We expose a single character class that matches any of those six chars,
   so every place that strips/checks brackets goes through these. */
const HIGHLIGHT_OPEN_CHAR  = /[\[({]/;     // matches  [  (  {
const HIGHLIGHT_CLOSE_CHAR = /[\])}]/;     // matches  ]  )  }
const HIGHLIGHT_ANY_CHARS_GLOBAL = /[\[\](){}]/g;  // any bracket char, /g for replace

// Switch ratio: resize canvas, reset any pan that no longer makes sense, re-render.
function applyAspectRatio(ratio) {
  if (!LAYOUT_PRESETS[ratio]) return;
  state.aspectRatio = ratio;
  const L = LAYOUT_PRESETS[ratio];
  canvas.width = L.W;
  canvas.height = L.H;
  /* Reset image pan (positions vary too much across ratios to preserve).

     On EVERY page, not just the selected one. The ratio belongs to the post,
     so switching 9:16 to 16:9 reframes all of it — but this cleared only live
     state, leaving slides 2-5 panned for the old shape with their subjects
     half out of frame until each was selected and reset by hand. */
  state.imageOffset = { x: 0, y: 0 };
  for (const page of pages) {
    if (page.content && "imageOffset" in page.content) {
      page.content.imageOffset = { x: 0, y: 0 };
    }
  }
  if (typeof imgOffsetX !== "undefined") imgOffsetX.value = 0;
  if (typeof imgOffsetY !== "undefined") imgOffsetY.value = 0;
  // Update the size badge in the preview header
  const px = document.querySelector(".preview-pixels");
  if (px) px.textContent = `${L.W} × ${L.H}`;
  renderPoster();
}

/* ── Drag state (not part of poster state) ── */
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let dragOffsetStart = { x: 0, y: 0 };

const defaultMain = makeMainPlaceholder();

/* ── Load the real Pix logo ── */
const pixLogo = new Image();
pixLogo.src = "./assests/pix-logo.png?v=20260824";
pixLogo.onload = () => {
  state.logoImage = pixLogo;
  renderPoster();
};
pixLogo.onerror = () => {
  console.warn("Logo failed to load — using text fallback.");
};

// Alt logo used only when exporting for X downloads.
// PNG, square — same aspect ratio as Pix logo, so the existing slot scaler
// handles it identically (130×130 slot for X exports, see drawFixedLogos).
const shortlyLogo = new Image();
shortlyLogo.src = "./assests/shortly-logo.png";
shortlyLogo.onload = () => {
  state.shortlyLogoImage = shortlyLogo;
  renderPoster();
  console.log("✓ Shortly logo loaded — will be used for X exports");
};
shortlyLogo.onerror = () => {
  console.error("✗ Shortly logo failed to load from", shortlyLogo.src, "— X exports will fall back to Pix logo.");
};


/* ── Load tag SVGs ── */
const tagFiles = {
  "trending": "./assests/Trending.svg",
  "trending-text": "./assests/Trending without logo.svg",
  "breaking": "./assests/Braking.svg",
  "breaking-text": "./assests/Breaking without icon.svg"
};
Object.entries(tagFiles).forEach(([key, src]) => {
  const img = new Image();
  img.src = src;
  img.onload = () => { state.tagImages[key] = img; renderPoster(); };
});

/* ── Canvas-drawn tags ──
   Same 37px bar as the SVG tags above, but painted with ctx so the label uses
   the Poppins the page already loads instead of needing an outlined SVG. */
const TAG_BAR_HEIGHT = 37;   // matches the SVG tag assets
const TAG_PAD_X      = 12;   // side padding around the label
const TAG_ICON_BOX   = 22;   // the glyph is drawn inside this square
const TAG_ICON_GAP   = 10;   // space between glyph and label
const TAG_FONT       = "600 21px 'Poppins', 'Segoe UI', Arial, sans-serif";

// Brand blue, matching the headline accent.
const DRAWN_TAGS = {
  "swipe-video":      { label: "Swipe for Video", bg: "#3979FF", icon: true },
  "swipe-video-text": { label: "Swipe for Video", bg: "#3979FF", icon: false }
};

// Wait for both Poppins AND Roboto Serif fonts to load before first render
document.fonts.ready.then(async () => {
  // Ensure Roboto Serif is loaded for headline rendering, and Poppins for the
  // drawn tag badges — their width comes from measureText, so a fallback font
  // at first paint would size the bar wrong.
  try {
    await document.fonts.load("600 49px 'Roboto Serif'");
    await document.fonts.load(TAG_FONT);
  } catch (e) { /* font may already be loaded */ }
  await waitForImage(defaultMain);
  await ensureImageFocalPoint(defaultMain);
  renderPoster();
});

/* ── Events ── */

// Mode tab switching
const modeTabs = document.getElementById("mode-tabs");
const writeForm = document.getElementById("write-form");
const writeHeadline = document.getElementById("write-headline");
const writeDetail = document.getElementById("write-detail");
const writeApplyBtn = document.getElementById("write-apply-btn");
const writeStatus = document.getElementById("write-status");

modeTabs.addEventListener("click", (e) => {
  const tab = e.target.closest(".mode-tab");
  if (!tab) return;
  modeTabs.querySelectorAll(".mode-tab").forEach(t => t.classList.remove("active"));
  tab.classList.add("active");

  const mode = tab.dataset.mode;
  if (mode === "link") {
    scrapeForm.hidden = false;
    writeForm.hidden = true;
  } else {
    scrapeForm.hidden = true;
    writeForm.hidden = false;
  }
});

if (previewModeToggle) {
  previewModeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".preview-mode-btn");
    if (!btn) return;
    const mode = ["pix", "x", "text", "video"].includes(btn.dataset.previewMode) ? btn.dataset.previewMode : "pix";
    state.previewMode = mode;
    syncPreviewModeUI();
    // Video mode drives its own repaint loop while the clip plays.
    if (mode === "video") startVideoPreviewLoop(); else stopVideoPreviewLoop();
    if (mode === "text" && state.aspectRatio !== "9:16") {
      applyAspectRatio("9:16");
      return;
    }
    renderPoster();
  });
}

function setWriteStatus(message, type) {
  if (!writeStatus) return;
  writeStatus.textContent = message || "";
  writeStatus.className = "status-text";
  if (type) writeStatus.classList.add(type);
}

/* ── Sign in ──
   Pix has its own accounts. Two roles:
     writer — builds posts, saves them, and can re-open and re-save their own
     qa     — the same, plus editing and deleting everyone else's

   The gate covers the app until /api/auth/me answers, so a signed-out visitor
   never sees the editor. Every rule here is a convenience: the server applies
   the same ones to every request, and is the only place they are enforced. */

async function initAuth() {
  setAuthState("checking", "Checking your session…");
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (response.ok) {
      const payload = await response.json();
      applySession(payload.user);
      return;
    }
    const payload = await response.json().catch(() => ({}));
    // 503 means the database is unreachable — a different problem from being
    // signed out, and saying "sign in" would send the user round in circles.
    setAuthState("blocked", response.status === 503
      ? (payload.error || "Logins are unavailable right now.")
      : "Sign in to continue.");
  } catch {
    setAuthState("blocked", "Could not reach the server. Check your connection and try again.");
  }
}

/* ── DailyMattr publish panel ──
   Declared HERE, above applySession/setAuthState, because those two touch
   these bindings. They used to sit ~280 lines further down, which is a
   temporal dead zone: `const`/`let` are not hoisted like `function`, so the
   app died with "Cannot access 'dailymattrMetaLoaded' before initialization"
   and hung on the auth-checking screen.

   Not a race — initAuth()'s first statement is a SYNCHRONOUS setAuthState(),
   so it ran during module evaluation and threw on every single load, before
   any network call. See the note beside the state object. */
const dailymattrRefreshBtn = document.getElementById("dailymattr-refresh");
const dailymattrCategory = document.getElementById("dailymattr-category");
const dailymattrState = document.getElementById("dailymattr-state");
const dailymattrKeywords = document.getElementById("dailymattr-keywords");
const dailymattrContent = document.getElementById("dailymattr-content");
const dailymattrPublishBtn = document.getElementById("dailymattr-publish-btn");
const dailymattrStatus = document.getElementById("dailymattr-status");
const dailymattrMediaMode = document.getElementById("dailymattr-media-mode");
const dailymattrMediaInputs = [3, 4, 5].map((slot) => ({
  slot,
  input: document.getElementById(`dailymattr-media-${slot}`),
  name: document.getElementById(`dailymattr-media-name-${slot}`),
  card: document.querySelector(`[data-media-slot="${slot}"]`),
  remove: document.querySelector(`[data-remove-media="${slot}"]`),
}));

const DAILYMATTR_META_ENDPOINT = "/api/dailymattr/meta";
const DAILYMATTR_PUBLISH_ENDPOINT = "/api/dailymattr/publish";
const PIX_ANALYTICS_ENDPOINT = "/api/pix-analytics";
const DAILYMATTR_EXPORT_LONG_EDGES = [3840, 2560];
/* ── Compression for publishing ──
   Published slides go as JPEG, and go through a budget, not a fixed setting.

   A slide is a photograph with type over it, which is the case PNG is worst
   at: it stores every pixel losslessly and cannot use any of the redundancy a
   photo is full of. Measured on a real five-slide carousel, the poster alone
   came to 12.12 MB and the whole post to 42.32 MB. DailyMattr answers that
   with a bare "Validation Error" naming no field, so the size never appeared
   anywhere QA could see it — and a two-slide post went through while the same
   story as a carousel did not.

   A fixed quality would only move the guess: a busy photograph compresses far
   worse than a flat one, so the honest thing is to aim at a size and stop as
   soon as it is met. The ladder drops quality first, because at this
   resolution that is invisible, and only then drops resolution. The first rung
   already lands around 1 MB for a typical slide, so the usual cost of this is
   exactly one render — the rest is there for the slide that needs it.

   Downloads are untouched: a writer saving a poster still gets the exact PNG
   at full resolution. This applies only to what goes over the wire. */
function mbLabel(bytes) {
  return `${(Number(bytes || 0) / 1048576).toFixed(1)} MB`;
}

const DAILYMATTR_SLIDE_BUDGET_BYTES = 3 * 1024 * 1024;
/* Two limits, because they have two different remedies.

   The SLIDES budget covers what we render and can therefore compress — the
   JPEG cards. If those are heavy the answer is to compress harder or drop a
   slide, and the ladder above has usually already done the first.

   The CEILING covers the whole upload including video, and is deliberately
   far looser. A clip's size is inherent: it cannot be re-encoded in the
   browser, and the only real remedy is a shorter trim range. Counting a video
   against the slides budget was simply wrong — it blocked every video post
   with advice ("replace the heaviest picture") that does not apply to a video,
   and four video posts have published to DailyMattr successfully (buzz ids
   8281, 8375, 8386, 8429) with clips up to 32s, so the platform plainly
   accepts them. The ceiling matches the per-file cap the server already
   enforces, so this refuses only what could not have been sent anyway. */
const DAILYMATTR_SLIDES_BUDGET_BYTES = 20 * 1024 * 1024;
const DAILYMATTR_TOTAL_CEILING_BYTES = 64 * 1024 * 1024;
const DAILYMATTR_COMPRESSION_LADDER = [
  { longEdges: [3840], quality: 0.92 },
  { longEdges: [3840], quality: 0.82 },
  { longEdges: [2560], quality: 0.85 },
  { longEdges: [2560], quality: 0.72 },
  { longEdges: [1920], quality: 0.8 },
  { longEdges: [1920], quality: 0.65 },
];

/* Render a slide small enough to send, and say what it took.

   Returns the first rung that fits the budget. If nothing fits — a slide that
   is somehow enormous at 1920 — it returns the smallest it managed rather than
   nothing, because a slightly-over slide that the caller can weigh against the
   whole-post budget beats a failed publish with no explanation. */
async function exportSlideForPublish(mode, maxBytes = DAILYMATTR_SLIDE_BUDGET_BYTES) {
  let smallest = null;
  for (let rung = 0; rung < DAILYMATTR_COMPRESSION_LADDER.length; rung += 1) {
    const { longEdges, quality } = DAILYMATTR_COMPRESSION_LADDER[rung];
    const shot = await exportSlidePng(mode, longEdges, { type: "image/jpeg", quality });
    if (!shot?.blob) continue;
    if (!smallest || shot.blob.size < smallest.blob.size) smallest = { ...shot, rung, quality };
    if (shot.blob.size <= maxBytes) return { ...shot, rung, quality, withinBudget: true };
  }
  return smallest ? { ...smallest, withinBudget: false } : null;
}

/* An image QA attached by hand, squeezed the same way. A phone photo dropped
   into an extra slot is routinely 8-12 MB, which is the same failure arriving
   by a different door. Videos are passed through untouched — re-encoding one
   in the browser costs more than it saves, and the trim range already bounds
   it. */
async function compressAttachedImage(file, maxBytes = DAILYMATTR_SLIDE_BUDGET_BYTES) {
  if (!file || !/^image\//i.test(file.type) || file.size <= maxBytes) return file;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;   // undecodable here; let the server and DailyMattr judge it
  }
  try {
    for (const { longEdges, quality } of DAILYMATTR_COMPRESSION_LADDER) {
      const longest = Math.max(bitmap.width, bitmap.height);
      const scale = Math.min(1, longEdges[0] / longest);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => {
        try { canvas.toBlob(resolve, "image/jpeg", quality); } catch { resolve(null); }
      });
      if (blob && blob.size <= maxBytes) {
        const name = String(file.name || "attachment").replace(/\.[^.]+$/, "") + ".jpg";
        return new File([blob], name, { type: "image/jpeg" });
      }
    }
    return file;
  } finally {
    bitmap.close?.();
  }
}
// Must match MAX_DAILYMATTR_MEDIA_BYTES on the server. Checked on the client
// too so an oversized clip fails in a second with a useful message, rather
// than after uploading tens of megabytes only to be cut off by busboy.
const DAILYMATTR_MAX_MEDIA_BYTES = 64 * 1024 * 1024;
// DailyMattr accepts five media items per Buzz post, images and video mixed.
const DAILYMATTR_MAX_MEDIA_ITEMS = 5;
const dailymattrDraftTouched = { content: false, keywords: false, category: false, state: false };
let dailymattrMetaLoaded = false;
let analyticsLoadedForRole = "";

function isDailyMattrVideo(file) {
  return Boolean(file && /^video\/(mp4|quicktime)$/i.test(file.type));
}

function isDailyMattrImage(file) {
  return Boolean(file && /^image\/(jpeg|png|webp)$/i.test(file.type));
}

function dailyMattrExtraFiles() {
  return dailymattrMediaInputs
    .map(({ slot, input }) => ({ slot, file: input?.files?.[0] || null }))
    .filter(({ file }) => file);
}

function syncDailyMattrMediaCount() {
  if (!dailymattrMediaMode) return;
  dailymattrMediaMode.textContent = `${dailyMattrExtraFiles().length} / 3 added`;
  dailymattrMediaMode.className = "publish-mode";
}

function resetDailyMattrMediaSlot(item) {
  if (item.input) item.input.value = "";
  if (item.name) item.name.textContent = "Add image or video";
  if (item.card) item.card.classList.remove("has-file");
  if (item.remove) item.remove.hidden = true;
  syncDailyMattrMediaCount();
}

function resetDailyMattrExtraMedia() {
  dailymattrMediaInputs.forEach(resetDailyMattrMediaSlot);
}

function validateDailyMattrExtraFiles() {
  const extras = dailyMattrExtraFiles();
  for (const { slot, file } of extras) {
    if (!isDailyMattrImage(file) && !isDailyMattrVideo(file)) {
      return `Output ${slot} must be a JPG, PNG, WEBP, MP4 or MOV file.`;
    }
    if (file.size > DAILYMATTR_MAX_MEDIA_BYTES) {
      return `Output ${slot} is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${DAILYMATTR_MAX_MEDIA_BYTES / 1048576} MB per file.`;
    }
  }
  return "";
}

/* Capability checks, so a new role does not mean hunting every `=== "qa"`
   in the file. An admin is a superset of QA. */
function roleLabel(role) {
  return role === "admin" ? "Admin" : role === "qa" ? "QA" : "Writer";
}

function canReviewRole(role) { return role === "qa" || role === "admin"; }
function isAdminRole(role) { return role === "admin"; }

/* ── Your own count, in the header ──

   Every role sees a number for their own work. A writer sees how many stories
   they have written, a reviewer how many they have cleared — the question each
   one actually asks about themselves. Analytics answers this for QA and admins
   only, because it reports across the whole team; a writer's own output is not
   management reporting and should not have been behind that gate.

   Weekly leads, with the all-time total behind it, matching how the roster
   counts read elsewhere so the two never tell different stories. */
const accountCount = document.getElementById("account-count");

async function refreshMyPixCount() {
  if (!accountCount) return;
  if (!state.user) {
    accountCount.hidden = true;
    return;
  }
  try {
    const response = await fetch("/api/pix/stats", { credentials: "same-origin" });
    if (!response.ok) {
      accountCount.hidden = true;
      return;
    }
    const { counts } = await response.json();
    // Kept so the review tiles can show today/this-week without refetching.
    lastPixCounts = counts || null;
    if (!counts) {
      accountCount.hidden = true;
      return;
    }
    const reviewer = canReviewRole(state.user.role);
    /* A reviewer is measured by what they PUBLISHED, not by verdicts given.
       Approving and publishing are different acts — a reviewer can clear a
       queue and send none of it — and "how many did I publish" is the
       question they actually ask about their own day. Reviewed stays in the
       tooltip: it is the bigger number and the one with full history, whereas
       published is only accurate from the ledger forward. */
    const today = reviewer ? counts.published_today : counts.written_today;
    const week  = reviewer ? counts.published_week  : counts.written_week;
    const total = reviewer ? counts.published_total : counts.written_total;
    /* "submitted", not "written": the tally counts posts that were handed
       over, and drafts are deliberately outside it — they are unfinished work,
       and counting them made the chip read one higher than anything the writer
       could point at in a list. Their drafts are still theirs to find, under
       My posts. */
    const noun = reviewer ? "published" : "submitted";
    /* Both numbers, because they answer different questions: today is "am I
       on track", the week is "how am I doing". These count POSTS, not saves —
       reopening a pix and editing it never moves them, which is the whole
       point of a per-writer tally. */
    accountCount.innerHTML =
      `<strong>${today}</strong>&nbsp;today <span class="nav-count-sep">·</span> <strong>${week}</strong>&nbsp;this week`;
    accountCount.title = reviewer
      ? `${today} published today · ${week} in the last 7 days · ${total} since the publish ledger began`
        + `
${counts.reviewed_total} reviewed in total (approved or rejected — full history)`
        /* Only when they write. A reviewer who never does should not be shown
           a zero they have to work out the meaning of. */
        + (Number(counts.written_total)
            ? `
${counts.written_today} written by you today · ${counts.written_total} in total`
            : "")
      : `${today} submitted today · ${week} in the last 7 days · ${total} all time`;
    // Pulse only on an actual change, so it reads as "that went up" rather
    // than as an animation that fires on every poll.
    if (accountCount.dataset.week !== String(week) && accountCount.dataset.week !== undefined) {
      accountCount.classList.remove("just-changed");
      void accountCount.offsetWidth;                       // restart the animation
      accountCount.classList.add("just-changed");
    }
    accountCount.dataset.week = String(week);
    accountCount.hidden = false;
  } catch {
    // A header ornament must never be the thing that breaks sign-in.
    accountCount.hidden = true;
  }
}

function applySession(user) {
  state.user = user || null;
  document.body.dataset.role = user?.role || "";
  if (accountName) accountName.textContent = user?.displayName || user?.username || "—";
  if (accountRole) {
    // The badge names the role, it does not test a capability — an admin
    // showing "QA" here is simply wrong, however similar their powers are.
    accountRole.textContent = roleLabel(user?.role);
    accountRole.classList.toggle("is-qa", canReviewRole(user?.role));
    accountRole.classList.toggle("is-admin", isAdminRole(user?.role));
  }
  if (accountBox) accountBox.hidden = !user;
  if (logoutBtn) logoutBtn.hidden = !user;
  refreshMyPixCount();
  syncPrimaryAction();
  setAuthState(user ? "ready" : "blocked", user ? "" : "Sign in to continue.");
  // The mobile editor sheet must not open until the auth gate is gone. Opening
  // it during module setup puts its fixed backdrop above the sign-in card.
  if (user && isMobile()) setSheetOpen(true);
  syncReviewCopy();
  // Publishing to shortlyindia.com is QA-only (the server returns 403 for
  // writers). Hide the panel rather than showing controls that cannot work,
  // and don't spend a DailyMattr round-trip loading options a writer can
  // never use.
  syncDailyMattrAccess();
  // Required/conditional section UI must update immediately on role change;
  // loading the live option lists can finish later or fail independently.
  syncSectionInputs();
  if (canReviewRole(user?.role)) loadDailyMattrMeta({ force: true });
  // Writers need the lists too, to file their own story.
  if (user) loadSectionOptions();
  // Whoever just signed in gets their own list, not the previous user's.
  if (user && document.body.classList.contains("view-review")) loadReviewQueue();
  if (user && document.body.classList.contains("view-analytics")) {
    // A writer signing in on the analytics view has no analytics to see.
    if (canReviewRole(user.role)) loadAnalytics({ force: true });
    else setView("poster");
  }
}

function setAuthState(status, message) {
  document.body.classList.remove("auth-checking", "auth-ready", "auth-blocked");
  document.body.classList.add(status === "ready" ? "auth-ready" : status === "blocked" ? "auth-blocked" : "auth-checking");
  if (status !== "ready") document.body.classList.remove("sheet-open");
  if (authMessage) authMessage.textContent = message || "";
  if (authGate) authGate.hidden = status === "ready";
  if (loginForm) loginForm.hidden = status !== "blocked";
  if (status !== "ready") {
    state.user = null;
    document.body.dataset.role = "";
    if (accountBox) accountBox.hidden = true;
    if (logoutBtn) logoutBtn.hidden = true;
    analyticsLoadedForRole = "";
    dailymattrMetaLoaded = false;
    syncDailyMattrAccess();
    fillSelectOptions(dailymattrCategory, [], "Sign in to load categories");
    fillSelectOptions(dailymattrState, [], "Optional");
    setDailyMattrStatus("");
    setAnalyticsStatus("");
  }
  if (status === "blocked" && loginUsername) {
    // Focus only once the form is actually on screen.
    requestAnimationFrame(() => loginUsername.focus());
  }
}

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = loginUsername.value.trim();
    const password = loginPassword.value;
    if (!username || !password) {
      if (authMessage) authMessage.textContent = "Enter your username and password.";
      return;
    }

    loginSubmit.disabled = true;
    loginSubmit.textContent = "Signing in…";
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (authMessage) authMessage.textContent = payload.error || "Sign in failed.";
        loginPassword.value = "";
        loginPassword.focus();
        return;
      }
      loginPassword.value = "";
      applySession(payload.user);
    } catch {
      if (authMessage) authMessage.textContent = "Could not reach the server.";
    } finally {
      loginSubmit.disabled = false;
      loginSubmit.textContent = "Sign in";
    }
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch { /* the cookie is cleared server-side; a failure here is cosmetic */ }
    // Reload rather than tear the editor down by hand: it drops every scrap of
    // the previous user's work from memory, which is what signing out means.
    window.location.reload();
  });
}

/** True when this user may write to `post` (a library row). */
function canEditPost(post) {
  if (!state.user) return false;
  if (canReviewRole(state.user.role)) return true;
  return !post?.user_login_id || post.user_login_id === state.user.id;
}

function resetImageControls() {
  state.imageOffset = { x: 0, y: 0 };
  state.imageZoom = 100;
  imgOffsetX.value = 0;
  imgOffsetY.value = 0;
  imgZoom.value = 100;
}

/* The page a pending image pick belongs to.

   The nonce alone answers "is this still the picture the writer wants"; it
   does not answer "which slide did they want it ON". setActivePage never
   bumps the nonce, so clicking another card mid-fetch left the arriving photo
   to land on whatever slide was then selected — replacing its picture, while
   the slide the pick was made for stayed empty. */
let imageSelectionOwner = null;

function claimImageSelection() {
  state.imageSelectionNonce += 1;
  imageSelectionOwner = activePage();
  return state.imageSelectionNonce;
}

/* An image that arrived for a page the writer has since left. Files it on that
   page and reports true, so the caller skips the live path entirely rather
   than writing someone else's slide. */
function stashImageForAbsentPage(page, img) {
  if (!page || activePage() === page) return false;
  if (!page.content) page.content = {};
  page.content.mainImage = img;
  // A fresh picture is unframed, matching resetImageControls() on the live path.
  page.content.imageOffset = { x: 0, y: 0 };
  page.content.imageZoom = 100;
  renderPoster();
  return true;
}

function isXRenderMode() {
  return state.useShortlyLogo || (!state.isDownloading && state.previewMode === "x");
}

function isTextPreviewMode() {
  return state.previewMode === "text" && (!state.isDownloading || state.forceTextExport);
}

function isStoryPreviewMode() {
  return state.previewMode === "story";
}

// True while painting the video slide. `videoOverlayExport` is set only by
// renderVideoOverlayPng(), which needs the branding layer on transparency
// with no video frame and no mockup chrome underneath it.
function isVideoPreviewMode() {
  return state.previewMode === "video" || state.videoOverlayExport;
}

function syncPreviewModeUI() {
  if (!previewModeToggle) return;
  previewModeToggle.querySelectorAll(".preview-mode-btn").forEach((btn) => {
    const active = btn.dataset.previewMode === state.previewMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  });
  updatePrimaryDownloadButton();
}

function updatePrimaryDownloadButton() {
  // Update only the label span — the button also contains an SVG icon that
  // textContent assignment on the button itself would wipe out.
  const label = document.getElementById("download-btn-label");
  if (label) label.textContent = "Download Poster";
}

updatePrimaryDownloadButton();

function buildFallbackImageSuggestions(searchQuery, count = 6) {
  const words = searchQuery
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  const label = (words.join(" ") || "news").toUpperCase();
  const palettes = [
    ["#0f172a", "#7c3aed", "#22d3ee"],
    ["#111827", "#ef4444", "#f59e0b"],
    ["#082f49", "#14b8a6", "#eab308"],
    ["#18181b", "#e11d48", "#a3e635"],
    ["#1e1b4b", "#2563eb", "#f97316"],
    ["#052e16", "#16a34a", "#38bdf8"],
  ];

  return Array.from({ length: count }, (_, index) => {
    const [base, accent, glow] = palettes[index % palettes.length];
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1800" viewBox="0 0 1200 1800">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="${base}"/>
            <stop offset="58%" stop-color="#050505"/>
            <stop offset="100%" stop-color="${accent}"/>
          </linearGradient>
          <radialGradient id="g1" cx="${20 + index * 11}%" cy="${18 + index * 7}%" r="58%">
            <stop offset="0%" stop-color="${glow}" stop-opacity="0.72"/>
            <stop offset="100%" stop-color="${glow}" stop-opacity="0"/>
          </radialGradient>
          <filter id="blur"><feGaussianBlur stdDeviation="36"/></filter>
        </defs>
        <rect width="1200" height="1800" fill="url(#bg)"/>
        <circle cx="${260 + index * 120}" cy="${260 + index * 95}" r="360" fill="url(#g1)" filter="url(#blur)"/>
        <circle cx="${940 - index * 70}" cy="${1120 + index * 46}" r="420" fill="${accent}" opacity="0.22" filter="url(#blur)"/>
        <g opacity="0.22" stroke="#fff" stroke-width="2">
          ${Array.from({ length: 18 }, (_, line) => `<path d="M${line * 84 - 220} 0 L${line * 84 + 520} 1800"/>`).join("")}
        </g>
        <text x="88" y="220" fill="#fff" opacity="0.22" font-family="Arial, sans-serif" font-size="64" font-weight="800">${escapeSvgText(label)}</text>
      </svg>
    `;
    const imageUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    return {
      id: `fallback-${index + 1}`,
      alt: `${searchQuery} related image`,
      preview: imageUrl,
      image: imageUrl,
      imageProxy: imageUrl,
      source: "fallback",
    };
  });
}

function escapeSvgText(value) {
  return value.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  }[ch]));
}

// Write mode — build poster from manual text
writeApplyBtn.addEventListener("click", async () => {
  const text = writeHeadline.value.trim();
  if (!text) return;
  // Slide 2 is NOT a reprint of slide 1. Falling back to the headline here
  // put the same sentence on both cards, which is the "text paragraph shows
  // the headline" bug and also what the editorial spec forbids.
  const detail = writeDetail.value.trim();

  // Building from hand-written text is a new post, not an edit of whatever
  // was scraped before it. Without this the save would write the new headline
  // onto the previous story's row — keeping its source URL and article text,
  // which now describe something else entirely.
  startNewPix();

  state.headline = text;
  state.detailText = limitDetailTextClient(detail);
  headlineEdit.value = text;
  if (detailEdit) detailEdit.value = state.detailText;
  editPanel.hidden = false;
  imagePanel.hidden = false;
  renderPoster();
  scrollPreviewIntoViewIfMobile();
  closeSheetIfMobile();

  writeApplyBtn.disabled = true;
  setWriteStatus("Finding matching images...");
  await fetchStockImages(text, {
    autoApplyRandom: true,
    onStatus: setWriteStatus,
  });
  writeApplyBtn.disabled = false;
});

// Live sync: write-headline → headline-edit → poster
writeHeadline.addEventListener("input", () => {
  state.headline = writeHeadline.value;
  state.headlineTouched = true;
  headlineEdit.value = writeHeadline.value;
  setWriteStatus("");
  renderPoster();
});

writeDetail.addEventListener("input", (event) => {
  const text = event.inputType === "insertLineBreak" ? formatDetailBulletField(writeDetail) : writeDetail.value;
  state.detailText = limitDetailTextClient(text);
  state.detailTouched = true;
  if (detailEdit) detailEdit.value = state.detailText;
  setWriteStatus("");
  renderPoster();
});
writeDetail.addEventListener("keydown", handleDetailBulletEnter);

scrapeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await runScrape();
});

// On mobile, after a Build, scroll the preview into view so the user
// gets visual confirmation without having to scroll up.
function scrollPreviewIntoViewIfMobile() {
  if (window.matchMedia("(max-width: 760px)").matches) {
    const previewPanel = document.querySelector(".preview-panel");
    if (previewPanel) {
      // Use rAF so the DOM has settled (panels may have just become visible).
      requestAnimationFrame(() => {
        previewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }
}

/* ── Download for X ── */
const xDownloadBtn = document.getElementById("x-download-btn");
const xDownloadStatus = document.getElementById("x-download-status");

function setPostStatus(msg, kind) {
  if (!xDownloadStatus) return;
  xDownloadStatus.className = "status-text" + (kind ? ` ${kind}` : "");
  xDownloadStatus.textContent = "";
  if (msg) xDownloadStatus.append(msg);
}

/* Show the publish panel to review roles only. This is presentation, not the
   control: the server applies the same capability check because a hidden
   button is not a permission. */
function syncDailyMattrAccess() {
  const panel = document.getElementById("dailymattr-panel");
  if (panel) panel.hidden = !canReviewRole(state.user?.role);
}

function setDailyMattrStatus(message, kind) {
  if (!dailymattrStatus) return;
  dailymattrStatus.className = "status-text" + (kind ? ` ${kind}` : "");
  dailymattrStatus.textContent = message || "";
}

function cleanHeadlineForPublish(value) {
  return String(value || "").replace(HIGHLIGHT_ANY_CHARS_GLOBAL, "").replace(/\s+/g, " ").trim();
}

function inferDailyMattrKeywords() {
  const raw = [
    state.imageQuery,
    state.tag && state.tag !== "none" ? state.tag.replace(/-/g, " ") : "",
    cleanHeadlineForPublish(state.headline),
  ].filter(Boolean).join(" ");

  const words = raw.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const seen = new Set();
  const stop = new Set(["with", "from", "that", "this", "have", "will", "into", "about", "after", "before", "their", "where", "which", "while"]);
  const picked = [];
  for (const word of words) {
    if (stop.has(word) || seen.has(word)) continue;
    seen.add(word);
    picked.push(word);
    if (picked.length >= 6) break;
  }
  return picked.join(", ");
}

function defaultDailyMattrContent() {
  const headline = cleanHeadlineForPublish(state.headline);
  const detail = normalizeDetailTextClient(state.detailText || "");
  if (!headline) return "";
  return detail ? `${headline}\n\n${detail}`.trim() : headline;
}

function syncDailyMattrDraft({ force = false } = {}) {
  if (dailymattrContent && (!dailymattrDraftTouched.content || force)) {
    dailymattrContent.value = defaultDailyMattrContent();
  }
  if (dailymattrKeywords && (!dailymattrDraftTouched.keywords || force)) {
    // The writer's own keywords win over a guess from the headline.
    dailymattrKeywords.value = (state.keywords || "").trim() || inferDailyMattrKeywords();
  }
}

function fillSelectOptions(selectEl, items, placeholder) {
  if (!selectEl) return;
  selectEl.innerHTML = "";
  const first = document.createElement("option");
  first.value = "";
  first.textContent = placeholder;
  selectEl.appendChild(first);
  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = String(item.id);
    option.textContent = item.name || String(item.id);
    selectEl.appendChild(option);
  });
}

// Crop the canvas vertically to where the last non-black pixel lives, so the
// exported PNG doesn't ship the trailing black gradient gap below the headline.
// `paddingBelow`: extra px to keep below the last content row (breathing room).
// `minHeight`:   never crop above this height (avoids ugly squares for short headlines).
function exportCanvasCroppedToContent(srcCanvas, { paddingBelow = 32, minHeight = 1100 } = {}) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const sctx = srcCanvas.getContext("2d");

  // Pull the bottom 60% of the canvas in ONE getImageData call (fast).
  // 60% covers the gradient + headline area; we won't have content above that.
  const scanStart = Math.max(0, Math.floor(h * 0.4));
  const scanH = h - scanStart;
  let lastContentY = h;
  try {
    const data = sctx.getImageData(0, scanStart, w, scanH).data;
    const rowBytes = w * 4;
    const THRESHOLD = 12;  // RGB channel value above which we call it "content"

    // Scan rows bottom-up; first row with any non-black pixel = content end
    outer:
    for (let row = scanH - 1; row >= 0; row--) {
      const rowOffset = row * rowBytes;
      for (let col = 0; col < rowBytes; col += 4) {
        if (
          data[rowOffset + col]     > THRESHOLD ||
          data[rowOffset + col + 1] > THRESHOLD ||
          data[rowOffset + col + 2] > THRESHOLD
        ) {
          lastContentY = scanStart + row + 1;
          break outer;
        }
      }
    }
  } catch (e) {
    // CORS taint or similar — bail out and just use the full canvas
    console.warn("Crop scan failed, exporting full canvas:", e);
    return srcCanvas;
  }

  // Compute final crop height with padding + min-height clamp + max bound
  const cropH = Math.max(minHeight, Math.min(h, lastContentY + paddingBelow));
  if (cropH >= h) return srcCanvas;  // nothing to crop

  const out = document.createElement("canvas");
  out.width = w;
  out.height = cropH;
  out.getContext("2d").drawImage(srcCanvas, 0, 0, w, cropH, 0, 0, w, cropH);
  return out;
}

// Returns { caption, source: "ai" | "fallback", error? }
async function fetchAiCaption(headline, timeoutMs = 12000) {
  const fallback = headline.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, "").trim().slice(0, 280);
  if (!headline.trim()) return { caption: fallback, source: "fallback", error: "empty headline" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch("/api/generate-caption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headline }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try { const j = await resp.json(); detail = j.error || detail; } catch {}
      console.error("[AI caption] server returned:", detail);
      return { caption: fallback, source: "fallback", error: detail };
    }
    const data = await resp.json();
    const c = (data?.caption || "").trim();
    if (!c) return { caption: fallback, source: "fallback", error: "empty AI response" };
    console.log("[AI caption] success:", c);
    return { caption: c, source: "ai" };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : (e?.message || String(e));
    console.error("[AI caption] fetch failed:", msg);
    return { caption: fallback, source: "fallback", error: msg };
  }
}

function downloadXPreview({ usePrimaryButton = false } = {}) {
  /* The X card is pinned to the base page — it is not in slotOrder and shows
     the post's own poster whatever is selected. The export did not say so:
     it snapshotted the render MODE but not the SELECTION, so pressing Download
     on the X card while a story or a second poster page was selected rendered
     THAT page instead. The PNG carried the wrong picture, or none, and for a
     second poster page the wrong headline and tag — silently, since it looks
     like a normal download.

     The headline test has to read the base page too, or a Story page (which
     owns no headline) makes this refuse a post that has one. */
  const baseHeadline = (basePageView().headline || "").trim();
  if (!baseHeadline) {
    setPostStatus("Build a poster first.", "error");
    return;
  }

  const targetButton = usePrimaryButton ? downloadButton : xDownloadBtn;
  if (targetButton) targetButton.disabled = true;
  setPostStatus("Preparing X download...");

  // Explicitly own the render mode so a stale "text" preview / forceTextExport
  // can never leak the text image into the X export. Restore the user's
  // on-screen preview mode afterwards.
  const prevMode = state.previewMode;
  const prevDownloading = state.isDownloading;
  const prevShortly = state.useShortlyLogo;
  const prevForceText = state.forceTextExport;
  /* Render the page the X card actually shows. syncActivePageContent() first,
     so the selected page's edits are filed before the selection moves. */
  syncActivePageContent();
  const restorePageId = activePageId;
  setActivePage("base", { force: true });

  state.isDownloading = true;
  state.useShortlyLogo = true;
  state.forceTextExport = false;
  state.previewMode = "x";

  const restore = () => {
    /* Back to what they WERE, not to hard-coded defaults. Writing `false`
       here meant an export that overlapped another one restored the wrong
       thing permanently — the whole rail losing its engagement bars and
       drawing the Shortly logo until the page was reloaded. */
    state.isDownloading = prevDownloading;
    state.useShortlyLogo = prevShortly;
    state.forceTextExport = prevForceText;
    state.previewMode = prevMode;
    setActivePage(restorePageId, { force: true });
    renderPoster();
    if (targetButton) targetButton.disabled = false;
  };

  try {
    const exportCanvas = renderToHighResCanvas(X_EXPORT_SCALE);
    const cropped = exportCanvasCroppedToContent(exportCanvas, {
      paddingBelow: 36   * X_EXPORT_SCALE,
      minHeight:    1100 * X_EXPORT_SCALE,
    });

    cropped.toBlob((blob) => {
      restore();
      if (!blob) {
        setPostStatus("Couldn't render image.", "error");
        return;
      }
      const blobUrl = URL.createObjectURL(blob);
      const dl = document.createElement("a");
      dl.href = blobUrl;
      dl.download = `${slugify(baseHeadline || "pix-post")}-x.png`;
      dl.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      setPostStatus("X-ready PNG downloaded.", "success");
    }, "image/png");
  } catch (error) {
    restore();
    setPostStatus("Couldn't render X download.", "error");
    console.error("X download failed:", error);
  }
}

if (xDownloadBtn) xDownloadBtn.addEventListener("click", () => {
  downloadXPreview();
});

async function downloadTextPreview() {
  const headline = (state.headline || "").trim();
  if (!headline && !getDetailTextForPreview().trim()) {
    setPostStatus("Build a poster first.", "error");
    return;
  }

  if (textDownloadButton) textDownloadButton.disabled = true;
  setPostStatus("Rendering high-resolution text image…");

  const previousMode = state.previewMode;
  state.isDownloading = true;
  state.forceTextExport = true;
  state.previewMode = "text";

  let result = null;
  try {
    result = await renderExportBlob();
  } catch (error) {
    console.error("Text download failed:", error);
  } finally {
    state.isDownloading = false;
    state.forceTextExport = false;
    state.previewMode = previousMode;
    renderPoster();
    if (textDownloadButton) textDownloadButton.disabled = false;
  }

  if (!result) {
    setPostStatus("Couldn't render text image.", "error");
    return;
  }
  const blobUrl = URL.createObjectURL(result.blob);
  const dl = document.createElement("a");
  dl.href = blobUrl;
  dl.download = `${slugify(headline || "pix-post")}-text.png`;
  dl.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  setPostStatus(`Text PNG downloaded (${result.width}×${result.height}).`, "success");
}

if (textDownloadButton) textDownloadButton.addEventListener("click", () => {
  downloadTextPreview();
});

// The single "Download Poster" button is gone — each card owns its export
// now. This block is kept behind a guard so an older markup revision (or a
// cached page) still works rather than throwing at load.
if (downloadButton) downloadButton.addEventListener("click", async () => {
  // Clean export (no preview overlays). The export happens entirely on an
  // offscreen canvas via renderExportBlob (8K→6K→4K fallback), so the
  // on-screen preview never changes; we restore state + re-render after.
  downloadButton.disabled = true;
  setStatus("Rendering high-resolution poster…");

  // Explicitly own the render mode → always the Pix poster, never text/X,
  // regardless of the current preview toggle or leftover flags.
  const prevMode = state.previewMode;
  state.isDownloading = true;
  state.forceTextExport = false;
  state.useShortlyLogo = false;
  state.previewMode = "pix";

  let result = null;
  try {
    result = await renderExportBlob();
  } catch (err) {
    console.error("Download failed:", err);
  } finally {
    state.isDownloading = false;
    state.previewMode = prevMode;
    renderPoster();  // Restore preview
    downloadButton.disabled = false;
  }

  if (!result) {
    setStatus("Failed to generate high-resolution export.", "error");
    return;
  }
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(state.headline || "pix-post")}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Poster downloaded (${result.width}×${result.height}).`, "success");
});

// Headline live edit
headlineEdit.addEventListener("input", () => {
  state.headline = headlineEdit.value;
  state.headlineTouched = true;
  writeHeadline.value = headlineEdit.value;
  // Editing the headline used to overwrite the paragraph whenever a
  // heuristic guessed the paragraph "was" the headline. The guess misfired,
  // silently replacing real bullet copy. The two fields are independent now.
  renderPoster();
});

if (detailEdit) {
  detailEdit.addEventListener("input", (event) => {
    const text = event.inputType === "insertLineBreak" ? formatDetailBulletField(detailEdit) : detailEdit.value;
    state.detailText = limitDetailTextClient(text);
    state.detailTouched = true;
    writeDetail.value = state.detailText;
    renderPoster();
  });
  detailEdit.addEventListener("keydown", handleDetailBulletEnter);
}

/* Story copy writes to live state; syncActivePageContent folds it back onto
   the page on the next read, which is the same route every page-scoped field
   takes. */
document.getElementById("story-heading-edit")?.addEventListener("input", (e) => {
  state.storyHeading = e.target.value;
  renderPoster();
});
document.getElementById("story-body-edit")?.addEventListener("input", (e) => {
  state.storyBody = e.target.value;
  renderPoster();
});

storyOverlayOpacityInput?.addEventListener("input", (event) => {
  if (activePage()?.type !== "story") return;
  state.storyOverlayOpacity = clamp(Number(event.target.value), 0, 100);
  renderPoster();
});

// Image offset sliders
imgOffsetX.addEventListener("input", () => {
  state.imageOffset.x = Number(imgOffsetX.value);
  renderPoster();
});

imgOffsetY.addEventListener("input", () => {
  state.imageOffset.y = Number(imgOffsetY.value);
  renderPoster();
});

imgResetBtn.addEventListener("click", () => {
  // Pan + zoom reset
  state.imageOffset = { x: 0, y: 0 };
  state.imageZoom = 100;
  imgOffsetX.value = 0;
  imgOffsetY.value = 0;
  imgZoom.value = 100;
  if (activePage()?.type === "story") {
    state.storyOverlayOpacity = 100;
    syncControl(storyOverlayOpacityInput, 100);
  }

  // Filters reset
  applyFilterPreset("none");

  renderPoster();
});

/* ── Filters ── */
const filterBrightnessInput = document.getElementById("filter-brightness");
const filterContrastInput   = document.getElementById("filter-contrast");
const filterSaturationInput = document.getElementById("filter-saturation");
const filterBlurInput       = document.getElementById("filter-blur");
const filterPresetsContainer = document.getElementById("filter-presets");

function syncFilterUI() {
  if (filterBrightnessInput) filterBrightnessInput.value = state.filterBrightness;
  if (filterContrastInput)   filterContrastInput.value   = state.filterContrast;
  if (filterSaturationInput) filterSaturationInput.value = state.filterSaturation;
  if (filterBlurInput)       filterBlurInput.value       = state.filterBlur;
  if (filterPresetsContainer) {
    filterPresetsContainer.querySelectorAll(".preset-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.filter === state.filterPreset);
    });
  }
}

function applyFilterPreset(name) {
  const p = FILTER_PRESETS[name] || FILTER_PRESETS["none"];
  state.filterBrightness = p.brightness;
  state.filterContrast   = p.contrast;
  state.filterSaturation = p.saturation;
  state.filterBlur       = p.blur;
  state.filterPreset     = name;
  syncFilterUI();
  // Reflect in the collapsed accordion header pill
  const meta = document.getElementById("acc-meta-filter");
  if (meta) {
    const labels = { none:"None", vivid:"Vivid", bw:"B&W", warm:"Warm", cool:"Cool", faded:"Faded", soft:"Soft", custom:"Custom" };
    meta.textContent = labels[name] || "";
  }
}

[
  [filterBrightnessInput, "filterBrightness"],
  [filterContrastInput,   "filterContrast"],
  [filterSaturationInput, "filterSaturation"],
  [filterBlurInput,       "filterBlur"],
].forEach(([el, key]) => {
  if (!el) return;
  el.addEventListener("input", () => {
    state[key] = Number(el.value);
    // Manual edit means it's no longer a known preset — clear active chip
    state.filterPreset = "custom";
    if (filterPresetsContainer) {
      filterPresetsContainer.querySelectorAll(".preset-btn")
        .forEach(b => b.classList.remove("active"));
    }
    const meta = document.getElementById("acc-meta-filter");
    if (meta) meta.textContent = "Custom";
    renderPoster();
  });
});

if (filterPresetsContainer) {
  filterPresetsContainer.addEventListener("click", (e) => {
    const btn = e.target.closest(".preset-btn");
    if (!btn) return;
    applyFilterPreset(btn.dataset.filter);
    renderPoster();
  });
}

// Zoom slider
/* ── Zoom ──
   The range input remains the single source of truth for the value — page
   restore, syncControl and the drag handler all read img-zoom.value — but it
   is hidden and driven by − / + instead. Everything routes through applyZoom()
   so the buttons, a restore and any future caller cannot drift apart. */
const imgZoomOut = document.getElementById("img-zoom-out");
const imgZoomIn = document.getElementById("img-zoom-in");
const imgZoomValue = document.getElementById("img-zoom-value");

/* Called from renderPoster rather than from each of the four places that write
   img-zoom.value. Zoom is a render input by definition, so anything that
   changes it must re-render or the poster itself would be stale — which makes
   the readout provably agree with what is on screen, including restores that
   set .value directly (a programmatic write fires no "input" event).
   Elements are looked up lazily: renderPoster can run during boot, before the
   consts above are initialised, and reading one then would throw on the TDZ. */
let zoomReadoutShown = null;
function syncZoomReadout() {
  const z = Math.round(Number(imgZoom.value) || 100);
  if (z === zoomReadoutShown) return;
  zoomReadoutShown = z;
  const out = document.getElementById("img-zoom-value");
  const minus = document.getElementById("img-zoom-out");
  const plus = document.getElementById("img-zoom-in");
  if (out) {
    out.textContent = `${z}%`;
    // The readout is also the reset, so it is inert at 100 — nothing to undo.
    out.disabled = z === 100;
  }
  if (minus) minus.disabled = z <= ZOOM_MIN;
  if (plus) plus.disabled = z >= ZOOM_MAX;
}

function applyZoom(next) {
  const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(Number(next) || 100)));
  /* Zooming OUT re-centres. A pan set while zoomed in can leave the picture
     off-canvas entirely once it shrinks, and hunting it back with two more
     sliders is worse than starting from the middle. */
  if (clamped < state.imageZoom) {
    state.imageOffset = { x: 0, y: 0 };
    imgOffsetX.value = 0;
    imgOffsetY.value = 0;
  }
  state.imageZoom = clamped;
  imgZoom.value = String(clamped);
  syncZoomReadout();
  renderPoster();
}

imgZoom.addEventListener("input", () => applyZoom(imgZoom.value));
imgZoomOut?.addEventListener("click", () => applyZoom(Number(imgZoom.value) - ZOOM_STEP));
imgZoomIn?.addEventListener("click", () => applyZoom(Number(imgZoom.value) + ZOOM_STEP));
imgZoomValue?.addEventListener("click", () => applyZoom(100));

/* Press-and-hold to run, so crossing the range does not take forty clicks. */
[[imgZoomOut, -ZOOM_STEP], [imgZoomIn, ZOOM_STEP]].forEach(([btn, delta]) => {
  if (!btn) return;
  let hold = null;
  let repeat = null;
  const stop = () => { clearTimeout(hold); clearInterval(repeat); hold = null; repeat = null; };
  btn.addEventListener("pointerdown", () => {
    hold = setTimeout(() => {
      repeat = setInterval(() => {
        if (btn.disabled) return stop();
        applyZoom(Number(imgZoom.value) + delta);
      }, 70);
    }, 400);
  });
  ["pointerup", "pointerleave", "pointercancel", "blur"].forEach((ev) => btn.addEventListener(ev, stop));
});

// Font size slider (0 = auto)
fontSizeInput.addEventListener("input", () => {
  state.fontSize = Number(fontSizeInput.value);
  renderPoster();
});

// Accent color picker
accentColorInput.addEventListener("input", () => {
  state.accent = accentColorInput.value;
  accentHexLabel.textContent = accentColorInput.value.toUpperCase();
  document.querySelector('.color-circle').style.borderColor = state.accent;
  renderPoster();
});

// Tag presets
tagPresetsContainer.addEventListener("click", (e) => {
  const btn = e.target.closest(".preset-btn");
  if (!btn) return;
  tagPresetsContainer.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  state.tag = btn.dataset.tag;
  renderPoster();
});

// Aspect-ratio chips
const ratioPresetsContainer = document.getElementById("ratio-presets");
if (ratioPresetsContainer) {
  ratioPresetsContainer.addEventListener("click", (e) => {
    const btn = e.target.closest(".ratio-btn");
    if (!btn) return;
    const ratio = btn.dataset.ratio;
    if (!ratio || ratio === state.aspectRatio) return;
    ratioPresetsContainer.querySelectorAll(".ratio-btn").forEach(b => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-checked", b === btn ? "true" : "false");
    });
    applyAspectRatio(ratio);
    // Reflect in the collapsed accordion header pill
    const meta = document.getElementById("acc-meta-ratio");
    if (meta) meta.textContent = ratio;
  });
}

/* ── Accordion toggle ──
   Clicking a header flips the data-open attr on its parent .acc; CSS
   handles the smooth height transition via grid-template-rows.
   On mobile, toggling one section will close the others (single-open
   mode) so the panel stays compact. */
const isMobile = () => window.matchMedia("(max-width: 760px)").matches;

document.addEventListener("click", (e) => {
  const head = e.target.closest(".acc-head");
  if (!head) return;
  const acc  = head.parentElement;
  if (!acc || !acc.classList.contains("acc")) return;

  const opening = acc.dataset.open !== "true";
  if (opening && isMobile()) {
    // Single-open mode: close all sibling accordions inside the same .acc-list
    const list = acc.closest(".acc-list");
    if (list) {
      list.querySelectorAll(":scope > .acc[data-open='true']").forEach(o => {
        o.dataset.open = "false";
        const h = o.querySelector(":scope > .acc-head");
        if (h) h.setAttribute("aria-expanded", "false");
      });
    }
  }

  acc.dataset.open = opening ? "true" : "false";
  head.setAttribute("aria-expanded", opening ? "true" : "false");

  // When opening on mobile, scroll the header into a comfortable view
  if (opening && isMobile()) {
    requestAnimationFrame(() => {
      head.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
});

/* ── Mobile bottom-sheet (FAB → controls popup) ──
   On mobile, the editor panels live inside .edit-sheet which is hidden
   off-screen by default. The FAB toggles `body.sheet-open` to slide it up;
   tapping the backdrop or the close button drops it back down. */
const fabEdit       = document.getElementById("fab-edit");
const sheetBackdrop = document.getElementById("sheet-backdrop");
const sheetClose    = document.getElementById("sheet-close");
const editSheet     = document.getElementById("edit-sheet");

function setSheetOpen(open) {
  document.body.classList.toggle("sheet-open", open);
  if (fabEdit) fabEdit.setAttribute("aria-expanded", open ? "true" : "false");
  if (sheetBackdrop) sheetBackdrop.setAttribute("aria-hidden", open ? "false" : "true");
  if (open && editSheet) {
    // Reset scroll to top when opening so the user starts at the first section
    requestAnimationFrame(() => editSheet.scrollTo({ top: 0, behavior: "instant" }));
  }
}

if (fabEdit)       fabEdit.addEventListener("click", () => setSheetOpen(!document.body.classList.contains("sheet-open")));
if (sheetBackdrop) sheetBackdrop.addEventListener("click", () => setSheetOpen(false));
if (sheetClose)    sheetClose.addEventListener("click", () => setSheetOpen(false));

/* ── Swipe-to-close gesture on the sheet handle ── */
(function attachSheetSwipe() {
  const handle = document.querySelector(".sheet-handle");
  if (!handle || !editSheet) return;

  let startY     = null;     // touch start clientY
  let dragY      = 0;        // current downward delta
  let isDragging = false;
  const CLOSE_PX = 90;       // drag this far → close

  function onStart(e) {
    if (!document.body.classList.contains("sheet-open")) return;
    const point = e.touches ? e.touches[0] : e;
    startY = point.clientY;
    dragY = 0;
    isDragging = true;
    // Disable CSS transition during drag so transform tracks finger 1:1
    editSheet.style.transition = "none";
  }

  function onMove(e) {
    if (!isDragging) return;
    const point = e.touches ? e.touches[0] : e;
    const dy = point.clientY - startY;
    if (dy <= 0) {
      // Pulling up — slight rubber-band, then clamp at 0
      dragY = Math.max(-12, dy / 6);
    } else {
      dragY = dy;
    }
    editSheet.style.transform = `translateY(${dragY}px)`;
  }

  function onEnd() {
    if (!isDragging) return;
    isDragging = false;
    editSheet.style.transition = "";   // restore CSS transition
    if (dragY > CLOSE_PX) {
      editSheet.style.transform = "";  // let .sheet-open class take over
      setSheetOpen(false);
    } else {
      editSheet.style.transform = "";  // snap back to fully open
    }
    startY = null;
    dragY = 0;
  }

  // Touch (iOS / Android)
  handle.addEventListener("touchstart", onStart, { passive: true });
  handle.addEventListener("touchmove",  onMove,  { passive: true });
  handle.addEventListener("touchend",   onEnd);
  handle.addEventListener("touchcancel", onEnd);

  // Pointer (desktop drag — useful for testing)
  handle.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    onStart(e);
    handle.setPointerCapture?.(e.pointerId);
  });
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup",   onEnd);
  handle.addEventListener("pointercancel", onEnd);
})();

// Close the sheet on Escape (a11y)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("sheet-open")) setSheetOpen(false);
});

// Auto-close the sheet after a successful Build/scrape on mobile so the user
// instantly sees their poster.
function closeSheetIfMobile() {
  if (window.matchMedia("(max-width: 760px)").matches) setSheetOpen(false);
}

// On first load, collapse all accordions on mobile so the panel is compact
function setInitialAccordionState() {
  if (!isMobile()) return;
  document.querySelectorAll(".acc").forEach((acc, i) => {
    // Keep just the first accordion (Aspect Ratio) open by default
    const open = i === 0;
    acc.dataset.open = open ? "true" : "false";
    const h = acc.querySelector(":scope > .acc-head");
    if (h) h.setAttribute("aria-expanded", open ? "true" : "false");
  });
}
setInitialAccordionState();

window.addEventListener("resize", () => {
  // Re-apply on viewport class crossings (mobile↔desktop) for sanity
  const isMob = isMobile();
  document.querySelectorAll(".acc").forEach((acc) => {
    if (!isMob) {
      acc.dataset.open = "true";
      const h = acc.querySelector(":scope > .acc-head");
      if (h) h.setAttribute("aria-expanded", "true");
    }
  });
});

// Background image upload
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function getFirstImageFile(collection) {
  if (!collection) return null;
  for (const item of collection) {
    if (item?.type?.startsWith("image/")) {
      if (typeof item.getAsFile === "function") return item.getAsFile();
      return item;
    }
  }
  return null;
}

function validateImageFile(file) {
  if (!file) {
    setStatus("No image found.", "error");
    return false;
  }
  if (!file.type || !file.type.startsWith("image/")) {
    setStatus("Please use an image file.", "error");
    return false;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    setStatus("Image is too large. Use a file under 10 MB.", "error");
    return false;
  }
  return true;
}

function isEditableElement(element) {
  return Boolean(
    element?.closest?.(
      'input:not([type="button"]):not([type="checkbox"]):not([type="color"]):not([type="file"]):not([type="radio"]):not([type="range"]), textarea, [contenteditable="true"]'
    )
  );
}

function extractImageUrlFromHtml(html) {
  if (!html) return "";
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const image = doc.querySelector("img[src]");
    return image?.src || "";
  } catch {
    return "";
  }
}

function isLikelyWebUrl(value) {
  return /^https?:\/\//i.test((value || "").trim());
}

function loadBackgroundImageFile(file, sourceLabel = "Custom image") {
  if (!validateImageFile(file)) return;
  const uploadNonce = claimImageSelection();
  state.productImageAnalysis = null;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const img = new Image();
    img.onload = async () => {
      if (state.imageSelectionNonce !== uploadNonce) return;
      await ensureImageFocalPoint(img);
      state.mainImage = img;
      resetImageControls();
      editPanel.hidden = false;
      imagePanel.hidden = false;
      renderPoster();
      setStatus(`${sourceLabel} loaded!`, "success");
      bgImageUpload.value = "";
      analyzeUploadedProductImage(ev.target.result, uploadNonce);
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

async function loadBackgroundImageUrl(url, sourceLabel = "Pasted image") {
  const trimmedUrl = (url || "").trim();
  if (!isLikelyWebUrl(trimmedUrl)) {
    setStatus("Paste a direct image, an image URL, or drag in an image file.", "error");
    return false;
  }

  const uploadNonce = claimImageSelection();
  state.productImageAnalysis = null;

  try {
    setStatus("Loading pasted image...");
    const proxiedUrl = `/api/image?url=${encodeURIComponent(trimmedUrl)}`;
    const img = await imageFromUrl(proxiedUrl);
    if (state.imageSelectionNonce !== uploadNonce) return true;
    state.mainImage = img;
    resetImageControls();
    editPanel.hidden = false;
    imagePanel.hidden = false;
    renderPoster();
    setStatus(`${sourceLabel} loaded!`, "success");
    try {
      analyzeUploadedProductImage(proxiedUrl, uploadNonce);
    } catch (error) {
      console.warn("Pasted image analysis failed to start:", error);
    }
    return true;
  } catch (error) {
    console.warn("Pasted image URL load failed:", error);
    setStatus("That pasted link did not behave like a direct image.", "error");
    return false;
  }
}

async function loadClipboardImageData(clipboardData) {
  const file =
    getFirstImageFile(clipboardData?.items) ||
    getFirstImageFile(clipboardData?.files);
  if (file) {
    loadBackgroundImageFile(file, "Pasted image");
    return true;
  }

  const html = clipboardData?.getData?.("text/html") || "";
  const htmlImageUrl = extractImageUrlFromHtml(html);
  if (htmlImageUrl) {
    return loadBackgroundImageUrl(htmlImageUrl, "Pasted image");
  }

  const plainText = (clipboardData?.getData?.("text/plain") || "").trim();
  if (isLikelyWebUrl(plainText)) {
    return loadBackgroundImageUrl(plainText, "Pasted image");
  }

  return false;
}

async function loadBackgroundImageFromClipboard() {
  if (!navigator.clipboard?.read) {
    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text && isLikelyWebUrl(text)) {
          await loadBackgroundImageUrl(text, "Clipboard image");
          return;
        }
      } catch (error) {
        console.warn("Clipboard text read failed:", error);
      }
    }
    setStatus("Clipboard paste button is not supported here. Use Ctrl+V or Cmd+V on the upload box.", "error");
    return;
  }

  try {
    const clipboardItems = await navigator.clipboard.read();
    for (const clipboardItem of clipboardItems) {
      const imageType = clipboardItem.types.find((type) => type.startsWith("image/"));
      if (imageType) {
        const blob = await clipboardItem.getType(imageType);
        const file = new File([blob], `clipboard-image.${imageType.split("/")[1] || "png"}`, { type: imageType });
        loadBackgroundImageFile(file, "Clipboard image");
        return;
      }
      if (clipboardItem.types.includes("text/html")) {
        const html = await (await clipboardItem.getType("text/html")).text();
        const imageUrl = extractImageUrlFromHtml(html);
        if (imageUrl && (await loadBackgroundImageUrl(imageUrl, "Clipboard image"))) return;
      }
      if (clipboardItem.types.includes("text/plain")) {
        const text = (await (await clipboardItem.getType("text/plain")).text()).trim();
        if (text && isLikelyWebUrl(text) && (await loadBackgroundImageUrl(text, "Clipboard image"))) return;
      }
    }
    setStatus("No image found in the clipboard.", "error");
  } catch (error) {
    console.warn("Clipboard image read failed:", error);
    setStatus("Clipboard access was blocked. Copy an image, then use Ctrl+V or Cmd+V on the upload box.", "error");
  }
}

bgImageUpload.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  loadBackgroundImageFile(file);
});

if (bgPasteBtn) {
  bgPasteBtn.addEventListener("click", () => {
    loadBackgroundImageFromClipboard();
  });
}

if (bgUploadZone) {
  let dragDepth = 0;

  bgUploadZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      bgImageUpload.click();
    }
  });

  bgUploadZone.addEventListener("paste", (event) => {
    event.preventDefault();
    loadClipboardImageData(event.clipboardData).then((handled) => {
      if (!handled) setStatus("No image found in the clipboard.", "error");
    });
  });

  bgUploadZone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    bgUploadZone.classList.add("is-dragover");
  });

  bgUploadZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    bgUploadZone.classList.add("is-dragover");
  });

  bgUploadZone.addEventListener("dragleave", (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth || event.target === bgUploadZone) {
      bgUploadZone.classList.remove("is-dragover");
    }
  });

  bgUploadZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    bgUploadZone.classList.remove("is-dragover");
    const file = getFirstImageFile(event.dataTransfer?.files) || getFirstImageFile(event.dataTransfer?.items);
    if (!file) {
      setStatus("Drop an image file to use it as the background.", "error");
      return;
    }
    loadBackgroundImageFile(file, "Dropped image");
  });
}

document.addEventListener("paste", (event) => {
  const target = event.target;
  if (isEditableElement(target)) return;
  const zoneFocused =
    document.activeElement === bgUploadZone ||
    document.activeElement === bgPasteBtn ||
    bgUploadZone?.contains?.(document.activeElement);
  const pasteInsideZone = bgUploadZone?.contains?.(target);
  if (!zoneFocused && !pasteInsideZone) return;
  event.preventDefault();
  loadClipboardImageData(event.clipboardData).then((handled) => {
    if (!handled) setStatus("No image found in the clipboard.", "error");
  });
});

async function analyzeUploadedProductImage(imageData, expectedNonce) {
  try {
    setStatus("Reading product text and patterns...");
    const prepared = await prepareImageForAnalysis(imageData);
    if (state.imageSelectionNonce !== expectedNonce) return;

    const response = await fetch("/api/analyze-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageData: prepared }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Image analysis failed.");
    if (state.imageSelectionNonce !== expectedNonce) return;

    /* Onto the page the picture was picked for. This is page-owned and the
       vision call outlives the click, so an added slide was inheriting a
       different slide's analysis and skewing its suggested-image terms. */
    commitFieldToPage(imageSelectionOwner, "productImageAnalysis", payload.analysis || null);
    const analysis = imageSelectionOwner?.content?.productImageAnalysis ?? state.productImageAnalysis;
    const text = (analysis?.visibleText || []).join(", ");
    setStatus(text ? `Product text recognized: ${text}` : "Product patterns recognized.", "success");
  } catch (error) {
    console.warn("Product image analysis failed:", error);
    if (state.imageSelectionNonce === expectedNonce) {
      setStatus("Custom image loaded. Product text recognition unavailable.", "success");
    }
  }
}

async function prepareImageForAnalysis(imageData) {
  const img = await createImage(imageData);
  const maxSide = 1200;
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(img.width * scale));
  out.height = Math.max(1, Math.round(img.height * scale));
  const outCtx = out.getContext("2d");
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = "high";
  outCtx.drawImage(img, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.86);
}

/* ── Canvas drag-to-pan ── */

canvas.addEventListener("mousedown", (e) => {
  if (!state.mainImage) return;
  isDragging = true;
  canvas.classList.add("dragging");
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  dragStart = { x: e.clientX * scaleX, y: e.clientY * scaleY };
  dragOffsetStart = { ...state.imageOffset };
});

window.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const dx = e.clientX * scaleX - dragStart.x;
  const dy = e.clientY * scaleY - dragStart.y;
  state.imageOffset.x = clamp(dragOffsetStart.x + dx, -IMAGE_PAN_LIMIT, IMAGE_PAN_LIMIT);
  state.imageOffset.y = clamp(dragOffsetStart.y + dy, -IMAGE_PAN_LIMIT, IMAGE_PAN_LIMIT);
  imgOffsetX.value = Math.round(state.imageOffset.x);
  imgOffsetY.value = Math.round(state.imageOffset.y);
  renderPoster();
});

window.addEventListener("mouseup", () => {
  if (isDragging) {
    isDragging = false;
    canvas.classList.remove("dragging");
  }
});

// Touch support for mobile
canvas.addEventListener("touchstart", (e) => {
  if (!state.mainImage || e.touches.length !== 1) return;
  isDragging = true;
  const touch = e.touches[0];
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  dragStart = { x: touch.clientX * scaleX, y: touch.clientY * scaleY };
  dragOffsetStart = { ...state.imageOffset };
  e.preventDefault();
}, { passive: false });

canvas.addEventListener("touchmove", (e) => {
  if (!isDragging || e.touches.length !== 1) return;
  const touch = e.touches[0];
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const dx = touch.clientX * scaleX - dragStart.x;
  const dy = touch.clientY * scaleY - dragStart.y;
  state.imageOffset.x = clamp(dragOffsetStart.x + dx, -IMAGE_PAN_LIMIT, IMAGE_PAN_LIMIT);
  state.imageOffset.y = clamp(dragOffsetStart.y + dy, -IMAGE_PAN_LIMIT, IMAGE_PAN_LIMIT);
  imgOffsetX.value = Math.round(state.imageOffset.x);
  imgOffsetY.value = Math.round(state.imageOffset.y);
  renderPoster();
  e.preventDefault();
}, { passive: false });

canvas.addEventListener("touchend", () => { isDragging = false; });

/* ── Scrape Flow ── */

async function runScrape() {
  const url = scrapeUrlInput.value.trim();
  if (!url) {
    setStatus("Enter an article URL first.", "error");
    return;
  }

  scrapeButton.disabled = true;
  scrapeButton.classList.add("loading");
  setStatus("Scraping article...");

  try {
    const response = await fetch("/api/scrape-article", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Scrape failed.");
    }

    // A new article is a new post: drop the row this session was editing so
    // the next save creates one rather than overwriting the previous story.
    startNewPix();

    // Update state
    state.headline = payload.title || "";
    state.detailText = limitDetailTextClient(payload.detailText || payload.articleText || payload.title || "");
    // The scrape already extracted the full article body. Keep it: the AI
    // writer needs it to produce specific bullets, and without it the server
    // has to re-fetch the URL — a second request that often fails on
    // paywalled or JS-rendered pages, silently degrading to headline-only.
    state.articleText = payload.articleText || "";
    state.sourceUrl = payload.sourceUrl || scrapeUrlInput.value.trim();
    syncSourceUrlInput();
    state.ready = true;
    state.scrapedTitle = payload.title || "";
    state.imageQuery = payload.imageQuery || "";
    state.sourceImageUrl = payload.image || null;

    // Reset offsets
    state.imageOffset = { x: 0, y: 0 };
    imgOffsetX.value = 0;
    imgOffsetY.value = 0;

    // Populate edit panel
    headlineEdit.value = payload.title || "";
    if (detailEdit) detailEdit.value = state.detailText;
    writeHeadline.value = payload.title || "";
    writeDetail.value = state.detailText;
    editPanel.hidden = false;
    imagePanel.hidden = false;
    scrollPreviewIntoViewIfMobile();
    closeSheetIfMobile();

    // Load scraped image
    if (payload.imageProxy) {
      setStatus("Loading image...");
      try {
        state.mainImage = await imageFromUrl(payload.imageProxy);
      } catch {
        state.mainImage = null;
        setStatus("Article scraped! Image could not load — using placeholder.", "success");
      }
    } else {
      state.mainImage = null;
    }

    renderPoster();
    setStatus(`Scraped — writing the article…`, "success");

    // Fetch recommended stock images in the background
    fetchStockImages(payload.title, { smartQuery: payload.imageQuery || "" });

    // One action, everything filled: scraping now also writes the headline,
    // the four points and the tweet, and pushes them into the slides. The
    // scrape is the moment we have the freshest source text, so this is
    // where grounding is best.
    generateArticle({ applyToSlides: true }).then((data) => {
      setStatus(
        data ? "Done! Poster and article ready — edit below, then download."
             : "Poster ready. The article writer failed — open the Article tab to retry.",
        data ? "success" : "error"
      );
    });
  } catch (error) {
    setStatus(error.message || "Unable to scrape that article.", "error");
  } finally {
    scrapeButton.disabled = false;
    scrapeButton.classList.remove("loading");
  }
}

async function fetchStockImages(headline, options = {}) {
  const { autoApplyFirst = false, autoApplyRandom = false, onStatus = null, smartQuery = "" } = options;
  const selectionNonceAtStart = state.imageSelectionNonce;
  const report = (message, type) => {
    if (typeof onStatus === "function") onStatus(message, type);
  };

  try {
    // 1. Preferred: the AI-generated entity query from the scrape (e.g.
    //    "Karan Johar Ranbir Kapoor Ramayana"). Fallback: naive keyword
    //    extraction from the headline (write-mode has no scrape payload).
    const STOP = new Set(["THE", "A", "AN", "AND", "OR", "BUT", "FOR", "WITH", "FROM", "THAT", "THIS",
      "WILL", "WOULD", "SHOULD", "COULD", "SAYS", "SAID", "AFTER", "BEFORE", "ABOUT",
      "HAVE", "HAS", "HAD", "WAS", "WERE", "ARE", "IS", "BEEN", "INTO", "OVER", "UNDER",
      "THEIR", "THEY", "THEM", "THERE", "THEN", "MORE", "MOST", "VERY", "JUST", "ALSO",
      "NEW", "NEWS", "LIVE", "WHAT", "WHEN", "WHERE", "WHO", "HOW", "WHY", "WHICH", "AMID", "IN", "ON"]);

    // Extract alphanumeric words, uppercase
    const words = headline.toUpperCase().replace(/[^A-Z0-9\s]/g, "").split(/\s+/).filter(Boolean);
    const keywords = words.filter(w => !STOP.has(w) && w.length > 2).slice(0, 5); // Take top 5 meaningful words

    let searchQuery = smartQuery
      || (keywords.length > 0 ? keywords.join(" ") : headline.slice(0, 40));
    if (smartQuery) console.log(`[images] using AI query: "${smartQuery}"`);
    const imageContext = buildProductImageContext(state.productImageAnalysis);
    const imageSearchTerms = buildProductSearchTerms(state.productImageAnalysis);
    if (imageSearchTerms) {
      searchQuery = `${searchQuery} ${imageSearchTerms}`.trim().slice(0, 120);
    }

    let images = [];

    // COST ORDER: free sources first. Flux (fal.ai) BILLS PER GENERATION, so
    // it only runs as the last resort when both free sources return nothing —
    // previously it fired first on every scrape and quietly burned credits.

    // 2. Web / News images (free: Bing -> Google -> DDG)
    try {
      const gRes = await fetch(`/api/google-images?query=${encodeURIComponent(searchQuery)}`);
      const gData = await gRes.json();
      if (gRes.ok && gData.images?.length) {
        images = gData.images;
      }
    } catch { /* Web images failed, try Stock Pexels */ }

    // 3. Pexels stock (free tier)
    if (!images.length) {
      try {
        const pRes = await fetch(`/api/stock-images?query=${encodeURIComponent(searchQuery)}`);
        const pData = await pRes.json();
        if (pRes.ok && pData.images?.length) {
          images = pData.images;
        }
      } catch { /* Pexels also failed */ }
    }

    // 4. Flux generation — PAID, last resort only.
    if (!images.length) {
      try {
        const fluxUrl = `/api/flux-image?query=${encodeURIComponent(searchQuery)}${imageContext ? `&context=${encodeURIComponent(imageContext)}` : ""}`;
        const fRes = await fetch(fluxUrl);
        const fData = await fRes.json();
        if (fRes.ok && fData.images?.length) {
          images = fData.images;
        }
      } catch { /* Flux failed too */ }
    }

    if (!images.length) {
      images = buildFallbackImageSuggestions(searchQuery);
    }

    if (!images.length) {
      stockImagesSection.hidden = true;
      report("No matching images found. You can upload one manually.", "error");
      return;
    }

    stockImagesGrid.innerHTML = "";
    const getLoadableImageUrls = (img) => {
      const urls = [img.imageProxy, img.image, img.preview].filter(Boolean);
      return [...new Set(urls)];
    };

    const applySuggestedImage = async (img, thumb = null, expectedNonce = null) => {
      // The slide this pick is FOR, before any await moves the selection.
      const owner = activePage();
      if (expectedNonce !== null && state.imageSelectionNonce !== expectedNonce) {
        return false;
      }
      report("Loading selected image...");
      setStatus("Loading image...");
      for (const imageUrl of getLoadableImageUrls(img)) {
        try {
          const fullImg = await imageFromUrl(imageUrl);
          if (expectedNonce !== null && state.imageSelectionNonce !== expectedNonce) {
            return false;
          }
          await ensureImageFocalPoint(fullImg);
          claimImageSelection();
          // claimImageSelection() stamps the CURRENT page; this pick belongs
          // to the one it was made from.
          imageSelectionOwner = owner;
          if (stashImageForAbsentPage(owner, fullImg)) {
            report("Image applied to the slide it was chosen for.", "success");
            setStatus("Image applied!", "success");
            stockImagesGrid.querySelectorAll(".stock-item").forEach(t => t.classList.remove("active"));
            if (thumb) thumb.classList.add("active");
            return true;
          }
          state.mainImage = fullImg;
          resetImageControls();
          renderPoster();
          report("Image applied.", "success");
          setStatus("Image applied!", "success");
          stockImagesGrid.querySelectorAll(".stock-item").forEach(t => t.classList.remove("active"));
          if (thumb) thumb.classList.add("active");
          return true;
        } catch {
          // Keep trying the next available URL for this result.
        }
      }
      report("Failed to load that image.", "error");
      setStatus("Failed to load image.", "error");
      return false;
    };

    const thumbs = [];
    images.forEach(img => {
      const thumb = document.createElement("div");
      thumb.className = "stock-item";
      thumb.style.backgroundImage = `url(${img.preview})`;
      thumb.title = img.alt || "Related image";
      thumb.addEventListener("click", () => applySuggestedImage(img, thumb));
      stockImagesGrid.appendChild(thumb);
      thumbs.push(thumb);
    });

    stockImagesSection.hidden = false;
    report(`Found ${images.length} matching image${images.length === 1 ? "" : "s"}.`, "success");

    if ((autoApplyFirst || autoApplyRandom) && images[0] && state.imageSelectionNonce === selectionNonceAtStart) {
      const order = images.map((_, index) => index);
      if (autoApplyRandom) {
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
      }

      let applied = false;
      for (const index of order) {
        if (state.imageSelectionNonce !== selectionNonceAtStart) break;
        applied = await applySuggestedImage(images[index], thumbs[index], selectionNonceAtStart);
        if (applied) break;
      }

      if (applied) {
        report(`Poster ready with a matching image. ${images.length > 1 ? "Tap another thumbnail to change it." : ""}`.trim(), "success");
      } else if (state.imageSelectionNonce === selectionNonceAtStart) {
        report("Found images, but none loaded. Try a thumbnail or upload one manually.", "error");
      }
    }
  } catch {
    stockImagesSection.hidden = true;
    report("Image search failed. You can upload one manually.", "error");
  }
}

/* ── Poster Rendering ── */

// Compute the headline layout (lines + font) AND its top y position based on
// canvas.height - bottomPadding. Done once per render and stashed on state
// so drawBackground / drawTag / drawHeadline all use the same anchor.
function buildProductSearchTerms(analysis) {
  if (!analysis) return "";
  return [
    analysis.productType,
    ...(analysis.visibleText || []).slice(0, 3),
    ...(analysis.brandCues || []).slice(0, 2),
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function buildProductImageContext(analysis) {
  if (!analysis) return "";
  const parts = [];
  if (analysis.productType) parts.push(`product type: ${analysis.productType}`);
  if (analysis.visibleText?.length) parts.push(`visible text/OCR: ${analysis.visibleText.join(", ")}`);
  if (analysis.brandCues?.length) parts.push(`brand cues: ${analysis.brandCues.join(", ")}`);
  if (analysis.patterns?.length) parts.push(`patterns: ${analysis.patterns.join(", ")}`);
  if (analysis.colors?.length) parts.push(`colors: ${analysis.colors.join(", ")}`);
  if (analysis.promptHints) parts.push(`prompt hints: ${analysis.promptHints}`);
  return parts.join("; ").slice(0, 900);
}

function computeHeadlineLayoutAndTop() {
  const L = getLayout();
  const text = state.headline || "YOUR HEADLINE HERE";
  const layout = state.fontSize > 0
    ? buildHeadlineLayoutFixed(text, L.headline.maxWidth, state.fontSize)
    : buildHeadlineLayout(text, L.headline.maxWidth, 5);

  // Pull the actual font size out of the font string so the block height
  // doesn't depend on layout.lineHeight (which has line-spacing baked in)
  const m = layout.font.match(/(\d+(?:\.\d+)?)px/);
  const fontSize = m ? parseFloat(m[1]) : 49;

  const blockHeight = (layout.lines.length - 1) * layout.lineHeight + fontSize;
  const bottomPadding = isXRenderMode()
    ? 56
    : L.headline.bottomPadding;
  const top = Math.max(0, canvas.height - bottomPadding - blockHeight);
  return { layout, top, fontSize, blockHeight, bottomPadding };
}

/* ── Three cards, one renderer ──
   The reader swipes a carousel, so the editor shows all three slides at once
   instead of hiding two behind a mode toggle. Every draw function reads the
   module-level `ctx` and `canvas`, so each card is painted by pointing `ctx`
   at that card's canvas and setting the mode — the same swap trick the
   high-res exporter already uses. No draw function needed changing.

   `state._targetedRender` marks "paint once into the ctx I gave you", which
   is what the exporter and the per-card painters need; without it a nested
   renderPoster() would recurse back into painting all three. */

/* ── Pages ──────────────────────────────────────────────────────────────
   The carousel is a spine plus extras.

   The spine is what a scrape produces and cannot be removed: Poster is
   page 1 and Text is page 2. Everything else — including video — is added
   by hand, up to MAX_PAGES in total, in any mix of poster / text / video.

   Only one page is selected at a time, and the editor columns write to
   whichever that is. Rather than thread a page argument through forty draw
   and control functions, the selected page's values ARE `state`: switching
   pages captures the outgoing page's fields out of state and applies the
   incoming page's fields into it. Painting does the same swap per card, so
   every page can be on screen at once while only one is live.

   A field is either page-owned (listed below) or global. Global is the
   default and covers everything that is a property of the post rather than
   of one page in it: accent, logo, aspect ratio, the timestamp toggle. */

const MAX_PAGES = 5;

// The background image is owned by poster AND text pages: the text card
// paints a blurred copy of it, so two text pages with one shared image
// could not look different from each other.
const IMAGE_PAGE_FIELDS = [
  /* storedImageUrl/storedImageFor are page-owned for the same reason
     mainImage is: each slide has its own picture and therefore its own
     uploaded copy. They were plain `state` values when only the post had an
     image, and leaving them there broke the moment pages got their own —
     syncActivePageContent() REPLACES page.content with a fresh capture of the
     declared fields, so a URL written onto the selected page's content was
     discarded by the next sync. Undeclared meant unsaved. */
  "mainImage", "storedImageUrl", "storedImageFor", "imageOffset", "imageZoom",
  "filterPreset", "filterBrightness", "filterContrast", "filterSaturation", "filterBlur",
  "sourceImageUrl", "productImageAnalysis",
];
const POSTER_PAGE_FIELDS = [...IMAGE_PAGE_FIELDS, "headline", "tag", "fontSize", "headlineStyle"];
/* A text page owns its background but not its words: the paragraph is one
   body of text on the post, divided across the text pages at paint time.
   See recomputeDetailSlices(). */
const TEXT_PAGE_FIELDS   = [...IMAGE_PAGE_FIELDS];
/* A story page owns everything it shows: its own image, its own heading and
   its own body copy. That last one is what separates it from a text page —
   a text page takes a SLICE of the post's single paragraph, so its words are
   decided by how many text pages there are. A story page is written directly,
   which is what you want when each slide makes its own point. */
const STORY_PAGE_FIELDS  = [...IMAGE_PAGE_FIELDS, "storyHeading", "storyBody", "storyOverlayOpacity"];
/* A video page owns its upload and its last encode as well as its clip:
   two video pages that shared `storedVideoUrl` would publish each other's
   footage. */
const VIDEO_PAGE_FIELDS  = [
  "videoEl", "videoSrc", "videoUrl", "videoFile", "videoMeta", "videoSourceKind",
  /* The name of the file the writer chose. The File itself does not survive a
     reload, so without this a reviewer opening the post has no way to see WHAT
     was added — only that something was. */
  "videoFileName",
  "trimStart", "trimEnd", "videoMuted", "videoFocus", "videoCaption", "videoCaptionSize",
  "storedVideoUrl", "storedVideoFor", "renderedClip",
];

// The spine is poster + text. Video is not part of it, so the base page
// never owns a clip — only an added Video page does.
const BASE_PAGE_FIELDS = [...new Set([...POSTER_PAGE_FIELDS, ...TEXT_PAGE_FIELDS, "detailText"])];
const ALL_PAGE_FIELDS = [...new Set([...BASE_PAGE_FIELDS, ...STORY_PAGE_FIELDS, ...VIDEO_PAGE_FIELDS])];

const PAGE_TYPES = {
  poster: { label: "Poster", mode: "pix",   download: "Download",  fields: POSTER_PAGE_FIELDS },
  text:   { label: "Text",   mode: "text",  download: "Download",  fields: TEXT_PAGE_FIELDS },
  story:  { label: "Story",  mode: "story", download: "Download",  fields: STORY_PAGE_FIELDS },
  video:  { label: "Video",  mode: "video", download: "Export MP4", fields: VIDEO_PAGE_FIELDS },
};

/* Which editor controls can reach a given page. Controls that cannot are
   dimmed instead of hidden — the panel keeps its shape, so nothing jumps
   when the selection changes. */
const PAGE_SCOPE = {
  base:   { headline: true,  detail: true,  tag: true,  image: true,  video: false },
  poster: { headline: true,  detail: false, tag: true,  image: true,  video: false },
  text:   { headline: false, detail: true,  tag: false, image: true,  video: false },
  /* A story page writes its own heading and its own body, into storyHeading
     and storyBody. The post-level headline and paragraph boxes are therefore
     off here: they are not this page's copy, and leaving them live meant a
     writer aiming at the story heading hit the POST headline instead and
     silently rewrote the poster. Story pages get their own two boxes. */
  story:  { headline: false, detail: false, tag: false, image: true,  video: false },
  video:  { headline: false, detail: false, tag: false, image: false, video: true  },
};

const basePage = { id: "base", type: "base", el: null, cards: [], content: null };
const pages = [basePage];
let activePageId = "base";
let pageSeq = 0;

basePage.cards = Array.from(document.querySelectorAll('.preview-card[data-page="base"]')).map((el) => ({
  el,
  mode: el.dataset.previewMode,
  canvas: el.querySelector("canvas"),
  page: basePage,
  detailSlice: null,     // set by recomputeDetailSlices() on text cards
  sliceRange: null,
}));

/* ── Rail order ──
   `pages` holds content; `slotOrder` holds the sequence the reader sees.
   They are separate because the spine is one page with two cards, and a
   card has to be movable on its own. Page numbers are slot positions, so
   reordering renumbers by construction — there is nothing to keep in step. */
const slotOrder = [...basePage.cards];
let currentModalCard = null;

function cardForElement(el) { return slotOrder.find((card) => card.el === el) || null; }

const xPreviewCanvas = document.getElementById("x-canvas");

function fieldsForPage(page) {
  if (!page || page.type === "base") return BASE_PAGE_FIELDS;
  return PAGE_TYPES[page.type]?.fields || [];
}

const CARD_LABELS = { pix: "Poster", text: "Text", story: "Story", video: "Video", x: "For X" };
function cardLabel(card) {
  if (!card) return "Page";
  if (card.isX || card.mode === "x") return "For X";
  return CARD_LABELS[card.mode] || "Page";
}

// Where a card sits in the rail, 1-based — what the writer sees on it.
function cardNumber(card) {
  if (!card) return "1";
  if (card.isX || card.mode === "x") return "𝕏";
  return slotOrder.indexOf(card) + 1;
}

function getPage(id) { return pages.find((p) => p.id === id) || basePage; }
function activePage() { return getPage(activePageId); }
function extraPages() { return pages.filter((p) => p !== basePage); }

// One card, one page, one number. Counting the cards that are actually in
// the rail is what stops the count and the rail drifting apart — that is
// what let a full rail render six.
function pageCount() { return slotOrder.length; }
function canAddPage() { return pageCount() < MAX_PAGES; }

/* Copy the plain {x,y} pairs so a stored page cannot be mutated later by a
   drag on the live one. Images, Files and <video> elements are shared by
   reference on purpose — they are the payload, not a value. */
function clonePageValue(value) {
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return { ...value };
  }
  return value;
}

function capturePageFields(fields) {
  const out = {};
  for (const field of fields) out[field] = clonePageValue(state[field]);
  return out;
}

function applyPageFields(values) {
  if (!values) return;
  for (const key of Object.keys(values)) state[key] = values[key];
}

/* Fold live state back into the selected page before anything reads a page.
   Fields the selected page does not own are still edits to the post, so
   they land on the base page — otherwise changing the paragraph while an
   added poster page is selected would vanish on the next repaint. */
function syncActivePageContent() {
  const page = activePage();
  page.content = capturePageFields(fieldsForPage(page));
  if (page !== basePage) {
    const owned = new Set(fieldsForPage(page));
    const rest = BASE_PAGE_FIELDS.filter((field) => !owned.has(field));
    basePage.content = { ...(basePage.content || {}), ...capturePageFields(rest) };
  }
}

/* Read the post as its OWN page holds it, whatever page is selected.
   `state` is the SELECTED page's values — setActivePage() applies the base
   page's content and then the selected page's on top — so a save taken while
   an added page is selected was reading that page's headline, tag, image and
   framing and writing them into the post's own columns. Clicking "Add page"
   on a saved post was enough: the new page's blank image landed in
   main_image_url and the row lost its picture with nobody touching a key.

   Deliberately a READ-ONLY view. The obvious alternative — swap the base
   page's values into `state` for the duration of the save — corrupts the
   other direction: serializePages() and withPrimaryVideo() both begin with
   syncActivePageContent(), which would file the base page's headline and
   image under the selected page and write that into design.pages, where a
   restore of `state` afterwards cannot reach it. Nothing here writes back,
   so those helpers keep seeing the true selection.

   The spread is safe for fields the selected page does not own:
   syncActivePageContent() has just folded those onto basePage.content, and
   fields no page owns at all (storedImageUrl, sourceUrl, article…) are not
   in BASE_PAGE_FIELDS, so `state`'s value survives the overlay untouched.
   That is what lets callers read every field off the view rather than having
   to remember which of them the pages happen to own. */
function basePageView() {
  syncActivePageContent();
  return activePage() === basePage ? state : { ...state, ...(basePage.content || {}) };
}

function paintCardInto(target, mode) {
  if (!target) return;
  if (target.width !== canvas.width || target.height !== canvas.height) {
    target.width = canvas.width;
    target.height = canvas.height;
  }
  const prevCtx = ctx;
  const prevMode = state.previewMode;
  const prevTargeted = state._targetedRender;
  ctx = target.getContext("2d");
  state.previewMode = mode;
  state._targetedRender = true;
  try {
    paintPoster();
  } finally {
    ctx = prevCtx;
    state.previewMode = prevMode;
    state._targetedRender = prevTargeted;
  }
}

/* ── Dividing the points across text pages ──
   The paragraph stays one body of text — it is what gets saved, published
   and searched, and splitting it into per-page copies would mean four
   places to keep in step. Instead each text card is handed a slice of it
   at paint time: six points over two text pages is 3 and 3, over three
   pages 2/2/2, and seven over two is 4 and 3.

   Because slices are derived rather than stored, adding, removing or
   dragging a text page re-divides them on the next paint with nothing to
   invalidate. */

function detailPoints(text) {
  return (text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[•*-]\s*$/.test(line));
}

// Remainders go to the earliest pages, so 7 over 2 reads 4 then 3 — a
// fuller first card looks deliberate where a fuller last one looks like
// something overflowed.
function distributePoints(points, buckets) {
  const out = [];
  let taken = 0;
  let remainder = points.length % buckets;
  const each = Math.floor(points.length / buckets);
  for (let i = 0; i < buckets; i += 1) {
    const size = each + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    out.push(points.slice(taken, taken + size));
    taken += size;
  }
  return out;
}

let detailSliceKey = "";

function recomputeDetailSlices({ force = false } = {}) {
  const textCards = slotOrder.filter((card) => card.mode === "text");
  const body = getFullDetailText();
  const key = `${slotOrder.map((c) => c.mode).join(",")}|${body}`;
  if (!force && key === detailSliceKey) return;
  detailSliceKey = key;

  // One text page carries the whole paragraph, exactly as it always did.
  if (textCards.length < 2) {
    for (const card of textCards) { card.detailSlice = null; card.sliceRange = null; }
    syncSliceLabels();
    return;
  }

  const points = detailPoints(body);
  const chunks = distributePoints(points, textCards.length);
  let next = 1;
  textCards.forEach((card, i) => {
    const chunk = chunks[i];
    card.detailSlice = chunk.join("\n\n");
    card.sliceRange = chunk.length ? [next, next + chunk.length - 1] : null;
    next += chunk.length;
  });
  syncSliceLabels();
}

function syncSliceLabels() {
  for (const card of slotOrder) {
    const label = card.el.querySelector(".preview-card-slice");
    if (!label) continue;
    label.hidden = true;
    label.textContent = "";
  }
}

function renderPoster() {
  // Export paths swap ctx themselves and want a single paint.
  if (state._targetedRender) { paintPoster(); return; }

  syncZoomReadout();
  syncActivePageContent();
  recomputeDetailSlices();

  // The live values, restored after the last card. Every page is painted
  // through base first, so a page only overrides the fields it owns and
  // inherits the rest of the post.
  const live = capturePageFields(ALL_PAGE_FIELDS);

  try {
    for (const page of pages) {
      applyPageFields(live);
      applyPageFields(basePage.content);
      if (page !== basePage) applyPageFields(page.content);
      for (const card of page.cards) {
        // A text card paints its slice of the paragraph, not the whole of it.
        state._detailSlice = card.detailSlice || null;
        paintCardInto(card.canvas, card.mode);
      }
      state._detailSlice = null;
    }

    // X is the poster again, so it always follows page 1 — never whichever
    // page happens to be selected.
    applyPageFields(live);
    applyPageFields(basePage.content);
    paintCardInto(xPreviewCanvas, "x");
  } finally {
    applyPageFields(live);
    if (currentModalCard) updateScreenPreviewModal();
  }
}

/* ── Page operations ── */

function blankPageContent(type) {
  const blank = {
    mainImage: null,
    imageOffset: { x: 0, y: 0 },
    imageZoom: 100,
    filterPreset: "none",
    filterBrightness: 100,
    filterContrast: 100,
    filterSaturation: 100,
    filterBlur: 0,
    sourceImageUrl: null,
    productImageAnalysis: null,
    headline: "",
    tag: "none",
    fontSize: 0,
    // Blank everywhere else, but a headline needs *a* style: inheriting the
    // post's current one is the least surprising starting point.
    headlineStyle: state.headlineStyle,
    detailText: "",
    storyHeading: "",
    storyBody: "",
    storyOverlayOpacity: 100,
    videoEl: null,
    videoSrc: "",
    videoUrl: "",
    videoFile: null,
    videoMeta: null,
    videoSourceKind: "file",
    trimStart: 0,
    trimEnd: 0,
    videoMuted: false,
    videoFocus: { x: 0.5, y: 0.5 },
    storedVideoUrl: null,
    storedVideoFor: null,
    renderedClip: null,
    videoCaption: "",
    videoCaptionSize: state.videoCaptionSize,
  };
  const owned = new Set(fieldsForPage({ type }));
  const content = {};
  for (const field of owned) content[field] = clonePageValue(blank[field]);
  return content;
}

/* Build and mount a page. Kept separate from addPage() so reopening a saved
   post can rebuild its pages without each one stealing the selection and
   capturing the live values on the way past. */
function createPage(type, content) {
  const spec = PAGE_TYPES[type];
  const addTile = document.getElementById("preview-add");
  if (!spec || !addTile) return null;

  pageSeq += 1;
  const id = `page-${pageSeq}`;

  const fig = document.createElement("figure");
  fig.className = "preview-card";
  fig.dataset.page = id;
  fig.dataset.previewMode = spec.mode;
  fig.innerHTML = `
          <figcaption class="preview-card-label" title="Click to view full screen">
            <button type="button" class="preview-card-grip" data-grip
                    aria-label="Move this page — drag, or use the left and right arrow keys"
                    title="Drag to reorder (or focus and press &larr; &rarr;)">&#10287;</button>
            <span class="preview-card-num"></span>
            <span class="preview-card-type">${spec.label}</span>
            <button type="button" class="preview-card-remove" data-remove-page
                    aria-label="Remove this page" title="Remove this page">&times;</button>
          </figcaption>
          <div class="canvas-container">
            <canvas width="${canvas.width}" height="${canvas.height}"></canvas>
          </div>
          <p class="preview-card-slice" hidden></p>
          <div class="preview-card-actions">
            <button type="button" class="btn-ghost preview-card-edit" data-edit-page>
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M11.3 2.2l2.5 2.5L6 12.5 3 13l.5-3z" fill="none"
                      stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
              </svg> Edit
            </button>
            <button type="button" class="btn-ghost preview-card-dl" data-download="${spec.mode}">
              <svg width="12" height="12" aria-hidden="true"><use href="#i-download"/></svg> ${spec.download}
            </button>
          </div>`;

  const cardCanvas = fig.querySelector("canvas");
  const page = {
    id,
    type,
    el: fig,
    cards: [],
    content: { ...blankPageContent(type), ...(content || {}) },
  };
  page.cards = [{
    el: fig, mode: spec.mode, canvas: cardCanvas, page, detailSlice: null, sliceRange: null,
  }];

  addTile.before(fig);
  pages.push(page);
  slotOrder.push(page.cards[0]);
  if (type === "video") attachVideoReframe(cardCanvas, id);
  return page;
}

function addPage(type) {
  if (!canAddPage()) return null;
  // A new page starts empty rather than as a copy of page 1: clearing a
  // duplicate is more work than filling a blank.
  const page = createPage(type, null);
  if (!page) return null;

  renumberPages();
  setActivePage(page.id);
  page.el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  return page;
}

/* ── Saving the page list ──
   Text, tags, framing AND the page's own image. The image used to be left
   out: it lives in the tab as a data: URL, only the post's picture was ever
   uploaded, and a URL cannot be stored for a file that was never sent — so a
   reopened post rebuilt its added pages empty of media. ensureMediaUploaded
   now uploads each page's picture first and leaves the URL on page.content,
   which is what `imageUrl` below carries. */
function serializePages() {
  syncActivePageContent();
  return extraPages().map((page) => {
    const c = page.content || {};
    const entry = { type: page.type };
    if (page.type === "story") {
      // A story page carries its own words, so they travel with the page
      // rather than being derived from the post's paragraph on open.
      entry.storyHeading = c.storyHeading || "";
      entry.storyBody = c.storyBody || "";
      entry.overlayOpacity = c.storyOverlayOpacity ?? 100;
    }
    if (page.type === "poster") {
      entry.headline = c.headline || "";
      entry.tag = c.tag || "none";
      entry.fontSize = c.fontSize ?? 0;
      entry.headlineStyle = c.headlineStyle;
    }
    // No text: a text page shows a slice of the post's paragraph, and the
    // slice is derived from the page order on open.
    /* The page's own picture, for every type that shows one. Without this the
       row remembered how a slide was framed but not what it framed. */
    if (c.storedImageUrl) entry.imageUrl = c.storedImageUrl;

    if (page.type === "poster" || page.type === "text" || page.type === "story") {
      entry.imageZoom = c.imageZoom ?? 100;
      entry.imageOffset = { x: c.imageOffset?.x ?? 0, y: c.imageOffset?.y ?? 0 };
      entry.filters = {
        preset: c.filterPreset || "none",
        brightness: c.filterBrightness ?? 100,
        contrast: c.filterContrast ?? 100,
        saturation: c.filterSaturation ?? 100,
        blur: c.filterBlur ?? 0,
      };
    }
    if (page.type === "video") {
      entry.video = {
        url: c.videoUrl || null,
        // The bucket copy is the only part of a clip that survives a reload,
        // so it is the one piece of media a page does carry across.
        storedUrl: c.storedVideoUrl || null,
        storedFor: c.storedVideoFor || null,
        sourceKind: c.videoSourceKind || "link",
        trimStart: c.trimStart ?? 0,
        trimEnd: c.trimEnd ?? 0,
        muted: !!c.videoMuted,
        focus: { x: c.videoFocus?.x ?? 0.5, y: c.videoFocus?.y ?? 0.5 },
        caption: c.videoCaption || "",
        captionSize: c.videoCaptionSize ?? state.videoCaptionSize,
      };
    }
    return entry;
  });
}

/* `spine` is the list of base cards the post was SAVED with. It has to be
   applied HERE rather than afterwards, because the loop below spends the
   MAX_PAGES budget as it goes.

   Without it: a writer who removes the Text slide to make room can build a
   poster plus four story pages, and it saves correctly — spine ["pix"] and
   four page entries. On reopen this function reseeded the rail with EVERY
   base card, so the budget started at 2 instead of the 1 that was saved, and
   the `canAddPage()` guard in the loop broke out one entry early. The last
   slide was dropped, in silence. restoreSpineCards() then removed the Text
   card a moment later — freeing the very slot the page had just been refused.

   Worse than losing it on screen: the next save serialises the three pages
   that survived over the four that were stored, so the fifth slide's heading,
   body and picture leave the database too. Autosave did that without anyone
   pressing a thing. */
function restorePages(list, spine) {
  for (const page of extraPages()) {
    if (page.parkedVideo) {
      page.parkedVideo.removeAttribute("src");
      page.parkedVideo.load();
    }
    page.el?.remove();
  }
  pages.length = 1;
  slotOrder.length = 0;
  /* A post saved before the spine was recorded has no list; both cards is the
     arrangement it was saved under, so that is what it reopens with. */
  const wantedSpine = Array.isArray(spine) ? spine : null;
  for (const card of basePage.cards) {
    if (wantedSpine && !wantedSpine.includes(card.mode)) {
      /* renumberPages() only re-inserts cards that are IN slotOrder — it
         never takes one out — so a card left in the DOM here would sit in the
         rail as a ghost that no page owns. */
      card.el?.remove();
      continue;
    }
    slotOrder.push(card);
  }
  activePageId = "base";
  playerOwner = null;

  for (const entry of Array.isArray(list) ? list : []) {
    if (!PAGE_TYPES[entry?.type] || !canAddPage()) break;
    const content = {};
    if (entry.type === "story") {
      content.storyHeading = entry.storyHeading || "";
      content.storyBody = entry.storyBody || "";
      // `imageOpacity` was briefly written by the first version of this
      // control. Reuse its value for the gradient, but never fade the image.
      content.storyOverlayOpacity = clamp(numberOr(entry.overlayOpacity, numberOr(entry.imageOpacity, 100)), 0, 100);
    }
    if (entry.type === "poster") {
      content.headline = entry.headline || "";
      content.tag = entry.tag || "none";
      content.fontSize = numberOr(entry.fontSize, 0);
      if (entry.headlineStyle) content.headlineStyle = entry.headlineStyle;
    }
    /* Story pages belong here too. serializePages() writes imageZoom,
       imageOffset and filters for "poster", "text" AND "story", but this side
       only ever read them back for the first two — so a story slide that had
       been zoomed in on a face, nudged into place or given a filter reopened
       at 100% and dead centre, and the next save wrote those defaults back
       over the framing the writer had chosen. */
    if (entry.type === "poster" || entry.type === "text" || entry.type === "story") {
      content.imageZoom = numberOr(entry.imageZoom, 100);
      content.imageOffset = {
        x: numberOr(entry.imageOffset?.x, 0),
        y: numberOr(entry.imageOffset?.y, 0),
      };
      content.filterPreset = entry.filters?.preset || "none";
      content.filterBrightness = numberOr(entry.filters?.brightness, 100);
      content.filterContrast = numberOr(entry.filters?.contrast, 100);
      content.filterSaturation = numberOr(entry.filters?.saturation, 100);
      content.filterBlur = numberOr(entry.filters?.blur, 0);
    }
    if (entry.type === "video") {
      content.videoUrl = entry.video?.url || "";
      content.storedVideoUrl = entry.video?.storedUrl || null;
      /* Seed the player source too, so the card can paint without waiting to
         be selected and adoptPageVideo has something to load. */
      content.videoSrc = entry.video?.storedUrl || "";
      content.storedVideoFor = entry.video?.storedFor || null;
      content.videoSourceKind = entry.video?.sourceKind || "link";
      content.trimStart = numberOr(entry.video?.trimStart, 0);
      content.trimEnd = numberOr(entry.video?.trimEnd, 0);
      content.videoMuted = !!entry.video?.muted;
      content.videoFocus = {
        x: numberOr(entry.video?.focus?.x, 0.5),
        y: numberOr(entry.video?.focus?.y, 0.5),
      };
      content.videoCaption = entry.video?.caption || "";
      content.videoCaptionSize = numberOr(entry.video?.captionSize, state.videoCaptionSize);
    }
    /* The picture comes back through the proxy, exactly as page 1's does.

       Deliberately not awaited: restorePages is called from a synchronous
       rebuild and a post with four slides would otherwise block the editor on
       four sequential network fetches before drawing anything. Each page
       paints as its own image lands, and renderPoster is called per arrival
       rather than once at the end so the rail fills in progressively instead
       of staying blank until the slowest one finishes. A failure leaves that
       page without its picture, which is what happened to every page before
       this existed — no worse, and the rest still open. */
    const page = createPage(entry.type, content);
    if (entry.imageUrl && page) {
      page.content.storedImageUrl = entry.imageUrl;
      imageFromUrl(`/api/image?url=${encodeURIComponent(entry.imageUrl)}`)
        .then((img) => {
          if (!page.content) return;
          page.content.mainImage = img;
          page.content.storedImageFor = img?.src || entry.imageUrl;
          /* If this page is the one on screen, its content was copied into
             `state` before the image arrived, so the canvas is still drawing
             the empty version. Push it across before repainting. */
          if (activePage() === page) state.mainImage = img;
          renderPoster();
        })
        .catch(() => {});
    }
  }

  renumberPages();
}

/* Take a card out of the rail without destroying the page behind it.

   The two spine cards both live on `basePage`, which owns the post itself —
   the headline, the image, the paragraph. Deleting that page would take the
   post with it, which is why removePage() refuses index 0. But refusing to
   remove the CARD was a different rule wearing the same coat: a story that is
   only a video, or only a poster, is an ordinary thing to want, and there was
   no way to say so.

   So the card leaves slotOrder and the DOM while the page stays. Putting it
   back is just pushing the card in again — see restoreSpineCards(). */
function removeCard(card) {
  const slot = slotOrder.indexOf(card);
  if (slot < 0) return;
  // A post with no pages is not a post.
  if (slotOrder.length <= 1) {
    setStatus("A post needs at least one page.", "error");
    return;
  }

  slotOrder.splice(slot, 1);
  card.el?.remove();

  // The selection may have been sitting on the card that just left.
  if (!slotOrder.some((c) => c.el?.dataset?.page === activePageId)) {
    const next = slotOrder[0];
    if (next) setActivePage(next.el?.dataset?.page || "base", { force: true });
  }

  renumberPages();
  renderPoster();
  setStatus("Page removed.", "success");
}

/* Which spine cards are in the rail right now. Saved with the post, because
   otherwise removing the text page and reopening would quietly bring it back
   and the removal would look like it had failed. */
function spineCardsInRail() {
  return slotOrder.filter((c) => c.el?.dataset?.page === "base").map((c) => c.mode);
}

function restoreSpineCards(modes) {
  // Older posts have no spine list. Leaving both in is the behaviour they
  // were saved under, so that is what they get.
  if (!Array.isArray(modes)) return;
  let changed = false;
  for (const card of basePage.cards) {
    const present = slotOrder.includes(card);
    const wanted = modes.includes(card.mode);
    if (present && !wanted) {
      slotOrder.splice(slotOrder.indexOf(card), 1);
      card.el?.remove();
      changed = true;
    } else if (!present && wanted) {
      /* Back to the front, in the spine's own order, rather than appended.
         A returning poster belongs at the start of the story — pushing it
         onto the end would silently reorder the post on open. */
      const at = card.mode === "pix" ? 0 : Math.min(1, slotOrder.length);
      slotOrder.splice(at, 0, card);
      changed = true;
    }
  }
  /* renumberPages() is what actually puts a card back on screen — it
     re-inserts every element before the add tile. restorePages() already ran
     it before this point, so without this call a restored card would sit in
     slotOrder while never appearing in the rail: present in the data, absent
     from the page. */
  if (changed) {
    renumberPages();
    renderPoster();
  }
}

/* Back to a blank story: the two spine cards, no added pages, no clip, no
   image, no copy.

   "Start a new post" is not only the New post button. That button reloads the
   document, so it never had to clear anything by hand — but Scrape & Build and
   Write Text start a new post inside a live tab, and everything the previous
   story built is still standing when they do.

   Clearing scalar fields on `state` is not enough on its own, and that is the
   part that is easy to get wrong: every field in ALL_PAGE_FIELDS is owned by a
   PAGE, and `page.content` — not live state — is what setActivePage() applies
   and what serializePages() writes. So story A's Video page stayed in the rail
   with its uploaded clip, A's storedVideoUrl went into story B's saved row,
   and QA publishing B shipped A's slides and A's footage to DailyMattr under
   B's headline. DailyMattr is write-only; that cannot be taken back. */
function resetPostModel() {
  /* Read the blanks first, while live state is still intact: blankPageContent()
     seeds headlineStyle and videoCaptionSize from `state` on purpose — those
     are settings the writer chose, not content belonging to the last story.
     base + story + video together cover exactly ALL_PAGE_FIELDS. */
  const blank = {
    ...blankPageContent("base"),
    ...blankPageContent("story"),
    ...blankPageContent("video"),
  };

  /* Drops every added page, unloads each one's parked <video>, resets
     activePageId and playerOwner, and renumbers the rail. It leaves the last
     clip loaded in the shared <video> element, which is deliberate and
     harmless: no card paints it once state.videoEl is cleared below, and the
     next video page's adoptPageVideo() detaches the src it does not want. */
  restorePages([]);
  // A spine card the last story removed belongs back in a fresh post.
  restoreSpineCards(["pix", "text"]);

  /* Not optional: setActivePage() applies basePage.content over live state on
     every selection, so without this the writer's first click on any card
     brings back A's headline, image and paragraph. If a non-base page was
     selected when the new post started, syncActivePageContent() has already
     folded A's base fields in there. */
  basePage.content = null;
  for (const field of ALL_PAGE_FIELDS) state[field] = clonePageValue(blank[field]);

  /* restorePages() sets activePageId by assignment, so live state and the
     editor controls were never refreshed from the now-blank base page. This is
     the call that pushes the cleared content out to both — applyDesignSnapshot
     ends the same way, for the same reason. */
  setActivePage("base", { force: true });
}

function removePage(id) {
  const index = pages.findIndex((p) => p.id === id);
  if (index <= 0) return;                    // the spine is not removable
  const [page] = pages.splice(index, 1);

  if (page.parkedVideo) {
    page.parkedVideo.removeAttribute("src");
    page.parkedVideo.load();
    page.parkedVideo = null;
  }
  // The shared player would otherwise still be held by a page that no
  // longer exists, and the next video page would decline to reload.
  if (playerOwner === page) playerOwner = null;
  for (const card of page.cards) {
    const slot = slotOrder.indexOf(card);
    if (slot >= 0) slotOrder.splice(slot, 1);
  }
  page.el?.remove();

  if (activePageId === id) {
    activePageId = "base";
    applyPageFields(basePage.content);
    adoptPageVideo(basePage);
    syncEditorFromState();
  }

  renumberPages();
  renderPoster();
  setStatus("Page removed.", "success");
}

function renumberPages() {
  const addTile = document.getElementById("preview-add");

  slotOrder.forEach((card, index) => {
    const number = index + 1;
    const numEl = card.el.querySelector(".preview-card-num");
    if (numEl) numEl.textContent = String(number);
    card.canvas?.setAttribute("aria-label", `Page ${number} — ${cardLabel(card)}`);
    // Re-inserting every card before the tile, in order, is what puts the
    // rail in slot order — including after a drag.
    addTile?.before(card.el);
  });

  const used = pageCount();
  const chip = document.getElementById("page-count-chip");
  if (chip) {
    chip.textContent = `${used} of ${MAX_PAGES} pages`;
    chip.classList.toggle("is-full", used >= MAX_PAGES);
  }
  const addBtn = document.getElementById("preview-add-btn");
  if (addBtn) {
    /* aria-disabled, not disabled. A disabled button does not fire a click at
       all, so pressing plus on a full rail produced silence — no menu, no
       message, nothing — and the writer concluded the editor was broken
       rather than that they had run out of slides. It still reads as disabled
       to assistive tech and still looks dimmed; the difference is that the
       handler now runs and can explain itself. */
    const room = canAddPage();
    addBtn.disabled = false;
    addBtn.setAttribute("aria-disabled", room ? "false" : "true");
    addBtn.title = room
      ? "Add another page"
      : `${MAX_PAGES} slides is the limit — the poster and the Text slide count too. Remove one to add another.`;
  }
  const hint = document.getElementById("preview-add-hint");
  if (hint) hint.textContent = canAddPage() ? `${MAX_PAGES - used} left` : "Full";

  syncPageSelectionUI();
}

function setActivePage(id, { force = false } = {}) {
  const next = getPage(id);
  if (!force && next.id === activePageId) return;

  syncActivePageContent();

  activePageId = next.id;

  applyPageFields(basePage.content);
  if (next !== basePage) applyPageFields(next.content);

  // Only another video page can take the shared player, so selecting a
  // poster or text page leaves it — and its clip — exactly where it was.
  if (next.type === "video") adoptPageVideo(next);
  syncEditorFromState();
  syncPageSelectionUI();
  renderPoster();
}

function syncPageSelectionUI() {
  document.querySelectorAll(".preview-card[data-page]").forEach((el) => {
    el.classList.toggle("is-selected", el.dataset.page === activePageId);
  });

  const page = activePage();
  const bar = document.getElementById("page-context");
  const name = document.getElementById("page-context-name");
  if (bar) bar.hidden = page === basePage;
  if (name && page !== basePage) {
    name.textContent = `Page ${cardNumber(page.cards[0])} · ${PAGE_TYPES[page.type]?.label || "Page"}`;
  }

  applyPageScope(page);
}

function applyPageScope(page) {
  const scope = PAGE_SCOPE[page.type] || PAGE_SCOPE.base;
  const setScope = (el, on) => {
    if (!el) return;
    el.classList.toggle("scope-off", !on);
    if ("disabled" in el) el.disabled = !on;
  };
  setScope(headlineEdit, scope.headline);
  /* The Size slider sizes the headline, so it belongs to the same gate. It was
     in no scope at all: on a Story or Text page the headline box sat visibly
     dimmed and disabled while the slider right beneath it stayed live — and
     moving it edited the poster on page 1, a card the writer was not looking
     at, with no visible effect on the page they were. */
  setScope(fontSizeInput, scope.headline);
  setScope(detailEdit, scope.detail);
  setScope(tagPresetsContainer, scope.tag);
  setScope(document.getElementById("video-acc"), scope.video);
  setScope(imagePanel, scope.image);
}

/* Push state back into the controls after a page switch — without this the
   panel would show the previous page's values over the new page's canvas. */
function syncEditorFromState() {
  if (headlineEdit) headlineEdit.value = state.headline || "";
  if (detailEdit) detailEdit.value = state.detailText || "";

  /* The story fields address the SELECTED page, so they follow the selection
     like every other page-scoped control — and they are hidden entirely off a
     story page, because there would be nothing for them to write to. */
  const storyBox = document.getElementById("story-fields");
  const headingEl = document.getElementById("story-heading-edit");
  const bodyEl = document.getElementById("story-body-edit");
  if (storyBox) storyBox.hidden = activePage()?.type !== "story";
  if (headingEl && headingEl.value !== (state.storyHeading || "")) headingEl.value = state.storyHeading || "";
  if (bodyEl && bodyEl.value !== (state.storyBody || "")) bodyEl.value = state.storyBody || "";
  const storySelected = activePage()?.type === "story";
  if (storyOpacityControl) storyOpacityControl.hidden = !storySelected;
  syncControl(storyOverlayOpacityInput, clamp(numberOr(state.storyOverlayOpacity, 100), 0, 100));
  syncControl(imgOffsetX, state.imageOffset?.x ?? 0);
  syncControl(imgOffsetY, state.imageOffset?.y ?? 0);
  syncControl(imgZoom, state.imageZoom);
  syncControl(fontSizeInput, state.fontSize);
  syncFilterUI();

  if (tagPresetsContainer) {
    tagPresetsContainer.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tag === state.tag);
    });
  }

  const captionInput = document.getElementById("video-caption");
  if (captionInput) captionInput.value = state.videoCaption || "";
  syncControl(document.getElementById("video-caption-size"), state.videoCaptionSize);
  const muteInput = document.getElementById("video-mute");
  if (muteInput) muteInput.checked = !!state.videoMuted;
  const videoEditor = document.getElementById("video-editor");
  if (videoEditor) videoEditor.hidden = !(state.videoSrc || state.videoUrl || state.videoFile);
  syncTrimUI();
}

/* ── One player, several video pages ──
   The editor has a single <video>, and `playerOwner` is the page whose clip
   is currently in it. Selecting a poster or text page changes nothing: the
   owner keeps the player, so the common case — one video page — never
   reloads. Only a second video page taking the player forces the previous
   owner onto a detached copy, parked at its own trim point, so its card
   keeps painting its own footage. */
let playerOwner = null;

function parkPageVideo(page) {
  if (!page || !videoPreviewEl || page.type !== "video") return;

  const src = videoPreviewEl.currentSrc || videoPreviewEl.getAttribute("src") || "";
  const content = page.content || (page.content = {});
  content.videoSrc = src;
  if (!src) { content.videoEl = null; return; }

  let parked = page.parkedVideo;
  if (!parked) {
    parked = document.createElement("video");
    parked.muted = true;
    parked.playsInline = true;
    parked.preload = "auto";
    page.parkedVideo = parked;
  }

  const at = videoPreviewEl.currentTime || content.trimStart || 0;
  if (parked.getAttribute("src") !== src) {
    parked.src = src;
    parked.addEventListener("loadeddata", () => {
      try { parked.currentTime = at; } catch { /* seek before metadata */ }
      renderPoster();
    }, { once: true });
    parked.load();
  } else {
    try { parked.currentTime = at; } catch { /* nothing loaded yet */ }
  }
  content.videoEl = parked;
}

function adoptPageVideo(page) {
  if (!page || !videoPreviewEl || page.type !== "video") return;

  const content = page.content || (page.content = {});

  // Already holding this page's clip — nothing to move.
  if (playerOwner === page) {
    content.videoEl = videoPreviewEl;
    state.videoEl = videoPreviewEl;
    return;
  }

  if (playerOwner && playerOwner !== page) parkPageVideo(playerOwner);

  /* Fall back to what the page actually stores.

     Only ONE video page is primed with a videoSrc on load (loadPixIntoEditor
     does it for design.video), so any other restored video page had an empty
     `wanted` — and an empty `wanted` meant this blanked the shared player
     instead of loading that page's own footage. Clicking the Video card made
     the clip that was visible a moment earlier disappear. storedUrl is the
     bucket copy; the link is re-previewed through the proxy the same way the
     fetch path does it. */
  const wanted = content.videoSrc
    || content.storedVideoUrl
    || (content.videoUrl ? `/api/video/preview?u=${encodeURIComponent(content.videoUrl)}` : "");
  const current = videoPreviewEl.currentSrc || videoPreviewEl.getAttribute("src") || "";

  if (wanted && wanted !== current) {
    const at = content.trimStart || 0;
    videoPreviewEl.addEventListener("loadeddata", () => {
      try { videoPreviewEl.currentTime = at; } catch { /* seek before metadata */ }
      renderPoster();
    }, { once: true });
    videoPreviewEl.src = wanted;
    videoPreviewEl.load();
  } else if (!wanted && current) {
    videoPreviewEl.removeAttribute("src");
    videoPreviewEl.load();
  }

  playerOwner = page;
  content.videoEl = videoPreviewEl;
  state.videoEl = videoPreviewEl;
  state.videoSrc = wanted;
}

/* The page whose clip save and publish should use. Extra video pages get a
   preview and their own Export MP4, but a post ships one video. */
function primaryVideoPage() {
  const withClip = pages.find((p) => p.type === "video"
    && (p.content?.videoUrl || p.content?.videoFile || p.content?.storedVideoUrl));
  return withClip || pages.find((p) => p.type === "video") || null;
}

function primaryVideoContent() {
  return primaryVideoPage()?.content || {};
}

/* Run something that reads and writes the post's video against the primary
   video page, whatever is selected. Anything it produces — a fresh encode,
   an uploaded URL — is folded back into that page rather than left on the
   page the writer happens to be looking at. */
async function withPrimaryVideo(fn) {
  syncActivePageContent();
  const live = capturePageFields(VIDEO_PAGE_FIELDS);
  const page = primaryVideoPage();

  applyPageFields(page
    ? Object.fromEntries(VIDEO_PAGE_FIELDS.map((f) => [f, clonePageValue(page.content?.[f])]))
    : blankPageContent("video"));

  try {
    return await fn();
  } finally {
    /* What fn actually produced — a fresh encode, an uploaded URL, a new clip
       key — read out of state before anything is restored over it. */
    const produced = capturePageFields(VIDEO_PAGE_FIELDS);
    if (page) Object.assign(page.content, produced);

    /* `live` is a snapshot taken BEFORE fn ran, so restoring it blindly puts
       the pre-upload values back into state. That is harmless while some other
       page is selected — the video page owns the fields and state's copy is
       irrelevant — but it is destructive when the video page is the one on
       screen, because then state IS that page's live copy and the very next
       syncActivePageContent() captures the stale snapshot straight back over
       the upload. The clip encoded, uploaded and logged successfully, and the
       row still saved storedUrl: null.

       Writers are routinely on the Video page when they press Save — it is
       the page they were just editing — so this was the common path, not the
       rare one. */
    applyPageFields(activePage() === page ? produced : live);
  }
}

/* Reopening a post saved before video became its own page: its clip has to
   land somewhere, so give it one. */
function ensureVideoPage() {
  return pages.find((p) => p.type === "video") || (canAddPage() ? createPage("video", null) : null);
}

/* restoreStoredVideo() finishes asynchronously, on loadedmetadata, and
   writes the trim range into live state — by which time the selection has
   moved back to page 1. Registering after it (listeners run in order) lets
   us catch those values and file them under the page they belong to.

   `loadToken` is loadPixIntoEditor's load counter; see the re-baseline at the
   foot of the handler for why this needs one. */
function bindRestoredVideoToPage(page, loadToken) {
  if (!videoPreviewEl || !page) return;
  videoPreviewEl.addEventListener("loadedmetadata", () => {
    Object.assign(page.content, capturePageFields(VIDEO_PAGE_FIELDS), {
      videoEl: videoPreviewEl,
      videoSrc: videoPreviewEl.currentSrc || videoPreviewEl.getAttribute("src") || "",
    });
    playerOwner = page;
    if (activePageId === page.id) syncEditorFromState();
    renderPoster();
    /* This handler is the real end of the open, long after loadPixIntoEditor's
       promise resolved — so its editorLoading window has already closed and
       cannot cover us. Everything just written (trimStart, trimEnd,
       storedVideoFor) was DERIVED from the row's own design.video, so it is
       what the library already holds, not an edit; without saying so, merely
       opening a post with a clip left the editor looking dirty and the idle
       poller wrote it back ~3s later — re-encoding the clip from a source URL
       that has usually expired. The token stops a slow clip belonging to the
       previously-open post from declaring the current one saved. */
    if (loadToken === editorLoadSeq) markPixSaved();
  }, { once: true });
}

function paintPoster() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  if (isVideoPreviewMode()) {
    drawPixVideoScreen();
    return;
  }

  if (isTextPreviewMode()) {
    drawPixTextScreen();
    return;
  }

  if (isStoryPreviewMode()) {
    drawStoryScreen();
    return;
  }

  // Compute headline layout + bottom-anchored top ONCE for this render and
  // share via state._render so drawBackground / drawTag / drawHeadline don't
  // each have to recompute the same thing.
  state._render = computeHeadlineLayoutAndTop();

  drawBackground();
  drawHero();
  drawTag();
  drawHeadline();
  drawHeadlineTimestamp();

  // Preview-only UI elements (not included in download).
  // Only the 9:16 preset shows the Reels-style engagement + nav bars; on
  // square / wide / 4:5 ratios these mockups don't make visual sense.
  if (!state.isDownloading && !isXRenderMode() && getLayout().showPreviewBars) {
    drawEngagementBar();
    drawNavBar();
  }

  // AI Enhance is only meaningful once a real background image is loaded
  const enhanceBtn = document.getElementById("ai-enhance-btn");
  if (enhanceBtn && !enhanceBtn.classList.contains("working")) {
    enhanceBtn.disabled = !state.mainImage;
  }
}

/**
 * Slide 2, video variant: the clip fills the frame with the Shortly/Pix
 * branding over it.
 *
 * This same function produces BOTH the on-screen preview and the transparent
 * PNG that ffmpeg burns into the exported MP4 — see renderVideoOverlayPng().
 * Sharing one renderer is the whole point: the branding in the file is
 * guaranteed to be what the user approved on screen, and the media service
 * never needs a font, a layout table, or a redeploy when the design changes.
 *
 * In overlay-export mode the video frame and the mockup chrome are skipped,
 * leaving gradient + logo on transparency.
 */
function drawPixVideoScreen() {
  const W = canvas.width;
  const H = canvas.height;
  const L = getLayout();
  const s = Math.min(W / 920, H / 1700);
  const overlayOnly = !!state.videoOverlayExport;

  ctx.save();

  if (!overlayOnly) {
    // Letterbox backdrop, then the current video frame scaled to cover.
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, W, H);
    const v = state.videoEl;
    if (v && v.readyState >= 2 && v.videoWidth > 0) {
      const scale = Math.max(W / v.videoWidth, H / v.videoHeight);
      const dw = v.videoWidth * scale;
      const dh = v.videoHeight * scale;
      // focus 0.5 is centred; 0 pins the left/top edge, 1 the right/bottom.
      // Only the overflowing axis can move, so the frame never shows letterbox.
      const f = state.videoFocus || { x: 0.5, y: 0.5 };
      ctx.drawImage(v, -(dw - W) * f.x, -(dh - H) * f.y, dw, dh);
    }
  }

  // Bottom scrim so the logo and any platform UI stay legible over bright
  // footage. Lighter than the poster's gradient — the video is the subject
  // here, not a backdrop for a headline.
  const fade = Math.min(H * 0.42, L.gradient.fadeHeight * 1.5);
  const grad = ctx.createLinearGradient(0, H - fade, 0, H);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(0.55, "rgba(0,0,0,0.34)");
  grad.addColorStop(1, "rgba(0,0,0,0.72)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, H - fade, W, fade);

  // A matching top scrim keeps the logo readable on light footage.
  const topFade = H * 0.18;
  const topGrad = ctx.createLinearGradient(0, 0, 0, topFade);
  topGrad.addColorStop(0, "rgba(0,0,0,0.46)");
  topGrad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, W, topFade);

  drawFixedLogos();
  drawVideoCaption();

  // Mockup chrome is preview-only — it must never reach the exported file.
  if (!overlayOnly && !state.isDownloading && getLayout().showPreviewBars) {
    drawEngagementBar();
    drawPixPageDots(0.5 * W, 1558 * (H / 1700), s);
    drawNavBar();
  }

  ctx.restore();
}

/**
 * Caption burned into the video slide, bottom-anchored like the poster
 * headline. Supports the same [bracket] / (paren) / {brace} highlight
 * syntax as the headline, so the two slides look like one system.
 *
 * Drawn inside drawPixVideoScreen, which means it lands in BOTH the live
 * preview and the transparent PNG ffmpeg composites — no server change was
 * needed to add this.
 *
 * Bottom padding matches the headline preset, which is already tuned to sit
 * above the platform's own UI (the engagement/nav bars the preview mocks up).
 */
function drawVideoCaption() {
  const raw = (state.videoCaption || "").trim();
  if (!raw) return;

  const W = canvas.width;
  const H = canvas.height;
  const L = getLayout();
  const s = Math.min(W / 920, H / 1700);

  const maxWidth = L.headline.maxWidth;
  const left = L.headline.x;
  const fontSize = Math.round((state.videoCaptionSize || 40) * s);
  const lineHeight = Math.round(fontSize * 1.32);
  const font = `${PREVIEW_TEXT_WEIGHT} ${fontSize}px ${PREVIEW_TEXT_FONT}`;

  ctx.save();
  ctx.font = font;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  // Wrap on the visible text — bracket characters are markup, not glyphs, so
  // measuring with them in would wrap too early. Newlines are honoured as
  // deliberate breaks: each segment wraps on its own.
  const lines = [];
  for (const segment of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (!line || ctx.measureText(test.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, "")).width <= maxWidth) {
        line = test;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }

  const MAX_LINES = 4;
  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES;
    lines[MAX_LINES - 1] = `${lines[MAX_LINES - 1].replace(/[\s.,;:]+$/, "")}…`;
  }

  const blockHeight = lines.length * lineHeight;
  const top = H - L.headline.bottomPadding * (H / 1700) - blockHeight;

  // Pass 1 — accent boxes behind highlighted runs.
  let highlighted = false;
  lines.forEach((text, i) => {
    const y = top + i * lineHeight;
    let cursor = left;
    let segStart = null;
    let segWidth = 0;
    const segments = [];
    const parts = text.split(" ");

    parts.forEach((rawWord, idx) => {
      const opening = HIGHLIGHT_OPEN_CHAR.test(rawWord);
      const closing = HIGHLIGHT_CLOSE_CHAR.test(rawWord);
      const clean = rawWord.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, "");
      if (opening) highlighted = true;

      const wordWidth = ctx.measureText(clean).width;
      const advance = wordWidth + ctx.measureText(" ").width;

      if (highlighted && clean.length) {
        if (segStart === null) segStart = cursor;
        segWidth += (closing || idx === parts.length - 1) ? wordWidth : advance;
      }
      if ((closing || idx === parts.length - 1) && segStart !== null) {
        segments.push({ x: segStart, w: segWidth });
        segStart = null;
        segWidth = 0;
      }
      if (closing) highlighted = false;
      cursor += advance;
    });

    ctx.fillStyle = state.accent;
    const padX = fontSize * 0.16;
    const padY = fontSize * 0.14;
    segments.forEach(seg => {
      const r = fontSize * 0.18;
      const bx = seg.x - padX;
      const by = y - padY;
      const bw = seg.w + padX * 2;
      const bh = fontSize + padY * 2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, r);
      else ctx.rect(bx, by, bw, bh);
      ctx.fill();
    });
  });

  // Pass 2 — the words themselves.
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = 16 * s;
  ctx.shadowOffsetY = 5 * s;
  lines.forEach((text, i) => {
    ctx.fillText(text.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, ""), left, top + i * lineHeight);
  });

  ctx.restore();
}

/**
 * Render the video branding to a transparent PNG blob at exactly
 * `width`×`height` — the dimensions ffmpeg will scale the clip to, so the
 * overlay lands pixel-for-pixel with no resampling drift.
 */
async function renderVideoOverlayPng(width, height) {
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const outCtx = out.getContext("2d");
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = "high";
  // Design-space → output-space. The canvas preset drives layout, so this is
  // a uniform scale by construction and the overlay can't skew.
  outCtx.scale(width / canvas.width, height / canvas.height);

  const prevCtx = ctx;
  const prevMode = state.previewMode;
  const prevTargeted = state._targetedRender;
  ctx = outCtx;
  state.videoOverlayExport = true;
  state.previewMode = "video";
  state._targetedRender = true;
  try {
    drawPixVideoScreen();
  } finally {
    ctx = prevCtx;
    state.videoOverlayExport = false;
    state.previewMode = prevMode;
    state._targetedRender = prevTargeted;
  }

  return new Promise((resolve) => {
    try { out.toBlob(resolve, "image/png"); } catch { resolve(null); }
  });
}

/**
 * Output size for the exported MP4. Width is pinned to 1080 (the practical
 * ceiling for Reels/Stories/Shorts) and height follows the CANVAS aspect,
 * not a nominal 9:16 — the "9:16" preset is really 920×1700 (0.541), so
 * assuming true 9:16 here would misalign the overlay by ~90px.
 * Both dimensions are forced even; libx264 + yuv420p requires it.
 */
function videoTargetSize() {
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  // The overlay is drawn, not resampled, so targeting a larger frame than the
  // design canvas costs nothing in quality. Portrait and square go to 1080
  // wide (the Reels/Stories/Shorts standard); landscape goes to 1920.
  const width = even(canvas.width > canvas.height ? 1920 : 1080);
  const height = even(width * (canvas.height / canvas.width));
  return { width, height };
}

/* ── Preview repaint loop ──
   A <video> gives the canvas no "new frame" signal, so during playback we
   repaint every animation frame. It runs ONLY while the clip is actually
   playing — a paused video produces identical frames, and looping on those
   would burn a core for nothing. Seeks and loads repaint once instead
   (see the listeners further down). */
let videoPreviewRaf = 0;

function startVideoPreviewLoop() {
  if (videoPreviewRaf) return;
  const tick = () => {
    const v = state.videoEl;
    // Park as soon as the mode changes or playback stops.
    if (!v || v.paused || v.ended) {
      videoPreviewRaf = 0;
      renderPoster();   // settle on the final frame
      return;
    }
    renderPoster();
    videoPreviewRaf = requestAnimationFrame(tick);
  };
  videoPreviewRaf = requestAnimationFrame(tick);
}

function stopVideoPreviewLoop() {
  if (videoPreviewRaf) cancelAnimationFrame(videoPreviewRaf);
  videoPreviewRaf = 0;
}

function drawPixTextScreen() {
  const image = state.mainImage || defaultMain;
  const W = canvas.width;
  const H = canvas.height;
  const L = getLayout();
  const s = Math.min(W / 920, H / 1700);

  ctx.save();
  ctx.fillStyle = "#070707";
  ctx.fillRect(0, 0, W, H);

  drawTextPreviewBackgroundImage(image, 0, 0, W, H, state.imageOffset, (state.imageZoom || 100) / 100, s);

  const dim = ctx.createLinearGradient(0, 0, 0, H);
  dim.addColorStop(0, "rgba(0, 0, 0, 0.68)");
  dim.addColorStop(0.34, "rgba(0, 0, 0, 0.52)");
  dim.addColorStop(0.62, "rgba(0, 0, 0, 0.68)");
  dim.addColorStop(1, "rgba(0, 0, 0, 0.98)");
  ctx.fillStyle = dim;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
  ctx.fillRect(0, 0, W, H);

  drawFixedLogos();

  const textX = L.headline.x;
  const minTextY = state.forceTextExport ? H * 0.16 : H * 0.1;
  const bottomTextPadding = state.forceTextExport ? L.headline.bottomPadding : 335;
  const lastLineY = H - bottomTextPadding * (H / 1700);
  drawWrappedPreviewText(getDetailTextForPreview(), textX, minTextY, L.headline.maxWidth, lastLineY, 39 * s, 61 * s);

  if (!state.forceTextExport) {
    drawEngagementBar();
    drawPixPageDots(0.5 * W, 1558 * (H / 1700), s);
    drawNavBar();
  }

  ctx.restore();
}

/* ── Story page ───────────────────────────────────────────────────────
   Its own image, its own heading, its own body copy — one slide making one
   point, which is what a swipeable story is made of.

   Distinct from the text page on purpose. A text page takes a SLICE of the
   post's single paragraph, so its words depend on how many text pages exist;
   add a page and every other page's words move. A story page is written
   directly, so a slide keeps what you wrote on it.

   The image is drawn full-bleed under a gradient that goes almost solid
   towards the bottom, rather than as a fixed top band. A hard split has to
   pick a height, and the reference slides do not agree on one — some are
   nearly full-photo, some are half. The gradient reads as either, and it
   never leaves a bare strip when a portrait image cannot fill a band. */
const STORY = {
  headingSize: 44,       // against the 920x1700 reference frame
  bodySize: 46,
  bodyLineHeight: 62,
  /* Raised from 7 once typed line breaks started counting: a short list burns
     a line per item, so the old cap cut off copy that fitted the frame fine.
     Ten still clears the picture — ten lines plus a heading leaves the block
     starting a little above the halfway mark. */
  maxBodyLines: 10,
  gapAfterHeading: 34,
  bottomPadding: 300,
};

function storyHeadingText() {
  /* No fallback to the post headline. A story page carries whatever is typed
     on it and nothing else — inheriting the headline put the poster's words
     on every story slide, which then had to be cleared by hand on each one,
     and an untouched page looked finished when it was not. Empty means empty:
     the heading is simply not drawn, and the body moves up to fill the space.

     Whitespace is flattened because the heading is drawn as one line: the
     accent box is measured across a single run, so a typed break would put
     the highlight in the wrong place rather than start a second row. Breaks
     belong in the body. */
  return (state.storyHeading || "").replace(/\s+/g, " ").trim();
}

function storyBodyText() {
  return (state.storyBody || "").trim();
}

/* One line of heading, with its [bracketed] runs set in the accent colour.

   The poster headline marks its highlights with a filled block behind white
   text. A story slide sits on a photograph rather than on a solid panel, and a
   block there fights the picture instead of sitting on it — so the same
   [bracket] markup paints the WORDS accent-blue and leaves the rest white.
   Marked and unmarked words therefore differ by colour, not by background. */
function drawStoryHeading(text, left, baselineTop, fontSize, s) {
  if (!text) return baselineTop;
  ctx.save();
  ctx.font = `600 ${Math.round(fontSize)}px 'Roboto Serif', 'Poppins', serif`;
  ctx.textBaseline = "top";

  // Which words fall inside a highlighted run.
  const words = [];
  let open = false;
  text.split(" ").forEach((rawWord) => {
    const opening = HIGHLIGHT_OPEN_CHAR.test(rawWord);
    const closing = HIGHLIGHT_CLOSE_CHAR.test(rawWord);
    if (opening) open = true;
    words.push({ text: rawWord.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, ""), marked: open });
    if (closing) open = false;
  });

  /* No brackets anywhere means the writer wants the whole heading marked — on
     this layout the accent IS the heading treatment, and a plain white line
     reads as a stray sentence rather than a kicker. */
  if (!words.some((w) => w.marked)) words.forEach((w) => { w.marked = true; });

  /* The shadow does the work the block used to: coloured text on a photograph
     needs something to lift it off whatever happens to be behind it. */
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = 14 * s;
  ctx.shadowOffsetY = 4 * s;

  const space = ctx.measureText(" ").width;
  let cursor = left;
  for (const word of words) {
    if (!word.text.length) continue;
    ctx.fillStyle = word.marked ? state.accent : "#ffffff";
    ctx.fillText(word.text, cursor, baselineTop);
    cursor += ctx.measureText(word.text).width + space;
  }

  ctx.restore();

  return baselineTop + fontSize;
}

function drawStoryScreen() {
  const image = state.mainImage || defaultMain;
  const W = canvas.width;
  const H = canvas.height;
  const L = getLayout();
  const s = Math.min(W / 920, H / 1700);

  ctx.save();
  ctx.fillStyle = "#070707";
  ctx.fillRect(0, 0, W, H);

  // "none": a story slide shows its picture sharp. The gradient below is what
  // makes the copy readable, not a blur across the whole frame.
  drawTextPreviewBackgroundImage(image, 0, 0, W, H, state.imageOffset, (state.imageZoom || 100) / 100, s, "none");

  const left = L.headline.x;
  const maxWidth = L.headline.maxWidth;
  const body = storyBodyText();

  /* Laid out from the bottom up, like the poster headline: the block is
     anchored to a fixed distance from the foot of the frame so slides with
     different amounts of copy still line up as a set when swiped. */
  ctx.textBaseline = "top";
  const headingSize = STORY.headingSize * s;
  const bodySize = STORY.bodySize * s;
  const bodyLine = STORY.bodyLineHeight * s;

  ctx.font = `600 ${Math.round(bodySize)}px 'Roboto Serif', 'Poppins', serif`;
  const bodyLines = body ? wrapPlainLines(body, maxWidth, STORY.maxBodyLines) : [];

  const headingHeight = storyHeadingText() ? headingSize + STORY.gapAfterHeading * s : 0;
  const bodyHeight = bodyLines.length * bodyLine;
  const stampHeight = state.showTimestamp ? bodyLine * 0.9 : 0;
  const blockHeight = headingHeight + bodyHeight + stampHeight;
  const top = H - STORY.bottomPadding * (H / 1700) - blockHeight;

  /* Measured BEFORE the fade is painted, because the fade is anchored to the
     top of this block — the same way the headline page anchors to its first
     line. The fade used to be painted first, which is exactly why it could
     only ever be a fixed wash over the whole frame: at that point nothing
     here knew where the copy was going to land. */
  blurBehindCopy(ctx, {
    width: W,
    height: H,
    copyTop: top,
    fadeHeight: fadeReach(L.gradient.fadeHeight),
    radius: FADE_BLUR_RADIUS * (H / 1700),
  });
  paintBottomFade(ctx, {
    width: W,
    height: H,
    copyTop: top,
    fadeHeight: L.gradient.fadeHeight,
    // The story page's own overlay control still rides on top of the shape.
    opacity: clamp(numberOr(state.storyOverlayOpacity, 100) / 100, 0, 1),
    tint: imageFadeTint(image),
  });

  drawFixedLogos();

  let y = top;
  if (storyHeadingText()) {
    y = drawStoryHeading(storyHeadingText(), left, y, headingSize, s) + STORY.gapAfterHeading * s;
  }

  ctx.save();
  ctx.font = `600 ${Math.round(bodySize)}px 'Roboto Serif', 'Poppins', serif`;
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = 12 * s;
  ctx.shadowOffsetY = 3 * s;
  bodyLines.forEach((line, i) => ctx.fillText(line, left, y + i * bodyLine));
  ctx.restore();

  if (state.showTimestamp) drawTimestamp(left, y + bodyHeight + bodyLine * 0.16, s);

  if (!state.isDownloading) {
    drawEngagementBar();
    drawNavBar();
  }

  ctx.restore();
}

/* Plain greedy wrap against the CURRENT ctx.font. Deliberately not
   drawWrappedPreviewText: that one auto-shrinks to fit a box and understands
   bullets, neither of which a story body wants — the copy is short and the
   size should be the same on every slide of a set. */
function wrapPlainLines(text, maxWidth, maxLines) {
  const lines = [];

  /* The writer's own line breaks come first, and each block is wrapped to the
     column after that. One greedy pass over `\s+`-collapsed text — which is
     what this used to be — threw every deliberate break away, so a typed list
     came out as a single run-on line and pressing Enter appeared to do
     nothing at all. A break is a break; only runs of spaces and tabs inside a
     line are worth collapsing. */
  const blocks = String(text).replace(/\r\n?/g, "\n").split("\n");

  for (const block of blocks) {
    const trimmed = block.replace(/[ \t]+/g, " ").trim();
    if (!trimmed) {
      lines.push("");             // a blank line the writer left stays blank
      continue;
    }
    let line = "";
    for (const word of trimmed.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= maxWidth) {
        line = next;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }

      /* A single word wider than the column — a pasted URL, nearly always.
         Letting it through whole (which is what an `|| !line` escape does)
         put it half outside the frame with the tail simply gone. Break it at
         the column edge instead: a URL split across two lines still reads,
         one that walks off the canvas does not. */
      let rest = word;
      while (ctx.measureText(rest).width > maxWidth) {
        let cut = 1;
        while (cut < rest.length && ctx.measureText(rest.slice(0, cut + 1)).width <= maxWidth) cut++;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    if (line) lines.push(line);
  }

  /* Trailing blanks are just the cursor resting on a new row. Counting them
     would spend the line budget on nothing and, since the block is laid out
     bottom-up, shove the copy upward as you type. */
  while (lines.length && lines[lines.length - 1] === "") lines.pop();

  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[\s.,;:]+$/, "")}…`;
  }
  return lines;
}

/**
 * Creation timestamp under the slide-2 paragraph — "07 Aug | 12:30 PM".
 *
 * Left edge aligns with the paragraph (same textX) so the two form one
 * block rather than two loosely stacked things. Sits one paragraph-line
 * below the last line of copy.
 *
 * Spec was Poppins / 70% opacity / 10px. The 10 is a Figma-frame value and
 * frames differ in width, so it is expressed here relative to the 39px
 * paragraph and scaled with the canvas — that keeps the proportion in the
 * reference at every aspect ratio. TIMESTAMP_SIZE is the one number to
 * change if it should read larger or smaller.
 */
const TIMESTAMP_SIZE = 21;      // design px, against a 39px paragraph
const TIMESTAMP_OPACITY = 0.82;
const TIMESTAMP_COLOR = "#ffffff";

/**
 * Date only — "07 Aug". No time.
 *
 * toLocaleDateString with no `timeZone` option resolves in the runtime's own
 * zone, which is the browser's, which follows the operating system. So the
 * date is whatever the person looking at the screen would call today, with
 * no conversion and nothing to configure.
 *
 * This matters more than it looks: a UTC-based date is wrong for a third of
 * every day in IST (UTC+5:30) — anything created before 05:30 local would
 * carry yesterday's date.
 */
function formatCreatedAt(date) {
  // Reads the clock at paint time. This used to render a Date frozen when the
  // page loaded, which is wrong for the way the app is actually used: the tab
  // stays open for days, so the stamp would sit on yesterday's date — or last
  // week's — without anyone noticing.
  const d = date instanceof Date && !isNaN(date) ? date : new Date();
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

/**
 * Place the stamp directly beneath the poster headline.
 *
 * The headline is bottom-anchored and its block height changes with the line
 * count, so the position is derived from the cached layout rather than a
 * fixed y — otherwise a two-line headline would leave a gap and a four-line
 * one would collide.
 */
function drawHeadlineTimestamp() {
  if (!state.showTimestamp) return;
  const L = getLayout();
  const cached = state._render || computeHeadlineLayoutAndTop();
  const s = Math.min(canvas.width / 920, canvas.height / 1700);
  // Sit just under the last headline line, left edge shared with it.
  const y = cached.top + cached.blockHeight + Math.round(14 * s);
  drawTimestamp(L.headline.x, y, s);
}

function drawTimestamp(x, y, s) {
  if (!state.showTimestamp) return;
  ctx.save();
  ctx.globalAlpha = TIMESTAMP_OPACITY;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  // Keep the complete date, including the month, firmly legible at export
  // size while reusing the same Poppins face as the paragraph copy.
  ctx.font = `700 ${Math.round(TIMESTAMP_SIZE * s)}px ${PREVIEW_TEXT_FONT}`;
  // A soft shadow only — at 70% over a blurred photo the glyphs would
  // otherwise disappear against light areas.
  ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
  ctx.shadowBlur = 10 * s;
  ctx.shadowOffsetY = 2 * s;
  ctx.fillStyle = TIMESTAMP_COLOR;
  ctx.fillText(formatCreatedAt(state.createdAt), x, y);
  ctx.restore();
}

/* `filter` defaults to the Text slide's treatment: heavily blurred and dimmed,
   because there the picture is a backdrop for a wall of copy and has to stay
   out of its way. A story slide is the opposite — the photo is the point, and
   the gradient alone keeps the lower copy legible — so it passes "none" and
   gets the image sharp. */
function drawTextPreviewBackgroundImage(image, x, y, width, height, offset, zoom, scale = 1, filter) {
  const bleed = 34 * scale;
  const drawX = x - bleed;
  const drawY = y - bleed;
  const drawW = width + bleed * 2;
  const drawH = height + bleed * 2;
  const baseScale = Math.max(drawW / image.width, drawH / image.height);
  const imageScale = baseScale * (zoom || 1) * IMAGE_PAN_HEADROOM;
  const drawWidth = image.width * imageScale;
  const drawHeight = image.height * imageScale;
  const focal = image.__focalPoint || { x: image.width / 2, y: image.height / 2 };

  ctx.save();

  /* ── The backdrop, which is what stops a zoomed-out photo ending in a line ──

     The zoom slider runs down to 10% while IMAGE_PAN_HEADROOM is 1.1, so below
     about 87% the picture no longer reaches the edges of the frame. The clamp
     below cannot save it: with the image smaller than the frame the minimum
     runs past the maximum, and clamp() collapses to the maximum, pinning the
     picture to the top-left. Everything under it was the flat #070707 the page
     starts with — a hard horizontal edge across the card, which is exactly the
     line that kept being reported and kept not being the gradient.

     This layer is drawn at COVER scale with no zoom and no offset applied, so
     it always reaches every edge whatever the sliders say. It is blurred and
     dimmed because it is scenery, not the subject. Above about 87% zoom the
     sharp layer covers it completely and it makes no difference to anything —
     it only becomes visible at the point where the alternative was a black
     band. */
  const backdropScale = baseScale * IMAGE_PAN_HEADROOM;
  ctx.filter = `blur(${Math.round(26 * scale)}px) brightness(52%) saturate(78%)`;
  drawLayer(backdropScale, null);

  ctx.filter = filter || `blur(${Math.round(18 * scale)}px) brightness(62%) contrast(108%) saturate(72%)`;
  drawLayer(imageScale, null);
  drawLayer(imageScale, offset);
  ctx.restore();

  function drawLayer(layerScale, layerOffset) {
    const w = image.width * layerScale;
    const h = image.height * layerScale;
    let dx = drawX + drawW / 2 - focal.x * layerScale;
    let dy = drawY + drawH / 2 - focal.y * layerScale;

    if (layerOffset) {
      dx += layerOffset.x;
      dy += layerOffset.y;
    }

    /* Only worth clamping while the image is bigger than the frame — that is
       what the clamp is for, keeping a pan from dragging an edge into view.
       Below that it has no meaning, and applying it anyway is what jammed a
       small picture into the corner instead of leaving it centred. */
    if (w >= drawW) dx = clamp(dx, drawX + drawW - w, drawX);
    if (h >= drawH) dy = clamp(dy, drawY + drawH - h, drawY);
    ctx.drawImage(image, dx, dy, w, h);
  }
}

function drawTextPreviewLogo(x, y, size) {
  const logo = state.logoImage || state.shortlyLogoImage;
  if (!logo) return;

  const rawW = logo.naturalWidth || logo.width || 1;
  const rawH = logo.naturalHeight || logo.height || 1;
  const scale = size / Math.max(rawW, rawH);
  const drawW = rawW * scale;
  const drawH = rawH * scale;
  drawLogoAt(logo, x, y, drawW, drawH);
}

function drawPixStatusBar(scaleX, scaleY, s) {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${Math.round(29 * s)}px 'Inter', 'Segoe UI', Arial, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("9:41", 104 * scaleX, 45 * scaleY);

  const right = canvas.width - 72 * scaleX;
  const y = 45 * scaleY;

  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "#ffffff";
  ctx.lineWidth = 4 * s;
  for (let i = 0; i < 4; i += 1) {
    const h = (9 + i * 6) * s;
    ctx.fillRect(right - 140 * scaleX + i * 14 * scaleX, y + 17 * scaleY - h, 7 * scaleX, h);
  }

  ctx.beginPath();
  ctx.arc(right - 70 * scaleX, y + 6 * scaleY, 30 * s, Math.PI * 1.18, Math.PI * 1.82);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(right - 70 * scaleX, y + 6 * scaleY, 18 * s, Math.PI * 1.18, Math.PI * 1.82);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(right - 70 * scaleX, y + 8 * scaleY, 4 * s, 0, Math.PI * 2);
  ctx.fill();

  const bx = right - 18 * scaleX;
  const by = y - 14 * scaleY;
  const bw = 52 * scaleX;
  const bh = 25 * scaleY;
  ctx.lineWidth = 3 * s;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 6 * s);
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(bx + bw + 4 * scaleX, by + 8 * scaleY, 4 * scaleX, 9 * scaleY);
  ctx.beginPath();
  ctx.roundRect(bx + 5 * scaleX, by + 5 * scaleY, bw - 10 * scaleX, bh - 10 * scaleY, 4 * s);
  ctx.fill();
  ctx.restore();
}

function drawWrappedPreviewText(text, x, minY, maxWidth, maxY, fontSize, lineHeight) {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.shadowColor = "rgba(0, 0, 0, 0.48)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 5;

  const preserveOpenBullet = !state.isDownloading && state.previewMode === "text";
  const fit = fitPreviewTextLines(text, maxWidth, minY, maxY, fontSize, lineHeight, { preserveOpenBullet });
  const { lines, visibleLines } = fit;
  const overflowed = lines.length > visibleLines.length;
  let ellipsisIndex = -1;
  if (overflowed) {
    ellipsisIndex = visibleLines.length - 1;
    while (ellipsisIndex > 0 && !visibleLines[ellipsisIndex]) ellipsisIndex -= 1;
    visibleLines[ellipsisIndex] = `${visibleLines[ellipsisIndex]}...`;
  }

  ctx.font = `${PREVIEW_TEXT_WEIGHT} ${Math.round(fit.fontSize)}px ${PREVIEW_TEXT_FONT}`;
  const visibleHeight = visibleLines.reduce((sum, line) => sum + getPreviewTextStep(line, fit.lineHeight), 0);
  const startY = Math.max(minY, maxY - Math.max(0, visibleHeight - fit.lineHeight));
  let cy = startY;
  visibleLines.forEach((visibleLine, index) => {
    if (visibleLine) {
      if (index === ellipsisIndex) {
        drawEllipsizedLine(visibleLine, x, cy, maxWidth);
      } else {
        ctx.fillText(visibleLine, x, cy);
      }
    }
    cy += getPreviewTextStep(visibleLine, fit.lineHeight);
  });
  ctx.restore();
}

function fitPreviewTextLines(text, maxWidth, minY, maxY, fontSize, lineHeight, options = {}) {
  const canShrink = state.previewMode === "text";
  const scales = canShrink ? [1, 0.92, 0.84, 0.76, 0.68, 0.62] : [1];
  let bestFit = null;

  for (const scale of scales) {
    const nextFontSize = Math.max(fontSize * scale, fontSize * 0.62);
    const nextLineHeight = Math.max(nextFontSize * 1.34, lineHeight * scale);
    ctx.font = `${PREVIEW_TEXT_WEIGHT} ${Math.round(nextFontSize)}px ${PREVIEW_TEXT_FONT}`;
    const lines = buildPreviewTextLines(text, maxWidth, options);
    const maxBlockHeight = Math.max(nextLineHeight, maxY - minY + nextLineHeight);
    const visibleLines = getVisiblePreviewLines(lines, nextLineHeight, maxBlockHeight);
    const fit = { fontSize: nextFontSize, lineHeight: nextLineHeight, lines, visibleLines };
    bestFit = fit;
    if (visibleLines.length === lines.length) return fit;
  }

  return bestFit;
}

function getVisiblePreviewLines(lines, lineHeight, maxBlockHeight) {
  const visibleLines = [];
  let blockHeight = 0;
  for (const line of lines) {
    const step = getPreviewTextStep(line, lineHeight);
    if (visibleLines.length && blockHeight + step > maxBlockHeight) break;
    visibleLines.push(line);
    blockHeight += step;
  }
  return visibleLines.length ? visibleLines : [lines[0] || ""];
}

function getPreviewTextStep(line, lineHeight) {
  return line ? lineHeight : lineHeight * (state.previewMode === "text" ? 0.28 : 0.42);
}

function buildPreviewTextLines(text, maxWidth, options = {}) {
  const sourceLines = limitDetailTextClient(text, options).split("\n");
  const lines = [];
  sourceLines.forEach((sourceLine) => {
    const trimmed = sourceLine.trim();
    if (!trimmed) {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      return;
    }

    const lineText = /^[\u2022*-]\s+/.test(trimmed) ? `\u2022 ${trimmed.replace(/^[\u2022*-]\s+/, "")}` : trimmed;
    lines.push(...wrapPreviewTextLine(lineText, maxWidth));
  });

  return lines.length ? lines : [""];
}

function wrapPreviewTextLine(text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  words.forEach((word) => {
    const test = line ? `${line} ${word}` : word;
    if (!line || ctx.measureText(test).width <= maxWidth) {
      line = test;
      return;
    }

    lines.push(line);
    line = word;
  });

  if (line) lines.push(line);
  return lines;
}

function drawEllipsizedLine(line, x, y, maxWidth) {
  let output = line.endsWith("...") ? line : `${line}...`;
  while (output.length > 4 && ctx.measureText(output).width > maxWidth) {
    output = `${output.slice(0, -4).trimEnd()}...`;
  }
  ctx.fillText(output, x, y);
}

function drawPixPageDots(cx, cy, s) {
  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.24)";
  ctx.beginPath();
  ctx.arc(cx - 11 * s, cy, 7 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx + 11 * s, cy, 7 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBackground() {
  ctx.fillStyle = "#050505";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const glow = ctx.createRadialGradient(110, 90, 0, 110, 90, 350);
  glow.addColorStop(0, "rgba(139, 92, 246, 0.24)");
  glow.addColorStop(1, "rgba(139, 92, 246, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

/* ── The bottom fade, drawn the same way on every page that carries copy ──

   One continuous rise: transparent above the words, dark enough at the first
   line to keep them readable while some photograph still shows through, then
   progressively darker to solid black at the foot of the frame.

   It is anchored to `copyTop` rather than to the frame, which is what makes a
   set of slides look like a set: the fade follows the copy up when there are
   more lines and down when there are fewer, so the picture gives way to ink at
   the same distance above the text every time.

   Shared because the two pages had drifted apart. The headline page had this
   curve; the story page had a flat wash over the WHOLE frame — a 12% veil
   across the top, so its photograph never showed clean, and a jump from 0.30
   to 0.86 across sixteen percent of the height that read as a band rather
   than a fade. Same picture, two different treatments, depending only on
   which slide you were looking at.

   `opacity` scales the whole curve, for the story page's overlay control. It
   multiplies rather than replaces, so the shape survives at every setting. */
/* ── Frosted glass under the copy ────────────────────────────────────────────

   The fade darkens the picture; this softens it. Together they are what makes
   text sitting on a photograph look deliberate rather than dropped on top —
   the eye stops reading detail exactly where it starts reading words.

   Blur alone would be worse than nothing, because a blurred band has edges. So
   it is masked with the same shape the fade uses: nothing at the top, full
   blur by the copy line, which means there is no boundary anywhere for the eye
   to catch. Same anchor, same reach, so the two effects move together when the
   copy moves.

   The whole frame is blurred and then masked, rather than blurring just the
   band. Blurring a band samples the transparent nothing beyond its edges and
   comes back with a dark rim along them; blurring the full canvas means every
   sample has real pixels under it and the mask decides what survives. */
/* Matched to the fade's own reach so the two cannot drift apart, and scaled
   off the frame so a 1080-wide export is blurred by the same amount a 920
   preview is rather than a fifth less. */
const FADE_BLUR_RADIUS = 26;          // against the 1700px reference frame
const FADE_STRETCH = 1.6;             // must match paintBottomFade

function fadeReach(layoutFade) {
  return layoutFade * FADE_STRETCH;
}

function blurBehindCopy(target, { width, height, copyTop, fadeHeight, radius }) {
  const start = Math.max(0, copyTop - fadeHeight);
  if (height - start <= 0 || radius <= 0) return;

  const source = target.canvas;
  if (!source) return;

  try {
    const off = document.createElement("canvas");
    off.width = width;
    off.height = height;
    const octx = off.getContext("2d");

    octx.filter = `blur(${radius}px)`;
    octx.drawImage(source, 0, 0, width, height);
    octx.filter = "none";

    /* Keep only what the mask says to keep. `destination-in` intersects what
       is already on this canvas with the alpha being painted, which is how the
       blur arrives gradually instead of as a panel. */
    const mask = octx.createLinearGradient(0, start, 0, copyTop);
    mask.addColorStop(0, "rgba(0,0,0,0)");
    mask.addColorStop(1, "rgba(0,0,0,1)");
    octx.globalCompositeOperation = "destination-in";
    octx.fillStyle = mask;
    octx.fillRect(0, start, width, height - start);
    octx.globalCompositeOperation = "source-over";

    target.drawImage(off, 0, 0, width, height);
  } catch {
    /* A tainted canvas cannot be read back. The fade still runs and the card
       is still legible — it just is not frosted, which is the right way for
       this to degrade. */
  }
}

function paintBottomFade(target, { width, height, copyTop, fadeHeight: layoutFade, opacity = 1, tint = null }) {
  /* How far the fade reaches above the copy, as a multiple of the layout's
     own fadeHeight. That value was tuned for a fade that lands quickly, and
     the ink still has to reach full strength by the first line — so a short
     ramp arrives there steeply and then has nothing left to do but sit at
     flat black for the rest of the frame. Stretching it lowers the arrival
     slope by the same proportion, 38% gentler at 1.6, which is what turns the
     darkening into a steady build rather than a late rush onto a flat panel. */
  const fadeHeight = fadeReach(layoutFade);
  const start = Math.max(0, copyTop - fadeHeight);
  const span = height - start;
  // Copy sitting at or below the foot leaves nothing to fade.
  if (span <= 0) return start;

  /* Clamped because the two ramps below divide the span at this point, and a
     copyTop outside the frame would put it outside 0..1 — every stop then
     collapses onto the same offset and the fade renders as a hard black band
     instead. Neither caller can currently do that (both anchor the block
     inside the frame), which is exactly why it is worth pinning: a later
     layout change should not be able to turn a fade into an edge. */
  const copyFrac = Math.min(1, Math.max(0, (copyTop - start) / span));
  const grad = target.createLinearGradient(0, start, 0, height);

  /* The colour, and how far it is allowed to go.

     `tint` is the photograph's own dark hue (see imageFadeTint); a picture
     that has no usable hue passes null and gets the neutral this has always
     been. Either way it is the same shape, only the ink changes.

     FADE_MAX_ALPHA is the 85% on the picker, and it is the reason any of the
     photograph survives at the foot. The curve below still runs its full 0..1
     — that is what keeps the copy line at the right relative depth — and this
     scales the whole thing at the end, so the darkest point on the card is 85%
     of a very dark colour rather than an opaque one. */
  const FADE_MAX_ALPHA = 0.85;

  /* The colour is not one value down the whole gradient. It rides from a
     visible mid-brightness version of the photograph's hue at the top down to
     the picker point at the foot — see FADE_TINT_TOP_BRIGHTNESS for why a
     single value cannot work. `position` doubles as the ramp parameter, which
     it can because the gradient is defined over exactly the painted span.

     An image with no usable hue passes null and gets the neutral this has
     always been: black at every stop, no ramp, nothing to see. */
  const hue = tint && typeof tint.hue === "number" ? tint.hue : null;
  const inkAt = (position) => {
    if (hue === null) return tint || { r: 0, g: 0, b: 0 };
    const t = Math.min(1, Math.max(0, position));
    return hsbToRgb(
      hue,
      FADE_TINT_TOP_SATURATION + (FADE_TINT_SATURATION - FADE_TINT_TOP_SATURATION) * t,
      FADE_TINT_TOP_BRIGHTNESS + (FADE_TINT_BRIGHTNESS - FADE_TINT_TOP_BRIGHTNESS) * t,
    );
  };
  const stopAt = (position, alpha) => {
    const at = Math.min(1, Math.max(0, position));
    const ink = inkAt(at);
    grad.addColorStop(at, `rgba(${ink.r},${ink.g},${ink.b},${(alpha * FADE_MAX_ALPHA * opacity).toFixed(3)})`);
  };
  // Two ramps meeting at the first line of copy: a slow one over the
  // photograph, a short steep one under the words.
  // How dark it is directly behind the first line of copy. Everything above
  // ramps up to this; everything below continues on from it.
  const COPY_LINE_ALPHA = 0.78;
  const above = (progress, alpha) => stopAt(progress * copyFrac, alpha);
  const below = (progress, alpha) => stopAt(copyFrac + progress * (1 - copyFrac), alpha);

  /* The upper ramp is a sampled curve, not a handful of hand-placed stops.

     Four stops make a piecewise-LINEAR gradient, and the slope changes where
     the segments meet. The eye is far better at spotting a change in slope
     than a change in value — Mach banding — so those joins read as faint
     horizontal lines drawn across the photograph, which is exactly what they
     looked like. Widening the gap between the stops to hold the top lighter
     made it worse, because it steepened the last segment and sharpened the
     corner feeding into it.

     Sampling a continuous curve at forty-eight points removes the corners:
     each join now turns by a fraction of a percent, far below what the eye
     resolves, so there is no join left to see.

     The shape is a quadratic, measured rather than chosen: segment by segment,
     the original four stops trace a quadratic almost exactly. The poster page
     has always looked right, so the curve it was already drawing is the
     specification — the only thing wrong with it was that four samples turned
     it into four straight lines with corners between them.

     A cube was tried here and is worse, for a reason worth recording. Pushing
     the darkening later necessarily steepens the tail: the ink still has to
     reach full strength by the first line, so holding it back early means
     covering the same ground in less space. At t^3 the last quarter of the
     ramp climbs from 0.23 to 0.78, and that rise resolves as a hard edge just
     above the copy — obvious over a flat, bright background, which is exactly
     where the poster page tends to have a dark subject and hide it. Later and
     smoother pull against each other; the poster's own curve is the balance
     that had already been struck.

     The value AT the copy line, and every value below it, is unchanged: that
     is what the text is read against, and it was already right. */
  const RAMP_SAMPLES = 48;
  stopAt(0, 0);
  for (let i = 1; i <= RAMP_SAMPLES; i++) {
    const t = i / RAMP_SAMPLES;
    above(t, COPY_LINE_ALPHA * t ** 2);
  }

  /* ── Below the copy: keep some photograph ──

     This stretch used to ease to solid black within about 150px of the first
     line and hold flat from there. That killed the one thing the poster was
     liked for: you could still see the arm and the knee behind the headline.
     A card whose lower third is an opaque panel is not the same design.

     So the rest of the frame is spent going from the value behind the copy to
     full black, linearly, arriving only at the very foot. Straight rather than
     eased because a straight line has no internal corners at all, and because
     it lands almost exactly where the original four stops did — 0.86 and 0.94
     against their 0.84 and 0.94 — which is the transparency being asked for,
     arrived at from the measurements rather than by eye.

     There is one slope change left, where this meets the ramp above it: the
     ramp arrives at 0.0030 alpha per pixel and this leaves at 0.0004, about
     seven times gentler. That is a real discontinuity and it is the price of
     keeping the picture visible behind the words — spreading the remaining
     ink over the whole frame is exactly what makes it gentle. It is well
     below the seventeen- to twenty-two-fold change the original had, and the
     line that was actually being reported turned out to be a zoomed-out photo
     failing to cover the frame, not this join at all. */
  const TAIL_SAMPLES = 24;
  for (let i = 1; i <= TAIL_SAMPLES; i++) {
    const t = i / TAIL_SAMPLES;
    below(t, COPY_LINE_ALPHA + (1 - COPY_LINE_ALPHA) * t);
  }

  target.fillStyle = grad;
  target.fillRect(0, start, width, span);
  return start;
}

function drawHero() {
  const image = state.mainImage || defaultMain;
  const zoom = (state.imageZoom || 100) / 100;
  drawCoverImage(image, 0, 0, canvas.width, canvas.height, state.imageOffset, zoom);

  // headlineTop moves with line count, so the fade follows short and long
  // titles alike. See paintBottomFade for the curve — the story page draws
  // the same one, anchored to its own copy.
  const L = getLayout();
  const headlineTop = state._render?.top ?? (canvas.height - L.headline.bottomPadding - 200);
  blurBehindCopy(ctx, {
    width: canvas.width,
    height: canvas.height,
    copyTop: headlineTop,
    fadeHeight: fadeReach(L.gradient.fadeHeight),
    radius: FADE_BLUR_RADIUS * (canvas.height / 1700),
  });
  paintBottomFade(ctx, {
    width: canvas.width,
    height: canvas.height,
    copyTop: headlineTop,
    fadeHeight: L.gradient.fadeHeight,
    tint: imageFadeTint(image),
  });

  // Draw both logos at fixed positions
  drawFixedLogos();
}

function drawLogo(x, y, size) {
  ctx.save();

  if (state.logoImage) {
    // Draw logo PNG at its native aspect ratio
    const imgW = state.logoImage.naturalWidth || state.logoImage.width;
    const imgH = state.logoImage.naturalHeight || state.logoImage.height;
    const aspect = imgW / imgH;
    let drawW, drawH;
    if (aspect >= 1) {
      drawW = size;
      drawH = size / aspect;
    } else {
      drawH = size;
      drawW = size * aspect;
    }
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 18;
    ctx.drawImage(
      state.logoImage,
      x - drawW / 2,
      y - drawH / 2,
      drawW,
      drawH
    );
    ctx.shadowBlur = 0;
  } else {
    // Text fallback
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 24;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = state.accent;
    ctx.font = `italic 800 ${Math.round(size * 0.42)}px 'Poppins', 'Segoe UI', Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Pix", x, y + 2);
  }

  ctx.restore();
}

function drawFixedLogos() {
  // Pick logo: when exporting for X, swap to Shortly (if loaded). Else use Pix.
  const useAlt = isXRenderMode() && state.shortlyLogoImage;
  const logo = useAlt ? state.shortlyLogoImage : state.logoImage;
  if (!logo) return;

  // Position + size come from the active aspect-ratio preset. The Shortly
  // logo already has its own gradient halo, so we use the slot size that's
  // tuned for it (slightly larger).
  const L = getLayout();
  const slotSize = useAlt ? L.logo.slotShortly : L.logo.slotPix;
  const centerX = L.logo.centerX;
  const centerY = L.logo.centerY;

  const rawW = logo.naturalWidth  || logo.width  || 1;
  const rawH = logo.naturalHeight || logo.height || 1;

  // Scale so the longest edge fills the slot (preserves aspect ratio)
  const scale = slotSize / Math.max(rawW, rawH);
  const drawW = rawW * scale;
  const drawH = rawH * scale;

  // Center inside the slot
  const px = centerX - drawW / 2;
  const py = centerY - drawH / 2;

  drawLogoAt(logo, px, py, drawW, drawH);
}

/* The logo used to carry a white halo and a hairline ring, which over a blue
   mark read as a pale blue outline rather than as glow. Both are gone: the
   mark is its own solid circle and needs nothing behind it to separate from
   the photo. */
function drawLogoAt(img, x, y, w, h) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const radius = Math.min(w, h) / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  ctx.drawImage(img, x, y, w, h);
  ctx.restore();
}

function drawTag() {
  if (state.tag === "none") return;

  const drawn = DRAWN_TAGS[state.tag];
  const tagImg = drawn ? null : state.tagImages[state.tag];
  if (!drawn && !tagImg) return;

  const drawW = drawn ? measureDrawnTag(drawn) : (tagImg.naturalWidth || tagImg.width);
  const drawH = drawn ? TAG_BAR_HEIGHT          : (tagImg.naturalHeight || tagImg.height);

  // Tag is anchored to the dynamic headline top, so it always sits just
  // above the headline regardless of how many lines the headline wrapped to.
  const L = getLayout();
  const tagX = L.tag.x;
  const headlineTop = state._render?.top ?? (canvas.height - L.headline.bottomPadding - 200);
  const tagY = headlineTop - drawH - L.tag.gapAboveHeadline;

  if (drawn) {
    drawTagBadge(drawn, tagX, tagY, drawW, drawH);
    return;
  }

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 12;
  ctx.drawImage(tagImg, tagX, tagY, drawW, drawH);
  ctx.shadowBlur = 0;
  ctx.restore();
}

function measureDrawnTag(tag) {
  ctx.save();
  ctx.font = TAG_FONT;
  const textW = ctx.measureText(tag.label).width;
  ctx.restore();
  const iconW = tag.icon ? TAG_ICON_BOX + TAG_ICON_GAP : 0;
  return Math.round(TAG_PAD_X * 2 + iconW + textW);
}

function drawTagBadge(tag, x, y, w, h) {
  // Only the bar carries the drop shadow — the SVG tags shadow the whole
  // image once, so shadowing the label too would read as a double halo.
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 12;
  ctx.fillStyle = tag.bg;
  ctx.fillRect(x, y, w, h);
  ctx.restore();

  ctx.save();
  ctx.fillStyle = "#FFFFFF";
  let cursor = x + TAG_PAD_X;
  if (tag.icon) {
    drawPlayGlyph(cursor, y + (h - TAG_ICON_BOX) / 2, TAG_ICON_BOX);
    cursor += TAG_ICON_BOX + TAG_ICON_GAP;
  }
  ctx.font = TAG_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  // +1px optical nudge — Poppins' middle baseline sits slightly high in the bar.
  ctx.fillText(tag.label, cursor, y + h / 2 + 1);
  ctx.restore();
}

/* Rounded play triangle, sized to fit a `box`×`box` square at (x, y). */
function drawPlayGlyph(x, y, box) {
  const inset = box * 0.14;
  const left  = x + inset + box * 0.06;
  const top   = y + inset;
  const height = box - inset * 2;
  const width  = height * 0.88;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left + width, top + height / 2);
  ctx.lineTo(left, top + height);
  ctx.closePath();
  // Stroking with the fill colour rounds the triangle's corners.
  ctx.lineJoin = "round";
  ctx.lineWidth = box * 0.14;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}

function drawHeadline() {
  // Use the layout + top that renderPoster already computed and cached, so
  // text, gradient, and tag stay in sync. Fall back gracefully if state
  // isn't initialized yet (e.g. very first paint).
  const L = getLayout();
  const cached = state._render || computeHeadlineLayoutAndTop();
  const { layout, top } = cached;
  const text = state.headline || "YOUR HEADLINE HERE";
  const left = L.headline.x;
  const blockHeight = layout.lines.length * layout.lineHeight;

  const allWords = text.trim().split(/\s+/).filter(Boolean);
  const purpleCount = Math.ceil(allWords.length / 2);

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = layout.font;

  let currentlyHighlighted = false;

  // PASS 1: Draw Accent Backgrounds
  layout.lines.forEach((line, lineIndex) => {
    const rawWords = line.split(" ");
    let bgCursor = left;
    const y = top + lineIndex * layout.lineHeight;

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    let segmentStartX = null;
    let segmentWidth = 0;
    let segments = [];

    rawWords.forEach((rawWord, i) => {
      const isOpening = HIGHLIGHT_OPEN_CHAR.test(rawWord);
      const isClosing = HIGHLIGHT_CLOSE_CHAR.test(rawWord);
      const cleanWord = rawWord.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, '');

      if (isOpening) currentlyHighlighted = true;

      const wordWidth = ctx.measureText(cleanWord).width;
      const spaceWidth = ctx.measureText(" ").width;
      const totalAdvance = wordWidth + spaceWidth;

      if (currentlyHighlighted && cleanWord.length > 0) {
        if (segmentStartX === null) {
          segmentStartX = bgCursor;
        }

        let advanceForHighlight = totalAdvance;
        if (isClosing || i === rawWords.length - 1) {
          advanceForHighlight = wordWidth; // Stop highlight at the end of the word cleanly
        }

        segmentWidth += advanceForHighlight;
      }

      if ((isClosing || i === rawWords.length - 1) && segmentStartX !== null) {
        segments.push({ x: segmentStartX, w: segmentWidth });
        segmentStartX = null;
        segmentWidth = 0;
      }

      if (isClosing) currentlyHighlighted = false;
      bgCursor += totalAdvance;
    });

    ctx.fillStyle = state.accent;

    // Pull the actual font size out of the font string (e.g. "600 49px ...")
    // so the highlight box hugs the glyph height, not the line-height. Using
    // lineHeight made the box too tall and bled into the next line's bbox.
    const fontMatch = layout.font.match(/(\d+(?:\.\d+)?)px/);
    const fontSize  = fontMatch ? parseFloat(fontMatch[1]) : Math.round(layout.lineHeight / 1.22);

    const PAD_X        = Math.max(6, Math.round(fontSize * 0.16));  // horizontal breathing room
    const OVERSHOOT_T  = Math.max(2, Math.round(fontSize * 0.06));  // box top above cap line
    const BOX_HEIGHT   = Math.round(fontSize * 0.94);                // hugs glyph height
    const CORNER_RAD   = Math.max(6, Math.round(fontSize * 0.18));

    segments.forEach(seg => {
      const drawX = seg.x - PAD_X;
      const widthToFill = seg.w + PAD_X * 2;
      const drawY = y - OVERSHOOT_T;
      const drawH = BOX_HEIGHT;

      ctx.beginPath();
      ctx.roundRect(drawX, drawY, widthToFill, drawH, CORNER_RAD);
      ctx.fill();
    });
  });

  // reset for pass 2
  currentlyHighlighted = false;

  // PASS 2: Draw White Text with Shadow
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 8;

  layout.lines.forEach((line, lineIndex) => {
    const rawWords = line.split(" ");
    let cursor = left;
    const y = top + lineIndex * layout.lineHeight;

    for (const rawWord of rawWords) {
      const cleanWord = rawWord.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, '');
      if (cleanWord.length > 0) {
        ctx.fillStyle = "#ffffff"; // All text is white
        ctx.fillText(cleanWord + " ", cursor, y);
        cursor += ctx.measureText(cleanWord + " ").width;
      }
    }
  });

  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

/* ── Preview-only UI Overlays (drawn on canvas, excluded from download) ── */

function drawEngagementBar() {
  ctx.save();

  // Scale factor from Zeplin (390 width, 2.36x to reach 920px)
  const scale = 2.36;

  const pillW = Math.round(222.3 * scale); // ~525
  const pillH = Math.round(48.9 * scale);  // ~115
  const shareW = Math.round(48.9 * scale); // ~115
  const gap = Math.round(8 * scale);       // ~19

  const barY = 1700 - Math.round(14 * scale) - Math.round(46 * scale) - Math.round(6 * scale) - pillH;

  // Center align the entire group (pill + gap + share circle)
  const totalW = pillW + gap + shareW;
  const barX = (canvas.width - totalW) / 2;

  // Dark Pill Background
  ctx.fillStyle = "rgba(13, 13, 13, 0.8)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.1)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 8;

  ctx.beginPath();
  ctx.roundRect(barX, barY, pillW, pillH, pillH / 2);
  ctx.fill();

  // Faint border
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Draw Separator Lines
  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.lineWidth = 1.5;
  const sectionW = pillW / 3;
  const cy = barY + pillH / 2;

  for (let i = 1; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(barX + sectionW * i, cy - 22);
    ctx.lineTo(barX + sectionW * i, cy + 22);
    ctx.stroke();
  }

  // Draw Items
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 32px 'Inter', sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const iconScale = 40;

  const drawItem = (index, iconPath, text, isFill) => {
    const cx = barX + sectionW * index + sectionW / 2;
    const textWidth = ctx.measureText(text).width;
    const itemGap = 12;
    const totalW = iconScale + itemGap + textWidth;

    const startX = cx - totalW / 2 + iconScale / 2;

    // Draw icon
    drawIconPath(startX, cy, iconScale, iconPath, isFill);

    // Draw text
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, startX + iconScale / 2 + itemGap, cy + 2);
  };

  const LIKE_SOLID = "M2 21h2V9H2v12zm4-9v10a1 1 0 001 1h9.07a2 2 0 001.93-1.49L21.83 11A2 2 0 0019.9 8.5H14V4a2 2 0 00-2-2h-.09a1.65 1.65 0 00-1.56 1.09L7.44 12H6z";
  const DISLIKE_OUTLINE = "M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm-1.41 15.41L12 17l1.41-.65V11H7.5l3-7h3.5v9h5.11l-3 7L13.59 18.41zM3 15h4V3H3v12z";
  const COMMENT_OUTLINE = "M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2zm0 15.17L18.83 16H4V4h16v13.17z";

  drawItem(0, LIKE_SOLID, "1.2k", true);
  drawItem(1, DISLIKE_OUTLINE, "200", false);
  drawItem(2, COMMENT_OUTLINE, "200", false);

  // --- Share Circle ---
  const shareX = barX + pillW + gap;

  ctx.fillStyle = "rgba(13, 13, 13, 0.8)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.1)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 8;

  ctx.beginPath();
  ctx.arc(shareX + shareW / 2, cy, shareW / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 2;
  ctx.stroke();

  const SHARE_SOLID = "M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z";
  drawIconPath(shareX + shareW / 2 - 2, cy - 2, 40, SHARE_SOLID, true);

  ctx.restore();
}

function drawIconPath(cx, cy, size, pathData, isFill = true) {
  ctx.save();
  const scale = size / 24;
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(scale, scale);
  const p = new Path2D(pathData);
  ctx.fillStyle = isFill ? "#ffffff" : "rgba(255, 255, 255, 0.85)";
  ctx.fill(p);
  ctx.restore();
}

function drawNavBar() {
  ctx.save();
  const scale = 2.36;
  const barW = Math.round(378 * scale); // 892
  const barH = Math.round(46 * scale);  // 108
  const barY = 1700 - Math.round(6 * scale) - barH; // 1578
  const barX = (920 - barW) / 2; // ~14

  // Background
  ctx.fillStyle = "rgba(13, 13, 13, 0.8)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.2)";
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.roundRect(barX, barY, barW, barH, 54);
  ctx.fill();

  // Faint border
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 2;
  ctx.stroke();

  const cy = barY + barH / 2;

  const NAV_HOME = "M12 5.69l5 4.5V18h-2v-6H9v6H7v-7.81l5-4.5M12 3L2 12h3v8h6v-6h2v6h6v-8h3L12 3z";
  const NAV_VIDEO = "M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12zm-11-2l6-4-6-4v8z";
  const NAV_DOC_OUTLINE = "M14 2H6a2 2 0 00-2 2v16h16V8l-6-6zm4 18H6V4h7v5h5v11z M8 14h8v-2H8v2z M8 18h8v-2H8v2z M8 10h5V8H8v2z";
  const NAV_AUDIO = "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z M11 7h2v10h-2z M7 10h2v4H7z M15 10h2v4h-2z";
  const NAV_BOLT = "M11 21h-1l1-7H7.5a.5.5 0 01-.4-.8l3.9-5.2V3h1l-1 7h3.5a.5.5 0 01.4.8L11 16v5z";

  const icons = [NAV_HOME, NAV_VIDEO, NAV_DOC_OUTLINE, NAV_AUDIO, NAV_BOLT];

  const padding = 64;
  const startX = barX + padding;
  const W = barW - padding * 2;

  icons.forEach((path, i) => {
    const cx = startX + i * (W / 4);
    const isAccent = i === 4;

    if (isAccent) {
      // Accent circle
      ctx.beginPath();
      ctx.arc(cx, cy, 40, 0, Math.PI * 2);
      ctx.fillStyle = "#3979FF";
      ctx.fill();
    }

    const iconSize = isAccent ? 40 : 44;
    drawIconPath(cx, cy, iconSize, path, isAccent);
  });

  ctx.restore();
}

function buildHeadlineLayoutFixed(text, maxWidth, size) {
  const cleaned = normalizeHeadlineForPoster(text);
  const font = `600 ${size}px 'Roboto Serif', 'Poppins', serif`;
  ctx.font = font;
  const lines = wrapTextBlock(cleaned, maxWidth);
  return { font, lines, lineHeight: Math.round(size * 1.1) };
}

/* ── Headline Layout ── */

function buildHeadlineLayout(text, maxWidth, _maxLines) {
  const cleaned = normalizeHeadlineForPoster(text);

  // Fixed 48px / 600 weight — text grows downward as lines increase
  const size = 48;
  const font = `600 ${size}px 'Roboto Serif', 'Poppins', serif`;
  ctx.font = font;
  const lines = wrapTextBlock(cleaned, maxWidth);
  return { font, lines, lineHeight: Math.round(size * 1.22) };
}

function normalizeHeadlineForPoster(text) {
  return text
    // Collapse runs of spaces/tabs but KEEP newlines — pressing Enter is a
    // deliberate line break, and /\s+/ used to flatten it into a space.
    .replace(/[^\S\n]+/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")        // cap runaway blank runs
    .replace(/^live\s+/i, "")
    .split("\n").map(l => l.trim()).join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/**
 * Wrap a block that may contain manual line breaks: each newline-separated
 * segment is wrapped (and rebalanced) on its own, so an author's break is
 * always honoured and auto-wrapping never pulls words across it.
 */
function wrapTextBlock(text, maxWidth) {
  const out = [];
  for (const segment of text.split("\n")) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");                     // a deliberate blank line
      continue;
    }
    out.push(...wrapWords(words, maxWidth));
  }
  return out.length ? out : [""];
}

function wrapWords(words, maxWidth) {
  const lines = [];
  let current = "";

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    // Strip bracket markers when measuring text width
    if (ctx.measureText(test.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, '')).width <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return rebalanceLines(lines, maxWidth);
}

function rebalanceLines(lines, maxWidth) {
  if (lines.length < 2) return lines;

  const balanced = [...lines];
  for (let i = 0; i < balanced.length - 1; i += 1) {
    const currentWords = balanced[i].split(" ");
    const nextWords = balanced[i + 1].split(" ");
    if (currentWords.length < 2 || nextWords.length < 2) continue;

    const moved = `${balanced[i]} ${nextWords[0]}`;
    // Strip bracket markers when measuring text width
    if (ctx.measureText(moved.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, '')).width <= maxWidth * 0.98) {
      balanced[i] = moved;
      nextWords.shift();
      balanced[i + 1] = nextWords.join(" ");
    }
  }

  return balanced.filter(Boolean);
}

function compressLines(lines, maxLines) {
  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines - 1);
  const finalLine = lines.slice(maxLines - 1).join(" ");
  kept.push(finalLine.length > 46 ? `${finalLine.slice(0, 43).trimEnd()}...` : finalLine);
  return kept;
}

/* ── Cover Image Drawing ── */

function drawCoverImage(image, x, y, width, height, offset, zoom) {
  const baseScale = Math.max(width / image.width, height / image.height);
  const scale = baseScale * (zoom || 1) * IMAGE_PAN_HEADROOM;
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const focal = image.__focalPoint || { x: image.width / 2, y: image.height / 2 };

  let dx = x + width / 2 - focal.x * scale;
  let dy = y + height / 2 - focal.y * scale;

  if (offset) {
    dx += offset.x;
    dy += offset.y;
  }

  const minX = x + width - drawWidth;
  const minY = y + height - drawHeight;
  dx = clamp(dx, minX, x);
  dy = clamp(dy, minY, y);

  // Apply filters (brightness/contrast/saturation/blur) only to the image
  // layer — gradient, headline, logo, etc. should NOT be filtered. Reset to
  // "none" immediately after the draw so subsequent layers render normally.
  ctx.save();
  ctx.filter = buildFilterString();
  ctx.drawImage(image, dx, dy, drawWidth, drawHeight);
  ctx.restore();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ── Image Utilities ── */

async function imageFromUrl(url) {
  if (url.startsWith("data:")) {
    return createImage(url);
  }
  return createImage(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`);
}

async function createImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = async () => {
      await ensureImageFocalPoint(image);
      resolve(image);
    };
    image.onerror = reject;
    image.src = src;
  });
}

async function ensureImageFocalPoint(image) {
  if (image.__focalPoint) return image.__focalPoint;

  let focalPoint = { x: image.width / 2, y: image.height / 2 };
  if (faceDetector) {
    try {
      const faces = await faceDetector.detect(image);
      if (faces?.length) {
        const box = faces[0].boundingBox;
        focalPoint = {
          x: box.x + box.width / 2,
          y: box.y + box.height / 2
        };
      }
    } catch { }
  }

  image.__focalPoint = focalPoint;
  return focalPoint;
}

/* ── The fade takes its colour from the picture ──────────────────────────────

   The gradient used to be pure black on every card. Black is never wrong and
   never right either: a warm stadium photograph and a cold studio portrait
   both faded into the same neutral, which reads as a panel laid on top rather
   than as the picture getting darker.

   So the fade is tinted with the photograph's own dominant hue, taken to the
   point on the colour picker: saturation 78, brightness 8. That is a very dark
   colour — it has to be, it is doing the same job black was — but it is dark
   RED under a red photograph and dark BLUE under a blue one, so the bottom of
   the card belongs to the image above it.

   Only the hue is taken from the picture. Its own saturation and brightness
   are deliberately discarded: a washed-out photo would otherwise fade to a
   washed-out grey and a neon one to something luminous, and the fade would
   stop being a fade. Fixing S and B is what makes every card behave the same
   while still being its own colour. */
/* The picker point: where the fade ENDS, at the foot of the card. */
const FADE_TINT_SATURATION = 0.78;
const FADE_TINT_BRIGHTNESS = 0.08;

/* Where it starts, and the reason there is a second pair at all.

   The picker point is #140404 — arithmetically red, visually black. Blended
   over a mid-tone photograph at the alphas this fade actually uses, the
   separation between its channels is 3 to 13 levels out of 255, which the eye
   reads as grey. So the first version tinted correctly and looked exactly
   like no tint at all: the colour was there and nobody could see it.

   A gradient has a whole length to work with, though, and only its END has to
   be that dark. Carrying the hue at a visible brightness through the middle
   and easing down to the picker point gives 12 to 16 levels of separation
   where the fade is most of what you are looking at — a colour gradient
   rather than a grey one — while still arriving exactly where it was
   specified to arrive. */
const FADE_TINT_TOP_SATURATION = 0.85;
const FADE_TINT_TOP_BRIGHTNESS = 0.42;

/* What FRACTION OF THE PIXELS carry a usable colour. Below this the hue is not
   a fact about the image, it is noise — a black-and-white press photo, a snow
   scene, a document scan — and tinting on it puts a colour cast on the card
   that nobody asked for.

   A fraction of pixels, deliberately, not a weighted sum. The first version of
   this divided the chroma-weighted total by the raw pixel count, which is two
   different units either side of the division: a photograph can be obviously
   coloured and still score 0.07 that way, because the weights are chroma
   values well under 1 while the divisor counts every grey pixel in the frame.
   The effect was that ordinary news photographs — a pale marquee, white
   shirts, one blue waistcoat — quietly failed the test and faded to neutral,
   which looked exactly like the tint not working at all. Counting how many
   pixels are coloured is the question actually being asked. */
const FADE_TINT_MIN_CHROMA_SHARE = 0.08;

function hsbToRgb(h, s, b) {
  const c = b * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = b - c;
  const [r, g, bl] =
    h <  60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((bl + m) * 255),
  };
}

/* The dominant hue, as {r,g,b} at the fixed saturation and brightness above,
   or null when the picture has no hue worth speaking of.

   Cached on the image the way __focalPoint is: this runs a getImageData and
   renderPoster() is called on every slider drag, so computing it per frame
   would be the most expensive thing in the render loop for a value that
   cannot change.

   Hues are histogrammed in 15-degree buckets and weighted by chroma, so a
   large flat wash of pale sky counts for less than a smaller area of strong
   colour — which matches what a person would call the picture's colour. The
   winning bucket is then refined to the chroma-weighted mean hue of the
   pixels inside it, so the answer is not quantised to the bucket edge.

   Circular mean, not arithmetic: hue wraps, and averaging 359 and 1 the naive
   way gives 180 — cyan, the exact opposite of the red they actually are. */
function imageFadeTint(image) {
  if (image.__fadeTint !== undefined) return image.__fadeTint;

  let tint = null;
  try {
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    if (w && h) {
      // A 64px thumbnail is plenty to find a dominant hue and keeps this at
      // about a millisecond regardless of what was pasted in.
      const scale = Math.min(1, 64 / Math.max(w, h));
      const sw = Math.max(1, Math.round(w * scale));
      const sh = Math.max(1, Math.round(h * scale));
      const off = document.createElement("canvas");
      off.width = sw;
      off.height = sh;
      const octx = off.getContext("2d", { willReadFrequently: true });
      octx.drawImage(image, 0, 0, sw, sh);
      const data = octx.getImageData(0, 0, sw, sh).data;

      const BUCKETS = 24;                       // 15 degrees each
      const weight = new Float64Array(BUCKETS);
      const sinSum = new Float64Array(BUCKETS);
      const cosSum = new Float64Array(BUCKETS);
      let colouredPixels = 0;
      let counted = 0;

      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;        // transparent pixels say nothing
        counted++;
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const chroma = max - min;
        /* Near-grey and near-black pixels have a hue, arithmetically, but it
           is meaningless and unstable — one bit of sensor noise swings it
           right across the wheel. They are skipped rather than down-weighted
           so they cannot accumulate into a majority by sheer count. */
        if (chroma < 0.09 || max < 0.12) continue;

        let hue;
        if (max === r)      hue = 60 * (((g - b) / chroma) % 6);
        else if (max === g) hue = 60 * (((b - r) / chroma) + 2);
        else                hue = 60 * (((r - g) / chroma) + 4);
        if (hue < 0) hue += 360;

        // Weighted by chroma AND by how bright the pixel is: a strong colour
        // in shadow is less of the picture's character than one in the light.
        const wgt = chroma * (0.4 + 0.6 * max);
        const bucket = Math.min(BUCKETS - 1, Math.floor(hue / (360 / BUCKETS)));
        const rad = (hue * Math.PI) / 180;
        weight[bucket] += wgt;
        sinSum[bucket] += Math.sin(rad) * wgt;
        cosSum[bucket] += Math.cos(rad) * wgt;
        // Chroma still WEIGHTS which hue wins; it no longer decides whether
        // there is one. Those are separate questions and conflating them is
        // what made the gate unreachable for real photographs.
        colouredPixels++;
      }

      if (counted && colouredPixels / counted >= FADE_TINT_MIN_CHROMA_SHARE) {
        let best = 0;
        for (let i = 1; i < BUCKETS; i++) if (weight[i] > weight[best]) best = i;
        if (weight[best] > 0) {
          let hue = (Math.atan2(sinSum[best], cosSum[best]) * 180) / Math.PI;
          if (hue < 0) hue += 360;
          /* The hue travels with the colour: paintBottomFade needs it to build
             the intermediate stops, and r/g/b stay the endpoint so anything
             wanting just "the fade colour" still gets the picker point. */
          tint = { hue, ...hsbToRgb(hue, FADE_TINT_SATURATION, FADE_TINT_BRIGHTNESS) };
        }
      }
    }
  } catch (err) {
    /* A cross-origin image taints the canvas and getImageData throws. That is
       a normal thing for a scraped photo to be, not an error — the fade just
       stays neutral, which is what it has always been. */
    tint = null;
  }

  image.__fadeTint = tint;
  return tint;
}

function waitForImage(image) {
  if (image.complete) return Promise.resolve(image);
  return new Promise((resolve) => {
    image.onload = () => resolve(image);
  });
}

/* ── Placeholder ── */

function makeMainPlaceholder() {
  return makeSvgImage(`
    <svg xmlns="http://www.w3.org/2000/svg" width="920" height="1700" viewBox="0 0 920 1700">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stop-color="#1a1a2e" />
          <stop offset="50%" stop-color="#0f0f1a" />
          <stop offset="100%" stop-color="#050508" />
        </linearGradient>
        <radialGradient id="glow" cx="0.3" cy="0.2" r="0.6">
          <stop offset="0%" stop-color="rgba(139,92,246,0.12)" />
          <stop offset="100%" stop-color="transparent" />
        </radialGradient>
      </defs>
      <rect width="920" height="1700" fill="url(#bg)" />
      <rect width="920" height="1700" fill="url(#glow)" />
      <text x="460" y="800" text-anchor="middle" font-family="Poppins, sans-serif" font-size="38" font-weight="700" fill="rgba(255,255,255,0.1)">Paste a URL to get started</text>
    </svg>
  `);
}

function makeSvgImage(svg) {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  image.__focalPoint = { x: 460, y: 850 };
  return image;
}

/* ── Helpers ── */

/* The whole paragraph, from whichever field is currently authoritative —
   the draft box while Write Text is open, the editor box while typing, the
   saved value otherwise. Slices are cut from this. */
function getFullDetailText() {
  if (!state.isDownloading && state.previewMode === "text") {
    const isWritingText = writeForm && !writeForm.hidden;
    return isWritingText && writeDetail
      ? writeDetail.value
      : (detailEdit?.value ?? state.detailText ?? "");
  }
  return state.detailText || "";
}

function getDetailTextForPreview() {
  // No headline fallback anywhere in here. The headline belongs to slide 1;
  // echoing it onto slide 2 is the bug, not a graceful default. An empty
  // paragraph shows a prompt instead, which is honest about the card being
  // unfinished rather than looking deliberately duplicated.
  const fallback = "Add key points in Text Paragraph, or generate them from a link.";

  // Painting a text card that owns a slice: show only its share of the
  // points, and say so plainly when the division left it with none.
  if (state._detailSlice !== null && state._detailSlice !== undefined) {
    const slice = state._detailSlice.trim();
    return limitDetailTextClient(slice || "No points left for this page — add more to the paragraph.");
  }

  const text = getFullDetailText();
  if (!state.isDownloading && state.previewMode === "text") {
    return limitDetailTextClient(text.trim() ? text : fallback, { preserveOpenBullet: true });
  }
  return limitDetailTextClient(text.trim() || fallback);
}

function handleDetailBulletEnter(event) {
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;

  const field = event.currentTarget;
  const value = field.value || "";
  const selectionStart = field.selectionStart ?? value.length;
  const selectionEnd = field.selectionEnd ?? selectionStart;
  const lineStart = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const currentLine = value.slice(lineStart, selectionStart);
  const currentLineText = currentLine.trim();
  const shouldBulletCurrentLine = currentLineText && !/^[\u2022*-]\s+/.test(currentLineText);

  event.preventDefault();

  let nextValue = value;
  let nextStart = selectionStart;
  let nextEnd = selectionEnd;
  if (shouldBulletCurrentLine) {
    nextValue = `${value.slice(0, lineStart)}\u2022 ${value.slice(lineStart)}`;
    nextStart += 2;
    nextEnd += 2;
  }

  const before = nextValue.slice(0, nextStart);
  const after = nextValue.slice(nextEnd);
  const insertion = before.trim() ? "\n\n\u2022 " : "\u2022 ";
  field.value = `${before}${insertion}${after}`;

  const cursor = before.length + insertion.length;
  field.setSelectionRange(cursor, cursor);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function formatDetailBulletField(field) {
  const original = field.value || "";
  const formatted = formatDetailBulletText(original);
  if (formatted === original) return original;

  const cursor = field.selectionStart ?? original.length;
  const delta = formatted.length - original.length;
  field.value = formatted;
  const nextCursor = Math.min(field.value.length, Math.max(0, cursor + delta));
  field.setSelectionRange(nextCursor, nextCursor);
  return field.value;
}

function formatDetailBulletText(value) {
  const normalized = (value || "").replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return normalized;

  const wantsNextBullet = /\n$/.test(normalized);
  const hasOpenBullet = /(?:^|\n)\s*[\u2022*-]\s*$/.test(normalized);
  const points = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[\u2022*-]\s*$/.test(line))
    .map((line) => (/^[\u2022*-]\s+/.test(line) ? `\u2022 ${line.replace(/^[\u2022*-]\s+/, "")}` : `\u2022 ${line}`));

  let output = points.join("\n\n");
  if ((wantsNextBullet || hasOpenBullet) && output) {
    output = `${output}\n\n\u2022 `;
  }
  return output;
}

function limitDetailTextClient(value, options = {}) {
  return normalizeDetailTextClient(value, options);
}

function normalizeDetailTextClient(value, { preserveOpenBullet = false } = {}) {
  const lines = (value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd());

  while (!preserveOpenBullet && lines.length && /^[\u2022*-]\s*$/.test(lines[lines.length - 1].trim())) {
    lines.pop();
  }

  return lines
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function limitWordsClient(value, maxWords) {
  return (value || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(" ");
}

function slugify(value) {
  return (value || "pix-post").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "pix-post";
}

function setStatus(message, type) {
  scrapeStatus.textContent = message;
  scrapeStatus.className = "status-text";
  if (type) scrapeStatus.classList.add(type);
}

/* The analytics boards are built with innerHTML, and the names in them come
   from the database — user_name is written from whatever display name an
   account was created with (lib/pix-api.js sets it from the session). A name
   containing markup would otherwise execute in every QA's browser, so it is
   escaped on the way in. Anything rendered through textContent elsewhere is
   already safe and does not need this. */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function setAnalyticsStatus(message, type) {
  if (!analyticsStatus) return;
  analyticsStatus.textContent = message || "";
  analyticsStatus.className = "status-text" + (type ? ` ${type}` : "");
}

function formatCount(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function formatCompactNumber(value) {
  const n = Number(value) || 0;
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function animateCounter(el, value, suffix = "") {
  if (!el) return;
  const target = Number(value) || 0;
  const start = Number(el.dataset.currentValue || 0);
  const diff = target - start;
  const startTime = performance.now();
  const duration = 700;

  function frame(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = start + diff * eased;
    el.textContent = `${formatCompactNumber(Math.round(current))}${suffix}`;
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      el.dataset.currentValue = String(target);
      el.textContent = `${formatCompactNumber(target)}${suffix}`;
    }
  }

  requestAnimationFrame(frame);
}

function analyticsValueEl(key) {
  return document.querySelector(`[data-analytics-value="${key}"]`);
}

function analyticsDailyValueEl(key) {
  return document.querySelector(`[data-analytics-daily-value="${key}"]`);
}

let analyticsMidnightTimer = null;
let analyticsResetClockTimer = null;

function scheduleAnalyticsMidnightRefresh(nextResetAt) {
  clearTimeout(analyticsMidnightTimer);
  clearInterval(analyticsResetClockTimer);
  analyticsMidnightTimer = null;
  analyticsResetClockTimer = null;

  const resetAt = new Date(nextResetAt || "");
  if (Number.isNaN(resetAt.getTime())) {
    if (analyticsDailyReset) analyticsDailyReset.textContent = "Resets automatically at 12:00 AM IST";
    return;
  }

  const updateResetCopy = () => {
    if (!analyticsDailyReset) return;
    const remainingMinutes = Math.max(0, Math.ceil((resetAt.getTime() - Date.now()) / 60000));
    if (!remainingMinutes) {
      analyticsDailyReset.textContent = "Refreshing for the new India business day...";
      return;
    }
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    const remaining = hours ? `${hours}h ${minutes}m` : `${minutes}m`;
    analyticsDailyReset.textContent = `Resets at 12:00 AM IST · ${remaining} remaining`;
  };

  updateResetCopy();
  analyticsResetClockTimer = setInterval(updateResetCopy, 60000);
  const delay = Math.max(0, resetAt.getTime() - Date.now()) + 1500;
  analyticsMidnightTimer = setTimeout(() => {
    clearInterval(analyticsResetClockTimer);
    analyticsResetClockTimer = null;
    loadAnalytics({ force: true });
  }, delay);
}

function renderAnalyticsDaily(daily = {}) {
  animateCounter(analyticsDailyValueEl("sent"), daily.sent_count || 0);
  animateCounter(analyticsDailyValueEl("approved"), daily.approved_count || 0);
  animateCounter(analyticsDailyValueEl("rejected"), daily.rejected_count || 0);
  animateCounter(analyticsDailyValueEl("pending"), daily.pending_count || 0);

  if (analyticsTodayDate) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(daily.day_key || "")
      ? new Date(`${daily.day_key}T12:00:00+05:30`)
      : new Date();
    analyticsTodayDate.textContent = new Intl.DateTimeFormat("en-IN", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: daily.timezone || "Asia/Kolkata",
    }).format(day);
  }

  scheduleAnalyticsMidnightRefresh(daily.next_reset_at);
}

function renderAnalyticsSummary(summary = {}, role = "writer") {
  animateCounter(analyticsValueEl("sent"), summary.sent_count || 0);
  animateCounter(analyticsValueEl("approved"), summary.approved_count || 0);
  animateCounter(analyticsValueEl("rejected"), summary.rejected_count || 0);
  animateCounter(analyticsValueEl("pending"), summary.pending_count || 0);
  animateCounter(analyticsValueEl("rate"), summary.approval_rate || 0, "%");

  const sentSub = document.getElementById("analytics-sent-sub");
  const approvedSub = document.getElementById("analytics-approved-sub");
  const rejectedSub = document.getElementById("analytics-rejected-sub");
  const pendingSub = document.getElementById("analytics-pending-sub");
  const rateSub = document.getElementById("analytics-rate-sub");

  if (sentSub) {
    sentSub.textContent = canReviewRole(role)
      ? `${formatCount(summary.active_writers || 0)} writers active in the pipeline`
      : "Posts you have sent into the workflow";
  }
  if (approvedSub) {
    approvedSub.textContent = canReviewRole(role)
      ? `${formatCount(summary.approved_by_me_count || 0)} approved by you`
      : "Posts QA has approved";
  }
  if (rejectedSub) {
    rejectedSub.textContent = canReviewRole(role)
      ? "Returned to writers for changes"
      : "Posts QA returned for changes";
  }
  if (pendingSub) {
    pendingSub.textContent = canReviewRole(role)
      ? "Still waiting for QA action"
      : "Your posts still in review";
  }
  if (rateSub) {
    rateSub.textContent = canReviewRole(role)
      ? `${formatCount(summary.active_qas || 0)} QA reviewers active`
      : "Share of your posts approved";
  }
}

function renderAnalyticsMeta(summary = {}, role = "writer") {
  if (!analyticsMetaList || !analyticsMetaTitle) return;
  analyticsMetaTitle.textContent = canReviewRole(role) ? "Approval health" : "Your pipeline health";
  const items = canReviewRole(role)
    ? [
        ["Active writers", formatCount(summary.active_writers || 0)],
        ["Active QA reviewers", formatCount(summary.active_qas || 0)],
        ["Approved by you", formatCount(summary.approved_by_me_count || 0)],
        ["Avg approval time", `${Number(summary.avg_approval_hours || 0).toFixed(1)} hrs`],
      ]
    : [
        ["Posts sent", formatCount(summary.sent_count || 0)],
        ["Posts approved", formatCount(summary.approved_count || 0)],
        ["Posts pending", formatCount(summary.pending_count || 0)],
        ["Avg approval time", `${Number(summary.avg_approval_hours || 0).toFixed(1)} hrs`],
      ];

  analyticsMetaList.innerHTML = items.map(([label, value]) => `
    <div class="analytics-metric">
      <span class="analytics-metric-label">${label}</span>
      <strong class="analytics-metric-value">${value}</strong>
    </div>
  `).join("");
}

function renderAnalyticsBoard(container, rows, { empty, valueLabel, showRate = false, rateField = "approval_rate", approvedField = "approved_count", pendingField = "pending_count" }) {
  if (!container) return;
  if (!rows?.length) {
    container.innerHTML = `<div class="analytics-empty">${empty}</div>`;
    return;
  }
  container.innerHTML = rows.map((row, index) => `
    <div class="analytics-row">
      <span class="analytics-rank">${index + 1}</span>
      <div class="analytics-row-main">
        <span class="analytics-row-name">${escapeHtml(row.user_name || "Unknown")}</span>
        <span class="analytics-row-meta">${approvedField in row && pendingField in row
          ? `${formatCount(row[approvedField] || 0)} approved · ${formatCount(row[pendingField] || 0)} pending`
          : valueLabel}</span>
      </div>
      <div class="analytics-row-value">
        <span class="analytics-row-total">${formatCount(row.sent_count ?? row.approved_count ?? 0)} ${valueLabel}</span>
        <span class="analytics-row-rate">${showRate ? `${formatCount(row[rateField] || 0)}% approval` : ""}</span>
      </div>
    </div>
  `).join("");
}

/* ─── Content writer roster ────────────────────────────────
   A collapsed strip that opens into a table: total sent, then approvals in
   green, rejections in red and pending in yellow. Source, category and date
   filters are server-side because the counts are SQL rollups and cannot be
   narrowed accurately in the browser. */
let writerRoster = [];
let qaRoster = [];
let rosterMode = "writers";     // "writers" | "qa"

/* Sentinel matching the server's, for posts with no category on them. */
const UNCATEGORISED = "__none__";

const analyticsFilters = { source: "all", category: "all", from: "", to: "" };

function analyticsFilterDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return "";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" })
    .format(new Date(`${value}T12:00:00+05:30`));
}

function syncAnalyticsFilterSummary() {
  if (!analyticsFilterSummary) return;
  const source = analyticsSourceLabel?.textContent?.trim() || "All sources";
  const category = analyticsCategoryLabel?.textContent?.trim() || "All categories";
  const from = analyticsFilterDate(analyticsFilters.from);
  const to = analyticsFilterDate(analyticsFilters.to);
  const dates = from && to ? `${from} – ${to}` : from ? `From ${from}` : to ? `Until ${to}` : "All dates";
  analyticsFilterSummary.textContent = `${source} · ${category} · ${dates}`;
}

/* Copy for each side of the toggle. The writer view counts verdicts on what a
   writer sent; the QA view counts verdicts a reviewer recorded. */
const ROSTER_MODES = {
  writers: {
    title: "Content writers",
    desc: "Verdicts on each writer's posts.",
    noun: "writer",
    empty: "No writer activity yet.",
  },
  qa: {
    title: "QA approvers",
    desc: "Verdicts each reviewer has recorded.",
    noun: "approver",
    empty: "No QA verdicts yet.",
  },
};

/* Team-wide posts nobody has ruled on. Per-reviewer it would be meaningless —
   the same number repeated down every row — so it belongs in the QA-mode
   subtitle instead. */
let rosterAwaitingTotal = 0;

function escapeRosterText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function rosterInitials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function renderWriterRoster() {
  if (!analyticsRosterList) return;

  const mode = ROSTER_MODES[rosterMode] || ROSTER_MODES.writers;
  const rows = rosterMode === "qa" ? qaRoster : writerRoster;

  if (analyticsRosterTitle) analyticsRosterTitle.textContent = mode.title;
  if (analyticsRosterDesc) {
    analyticsRosterDesc.textContent = rosterMode === "qa" && rosterAwaitingTotal
      ? `${mode.desc} ${formatCount(rosterAwaitingTotal)} post${rosterAwaitingTotal === 1 ? "" : "s"} still awaiting approval.`
      : mode.desc;
  }
  if (analyticsRosterCount) {
    analyticsRosterCount.textContent = `${formatCount(rows.length)} ${mode.noun}${rows.length === 1 ? "" : "s"}`;
  }

  if (!rows.length) {
    analyticsRosterList.innerHTML = `<div class="analytics-empty">${mode.empty}</div>`;
    return;
  }

  const isQa = rosterMode === "qa";

  // A header row plus one row per person, all on the same grid track list, so
  // the counts line up into columns.
  const body = rows.map((row) => {
    const approved = Number(row.approved_count) || 0;
    const rejected = Number(row.rejected_count) || 0;
    // Total sent and awaiting both belong to a writer's own output. A QA row
    // counts verdicts recorded — it never sent anything and "not yet decided"
    // belongs to nobody in particular — hence the dashes.
    const sent = Number(row.sent_count) || 0;
    const awaiting = Number(row.pending_count) || 0;
    // Writers count posts created today; QA rows count verdicts recorded
    // today. Both values come from the same India-midnight SQL window.
    const today = Number(row.today_count) || 0;
    // Share of what they uploaded that QA cleared. Derived from the two numbers
    // in the row rather than the server's approval_rate so it can never
    // disagree with the columns either side of it. A writer with nothing sent
    // has no rate — 0% would read as a verdict nobody made.
    const rate = sent ? Math.round((approved / sent) * 100) : null;
    /* Output over the last seven days. A lifetime total tells you who has
       been here longest; this tells you who is producing now, which is the
       question anyone actually asks of a roster. The arrow compares it with
       the seven days before, so a number that is falling says so. */
    const week = Number(row.week_count) || 0;
    const prevWeek = Number(row.prev_week_count) || 0;
    const trend = week > prevWeek ? "up" : week < prevWeek ? "down" : "flat";
    const trendMark = trend === "up" ? "↑" : trend === "down" ? "↓" : "";
    const weekTitle = `${week} this week vs ${prevWeek} the week before`;
    const name = escapeRosterText(row.user_name || (isQa ? "Unknown QA" : "Unknown writer"));
    return `
      <div class="roster-row">
        <span class="roster-avatar">${escapeRosterText(rosterInitials(row.user_name))}</span>
        <span class="roster-name" title="${name}">${name}</span>
        <span class="roster-cell roster-today" title="Resets at 12:00 AM IST">${formatCount(today)}</span>
        <span class="roster-cell roster-week is-${trend}" title="${weekTitle}">${formatCount(week)}${trendMark}</span>
        <!-- Writers are measured by what they handed over, reviewers by what
             they actually put on the public site. Approving and publishing are
             different acts — a reviewer can clear a queue and send none of it —
             and this column was an em dash for reviewers because there was
             nothing to put in it until the ledger existed. -->
        <span class="roster-cell roster-sent"${isQa ? ' title="From the publish ledger — earlier publishes only left an approval behind"' : ""}>${
          isQa ? formatCount(Number(row.published_count) || 0) : formatCount(sent)
        }</span>
        <span class="roster-cell roster-approved">${formatCount(approved)}</span>
        <span class="roster-cell roster-rejected">${formatCount(rejected)}</span>
        <span class="roster-cell roster-awaiting">${isQa ? "—" : formatCount(awaiting)}</span>
        <span class="roster-cell roster-rate">${isQa || rate === null ? "—" : `${rate}%`}</span>
      </div>
    `;
  }).join("");

  analyticsRosterList.innerHTML = `
    <div class="roster-row roster-head-row">
      <span></span>
      <span>${isQa ? "Reviewer" : "Writer"}</span>
      <span class="roster-cell" title="Resets at 12:00 AM IST">Today</span>
      <span class="roster-cell">This week</span>
      <span class="roster-cell">${isQa ? "Published" : "Total sent"}</span>
      <span class="roster-cell">Approved</span>
      <span class="roster-cell">Rejected</span>
      <span class="roster-cell">Pending</span>
      <span class="roster-cell">Approved %</span>
    </div>
    ${body}
  `;
}

function setWriterRoster(rows, qaRows, awaitingTotal = 0) {
  writerRoster = Array.isArray(rows) ? rows : [];
  qaRoster = Array.isArray(qaRows) ? qaRows : [];
  rosterAwaitingTotal = Number(awaitingTotal) || 0;
  renderWriterRoster();
}

function toggleWriterRoster(force = null) {
  if (!analyticsRosterToggle || !analyticsRosterBody) return;
  const open = force === null ? analyticsRosterBody.hidden : force;
  analyticsRosterBody.hidden = !open;
  analyticsRosterToggle.setAttribute("aria-expanded", String(open));
}

if (analyticsRosterToggle) {
  analyticsRosterToggle.addEventListener("click", () => toggleWriterRoster());
}

document.querySelectorAll("[data-roster-mode]").forEach((btn) => {
  btn.addEventListener("click", (event) => {
    // Keep this event local to the mode switch; the nearby expand button owns
    // the separate show/hide action.
    event.stopPropagation();
    rosterMode = btn.dataset.rosterMode === "qa" ? "qa" : "writers";
    document.querySelectorAll("[data-roster-mode]").forEach((other) => {
      const active = other === btn;
      other.classList.toggle("is-active", active);
      other.setAttribute("aria-pressed", String(active));
    });
    renderWriterRoster();
    toggleWriterRoster(true);
  });
});

/* ── Source, category and date-range filters ──
   These narrow the SQL rollups, so every change is a refetch rather than a
   re-render.

   The options are the sections DailyMattr actually publishes into, in the
   editorial order loadSectionOptions() already resolved — the same list, and
   the same ids, the writer files under. Nothing is hard-coded here: a rename or
   a renumber on their side flows through without touching this. */
function sourceOptionEls() {
  return analyticsSourceMenu ? [...analyticsSourceMenu.querySelectorAll("[data-value]")] : [];
}

function fillSourceOptions(sources = []) {
  if (!analyticsSourceMenu) return;

  const rows = [
    { value: "all", label: "All sources" },
    ...(sources || []).map((source) => ({
      value: String(source.value || "").toLowerCase(),
      label: String(source.value || ""),
    })).filter((source) => source.value),
  ];
  if (analyticsFilters.source !== "all" && !rows.some((row) => row.value === analyticsFilters.source)) {
    rows.push({ value: analyticsFilters.source, label: analyticsFilters.source });
  }

  analyticsSourceMenu.innerHTML = rows.map(({ value, label }) => `
    <li class="analytics-select-option" role="option" tabindex="-1"
        data-value="${escapeRosterText(value)}" aria-selected="false">${escapeRosterText(label)}</li>
  `).join("");
  setSourceValue(analyticsFilters.source, { refetch: false });
}

function setSourceValue(value, { refetch = true } = {}) {
  const options = sourceOptionEls();
  const chosen = options.find((el) => el.dataset.value === value) || options[0];
  if (!chosen) return;

  options.forEach((el) => el.setAttribute("aria-selected", String(el === chosen)));
  if (analyticsSourceLabel) analyticsSourceLabel.textContent = chosen.textContent;

  const next = chosen.dataset.value;
  const changed = analyticsFilters.source !== next;
  analyticsFilters.source = next;
  syncAnalyticsFilterSummary();
  if (refetch && changed) loadAnalytics({ force: true });
}

function categoryOptionEls() {
  return analyticsCategoryMenu ? [...analyticsCategoryMenu.querySelectorAll("[data-value]")] : [];
}

function fillCategoryOptions(categories = sectionCategories) {
  if (!analyticsCategoryMenu) return;

  const rows = [
    { value: "all", label: "All categories" },
    ...(categories || []).map((c) => ({ value: String(c.id), label: String(c.name) })),
    { value: UNCATEGORISED, label: "Uncategorised" },
  ];

  analyticsCategoryMenu.innerHTML = rows.map(({ value, label }) => {
    const safeValue = escapeRosterText(value);
    return `<li class="analytics-select-option" role="option" tabindex="-1"
                data-value="${safeValue}" aria-selected="false">${escapeRosterText(label)}</li>`;
  }).join("");

  // A category can disappear between loads (the last post under it was
  // recategorised); falling back to "all" beats leaving the filter on a value
  // that is no longer selectable.
  const current = analyticsFilters.category;
  setCategoryValue(rows.some((row) => row.value === current) ? current : "all", { refetch: false });
}

function setCategoryValue(value, { refetch = true } = {}) {
  const options = categoryOptionEls();
  const chosen = options.find((el) => el.dataset.value === value) || options[0];
  if (!chosen) return;

  options.forEach((el) => el.setAttribute("aria-selected", String(el === chosen)));
  if (analyticsCategoryLabel) analyticsCategoryLabel.textContent = chosen.textContent;

  const next = chosen.dataset.value;
  const changed = analyticsFilters.category !== next;
  analyticsFilters.category = next;
  syncAnalyticsFilterSummary();
  if (refetch && changed) loadAnalytics({ force: true });
}

function openSourceMenu() {
  if (!analyticsSourceMenu || !analyticsSourceTrigger) return;
  closeCategoryMenu();
  const below = window.innerHeight - analyticsSourceTrigger.getBoundingClientRect().bottom - 24;
  analyticsSourceMenu.style.maxHeight = `${Math.max(140, Math.min(280, below))}px`;
  analyticsSourceMenu.classList.add("is-open");
  analyticsSourceTrigger.setAttribute("aria-expanded", "true");
  sourceOptionEls().find((el) => el.getAttribute("aria-selected") === "true")
    ?.scrollIntoView({ block: "nearest" });
}

function closeSourceMenu({ focusTrigger = false } = {}) {
  if (!analyticsSourceMenu || !analyticsSourceTrigger) return;
  analyticsSourceMenu.classList.remove("is-open");
  analyticsSourceTrigger.setAttribute("aria-expanded", "false");
  if (focusTrigger) analyticsSourceTrigger.focus();
}

function sourceMenuIsOpen() {
  return analyticsSourceMenu?.classList.contains("is-open") === true;
}

function moveSourceFocus(step) {
  const options = sourceOptionEls();
  if (!options.length) return;
  const active = document.activeElement;
  const from = options.indexOf(active);
  const next = from === -1
    ? options.findIndex((el) => el.getAttribute("aria-selected") === "true")
    : from + step;
  const index = Math.max(0, Math.min(options.length - 1, next === -1 ? 0 : next));
  options[index].focus();
  options[index].scrollIntoView({ block: "nearest" });
}

/* The menu opens downward and is never allowed to cover its own trigger: it is
   capped to the room actually left below, and scrolls internally past that. */
function openCategoryMenu() {
  if (!analyticsCategoryMenu || !analyticsCategoryTrigger) return;
  closeSourceMenu();
  const below = window.innerHeight - analyticsCategoryTrigger.getBoundingClientRect().bottom - 24;
  analyticsCategoryMenu.style.maxHeight = `${Math.max(140, Math.min(280, below))}px`;
  analyticsCategoryMenu.classList.add("is-open");
  analyticsCategoryTrigger.setAttribute("aria-expanded", "true");
  const selected = categoryOptionEls().find((el) => el.getAttribute("aria-selected") === "true");
  selected?.scrollIntoView({ block: "nearest" });
}

function closeCategoryMenu({ focusTrigger = false } = {}) {
  if (!analyticsCategoryMenu || !analyticsCategoryTrigger) return;
  analyticsCategoryMenu.classList.remove("is-open");
  analyticsCategoryTrigger.setAttribute("aria-expanded", "false");
  if (focusTrigger) analyticsCategoryTrigger.focus();
}

function categoryMenuIsOpen() {
  return analyticsCategoryMenu?.classList.contains("is-open") === true;
}

/* Roving focus through the options, so the list is usable without a mouse. */
function moveCategoryFocus(step) {
  const options = categoryOptionEls();
  if (!options.length) return;
  const active = document.activeElement;
  const from = options.indexOf(active);
  const next = from === -1
    ? options.findIndex((el) => el.getAttribute("aria-selected") === "true")
    : from + step;
  const index = Math.max(0, Math.min(options.length - 1, next === -1 ? 0 : next));
  options[index].focus();
  options[index].scrollIntoView({ block: "nearest" });
}

if (analyticsSourceTrigger) {
  analyticsSourceTrigger.addEventListener("click", (event) => {
    event.stopPropagation();
    if (sourceMenuIsOpen()) closeSourceMenu();
    else { openSourceMenu(); moveSourceFocus(0); }
  });

  analyticsSourceTrigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openSourceMenu();
    moveSourceFocus(0);
  });
}

if (analyticsSourceMenu) {
  analyticsSourceMenu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-value]");
    if (!option) return;
    event.stopPropagation();
    setSourceValue(option.dataset.value);
    closeSourceMenu({ focusTrigger: true });
  });

  analyticsSourceMenu.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); moveSourceFocus(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); moveSourceFocus(-1); }
    else if (event.key === "Home") { event.preventDefault(); sourceOptionEls()[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); sourceOptionEls().pop()?.focus(); }
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = event.target.closest("[data-value]");
      if (!option) return;
      setSourceValue(option.dataset.value);
      closeSourceMenu({ focusTrigger: true });
    } else if (event.key === "Escape" || event.key === "Tab") {
      closeSourceMenu({ focusTrigger: event.key === "Escape" });
    }
  });
}

if (analyticsCategoryTrigger) {
  analyticsCategoryTrigger.addEventListener("click", (event) => {
    event.stopPropagation();
    if (categoryMenuIsOpen()) closeCategoryMenu();
    else { openCategoryMenu(); moveCategoryFocus(0); }
  });

  analyticsCategoryTrigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openCategoryMenu();
    moveCategoryFocus(0);
  });
}

if (analyticsCategoryMenu) {
  analyticsCategoryMenu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-value]");
    if (!option) return;
    event.stopPropagation();
    setCategoryValue(option.dataset.value);
    closeCategoryMenu({ focusTrigger: true });
  });

  analyticsCategoryMenu.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); moveCategoryFocus(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); moveCategoryFocus(-1); }
    else if (event.key === "Home") { event.preventDefault(); categoryOptionEls()[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); categoryOptionEls().pop()?.focus(); }
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = event.target.closest("[data-value]");
      if (!option) return;
      setCategoryValue(option.dataset.value);
      closeCategoryMenu({ focusTrigger: true });
    } else if (event.key === "Escape" || event.key === "Tab") {
      closeCategoryMenu({ focusTrigger: event.key === "Escape" });
    }
  });
}

// Clicking anywhere else dismisses whichever dashboard menu is open.
document.addEventListener("click", () => {
  if (sourceMenuIsOpen()) closeSourceMenu();
  if (categoryMenuIsOpen()) closeCategoryMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && sourceMenuIsOpen()) closeSourceMenu({ focusTrigger: true });
  if (event.key === "Escape" && categoryMenuIsOpen()) closeCategoryMenu({ focusTrigger: true });
});

if (analyticsRangeApply) {
  analyticsRangeApply.addEventListener("click", () => {
    analyticsFilters.from = analyticsFrom?.value || "";
    analyticsFilters.to = analyticsTo?.value || "";
    syncAnalyticsFilterSummary();
    loadAnalytics({ force: true });
  });
}

if (analyticsRangeClear) {
  analyticsRangeClear.addEventListener("click", () => {
    if (analyticsFrom) analyticsFrom.value = "";
    if (analyticsTo) analyticsTo.value = "";
    analyticsFilters.source = "all";
    analyticsFilters.category = "all";
    setSourceValue("all", { refetch: false });
    setCategoryValue("all", { refetch: false });
    analyticsFilters.from = "";
    analyticsFilters.to = "";
    syncAnalyticsFilterSummary();
    loadAnalytics({ force: true });
  });
}

/* Recent posts, each naming its writer and opening on click.

   The leaderboards answer "who is producing"; this answers "who wrote that
   one". Rows are built with DOM nodes rather than innerHTML so headlines and
   names cannot inject markup — the boards above needed escapeHtml precisely
   because they take the string route. */
let analyticsRecentRows = [];

/* The Refresh button was never wired — it had three references in the file and
   not one of them was an event listener, so clicking it did nothing at all. */
if (analyticsRefreshBtn) {
  analyticsRefreshBtn.addEventListener("click", () => loadAnalytics({ force: true }));
}
document.getElementById("analytics-search")?.addEventListener("input", () => renderAnalyticsRecent());

function renderAnalyticsRecent() {
  const container = document.getElementById("analytics-recent");
  if (!container) return;
  const term = (document.getElementById("analytics-search")?.value || "").trim().toLowerCase();
  const rows = term
    ? analyticsRecentRows.filter((r) =>
      `${r.headline || ""} ${r.user_name || ""}`.toLowerCase().includes(term))
    : analyticsRecentRows;

  container.textContent = "";
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "analytics-empty";
    empty.textContent = analyticsRecentRows.length ? "No posts match that filter." : "No posts yet.";
    container.appendChild(empty);
    return;
  }

  for (const row of rows) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "analytics-recent-row" + (row.approved ? " is-approved" : "");
    item.title = "Open this post";

    const main = document.createElement("div");
    main.className = "analytics-recent-main";
    const title = document.createElement("span");
    title.className = "analytics-recent-title";
    title.textContent = row.headline || "(untitled)";
    const meta = document.createElement("span");
    meta.className = "analytics-recent-meta";
    meta.textContent = [
      row.user_name || "Unknown writer",
      formatLibraryDate(row.created_at),
      row.approved && row.approved_by_name ? `approved by ${row.approved_by_name}` : "",
    ].filter(Boolean).join(" · ");
    main.append(title, meta);

    const pill = document.createElement("span");
    /* Draft outranks the verdict in the label: an unsubmitted post has no
       verdict to report, and calling it "Pending" would say it is waiting on
       QA when QA cannot even see it. */
    const isDraft = Boolean(row.is_draft);
    pill.className = "status-pill" + (isDraft ? " is-draft" : row.approved ? " is-approved" : "");
    pill.textContent = isDraft ? "Draft" : row.approved ? "Approved" : "Pending";

    item.append(main, pill);
    item.addEventListener("click", () => {
      setView("poster");
      openSavedPost(row.id);
    });
    container.appendChild(item);
  }
}

async function loadAnalytics({ force = false } = {}) {
  if (!analyticsView || !state.user) return;
  if (!canReviewRole(state.user.role)) return;
  if (!force && analyticsLoadedForRole === state.user.role) return;

  if (analyticsRefreshBtn) analyticsRefreshBtn.disabled = true;
  analyticsView.setAttribute("aria-busy", "true");
  setAnalyticsStatus("Loading analytics…");

  const query = new URLSearchParams();
  if (analyticsFilters.source && analyticsFilters.source !== "all") {
    query.set("source", analyticsFilters.source);
  }
  if (analyticsFilters.category && analyticsFilters.category !== "all") {
    query.set("category", analyticsFilters.category);
  }
  if (analyticsFilters.from) query.set("from", analyticsFilters.from);
  if (analyticsFilters.to) query.set("to", analyticsFilters.to);
  const url = query.toString() ? `${PIX_ANALYTICS_ENDPOINT}?${query}` : PIX_ANALYTICS_ENDPOINT;

  try {
    const response = await fetch(url, { credentials: "same-origin" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) return handleSignedOut();
      setAnalyticsStatus(payload.error || `Could not load analytics (${response.status}).`, "error");
      return;
    }

    const role = payload.role || state.user.role || "writer";
    const analytics = payload.analytics || {};
    analyticsLoadedForRole = role;

    analyticsRecentRows = Array.isArray(analytics.recent) ? analytics.recent : [];
    renderAnalyticsRecent();

    // Sections may not have loaded yet on the first analytics open; refill from
    // whatever loadSectionOptions() has by now so the picker is never empty.
    fillCategoryOptions();
    fillSourceOptions(analytics.sources || []);
    // The server is the authority on what it actually applied — a backwards
    // range comes back swapped and invalid filters are dropped, so the controls
    // have to follow it.
    if (payload.filters) {
      setSourceValue(payload.filters.source || "all", { refetch: false });
      setCategoryValue(payload.filters.category || "all", { refetch: false });
      analyticsFilters.from = payload.filters.from || "";
      analyticsFilters.to = payload.filters.to || "";
      if (analyticsFrom) analyticsFrom.value = analyticsFilters.from;
      if (analyticsTo) analyticsTo.value = analyticsFilters.to;
      syncAnalyticsFilterSummary();
    }

    renderAnalyticsSummary(analytics.summary, role);
    renderAnalyticsDaily(analytics.daily);
    renderAnalyticsMeta(analytics.summary, role);

    /* "full" gets the team roster and the reviewer table — both QA and admin
       now, since QA works the queue and needs to see whose posts are piling
       up. The server decides which it sent and says so, rather than the
       client inferring it from the role: the two could otherwise disagree and
       render a roster the payload does not contain. */
    if ((payload.scope || "full") === "full" && canReviewRole(role)) {
      setWriterRoster(analytics.writers || [], analytics.qas || [], analytics.summary?.pending_count || 0);
    } else {
      setWriterRoster([{
        user_name: state.user.displayName || state.user.username || "You",
        sent_count: analytics.summary?.sent_count || 0,
        approved_count: analytics.summary?.approved_count || 0,
        rejected_count: analytics.summary?.rejected_count || 0,
        pending_count: analytics.summary?.pending_count || 0,
        today_count: analytics.daily?.sent_count || 0,
      }], [{
        user_name: "QA desk",
        approved_count: analytics.summary?.approved_count || 0,
        rejected_count: analytics.summary?.rejected_count || 0,
        today_count: (analytics.daily?.approved_count || 0) + (analytics.daily?.rejected_count || 0),
      }], analytics.summary?.pending_count || 0);
    }

    if (analyticsUpdated) {
      analyticsUpdated.textContent = `Updated ${new Intl.DateTimeFormat("en-IN", {
        hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
      }).format(new Date())} IST`;
    }
    setAnalyticsStatus("");
  } catch (err) {
    setAnalyticsStatus(err.message || "Could not load analytics.", "error");
  } finally {
    if (analyticsRefreshBtn) analyticsRefreshBtn.disabled = false;
    analyticsView.removeAttribute("aria-busy");
  }
}

/* ═══════════════════════ View switcher (Poster | Article) ═══════════════════════ */

const viewTabs = document.getElementById("view-tabs");
const articleView = document.getElementById("article-view");
const reviewView = document.getElementById("review-view");

/* ── Topbar title + breadcrumb ──
   The sidebar says where you are by highlight; the topbar says it in words,
   which is what makes a deep-linked or reloaded tab legible. Titles are
   role-agnostic except Review, whose label already flips between "Review" and
   "My posts" depending on who is signed in — reused here so the two never
   disagree. */
const CMS_VIEW_TITLES = {
  poster:    { title: "Create a Pix", crumb: "Create Pix" },
  article:   { title: "Article Writer", crumb: "Article" },
  review:    { title: "Review", crumb: "Review" },
  analytics: { title: "Analytics", crumb: "Analytics" },
  writers:   { title: "Content Writers", crumb: "Writers" },
};

function syncCmsHeader(view) {
  const meta = CMS_VIEW_TITLES[view] || CMS_VIEW_TITLES.poster;
  const titleEl = document.getElementById("cms-page-title");
  const crumbEl = document.getElementById("cms-crumb-current");
  const reviewLabel = document.getElementById("review-tab-label")?.textContent?.trim();
  const title = view === "review" && reviewLabel ? reviewLabel : meta.title;
  if (titleEl) titleEl.textContent = title;
  if (crumbEl) crumbEl.textContent = view === "review" && reviewLabel ? reviewLabel : meta.crumb;
}

/* ── Action bar proxies ──
   The footer buttons forward their click to the original control rather than
   duplicating its logic. Every handler, guard and disabled state written for
   those buttons keeps working, and there is still exactly one implementation
   of Save, Publish and Reject. Disabled/hidden state is mirrored back so a
   proxy can never offer something its target refuses. */
document.addEventListener("click", (e) => {
  const proxy = e.target.closest("[data-proxy]");
  if (!proxy) return;
  const target = document.getElementById(proxy.dataset.proxy);
  if (!target || target.disabled) return;
  /* Save is the one proxy that cannot forward through target.click(): the
     topbar drives the same button with two different meanings ("Save draft"
     and, for a writer, "Submit"). This used to stamp the intent onto the
     target — and never cleared it. #save-pix-btn carries no data-intent of
     its own, so after a single Submit the in-editor Save button meant Submit
     for the life of the page, and a writer could not stamp it back because
     syncPrimaryAction() hides the only "draft" proxy from them. That is how a
     half-written story reached QA's queue while it was still being typed.
     The intent is now an argument, so it lives exactly as long as the click. */
  if (target.id === "save-pix-btn") {
    runSave(proxy.dataset.intent || "draft");
    return;
  }
  target.click();
});

setInterval(() => {
  for (const proxy of document.querySelectorAll("[data-proxy]")) {
    const target = document.getElementById(proxy.dataset.proxy);
    if (!target) continue;
    proxy.disabled = Boolean(target.disabled);
    /* A proxy hidden by ROLE stays hidden. Mirroring the target's own hidden
       flag unconditionally was undoing that every 500ms — Save draft kept
       reappearing for writers, because the button it proxies is not itself
       hidden, only irrelevant to them. */
    if (proxy.dataset.roleHidden === "true") { proxy.hidden = true; continue; }
    proxy.hidden = Boolean(target.hidden);
  }
}, 500);

/* The footer's own saved indicator. Autosave writes silently by design, so
   without this the only sign anything happened was a status line three
   columns away. */
const cmsAutosave = document.getElementById("cms-autosave");
const cmsAutosaveText = document.getElementById("cms-autosave-text");
let cmsAutosaveTimer = null;

function showAutosaved(label) {
  if (!cmsAutosave) return;
  if (cmsAutosaveText) cmsAutosaveText.textContent = label;
  cmsAutosave.hidden = false;
  clearTimeout(cmsAutosaveTimer);
  cmsAutosaveTimer = setTimeout(() => { cmsAutosave.hidden = true; }, 6000);
}

/* ── The primary action is not the same job for both roles ──

   A writer cannot publish at all — the server returns 403 — so a "Publish"
   button was offering them an action that could only fail. What they actually
   do is hand the post to QA, which is what saving does. So for a writer the
   primary button says Submit and drives the save, and the separate Save draft
   is dropped: with only one action, two buttons doing the same thing is just
   a question the writer has to answer for no reason.

   QA and admin keep Publish, wired to the DailyMattr publish. */
function syncPrimaryAction() {
  const primary = document.querySelector('.cms-topbar-actions .btn-primary');
  const draft = document.querySelector('.cms-topbar-actions [data-proxy="save-pix-btn"]');
  if (!primary || !state.user) return;
  const reviewer = canReviewRole(state.user.role);
  primary.textContent = reviewer ? "Publish" : "Submit";
  primary.dataset.proxy = reviewer ? "dailymattr-publish-btn" : "save-pix-btn";
  primary.dataset.intent = "submit";        // Submit hands the post to QA
  primary.title = reviewer
    ? "Publish this pix to the web app"
    : "Save and send to QA for review";
  if (draft) {
    draft.dataset.roleHidden = reviewer ? "false" : "true";
    draft.hidden = !reviewer;
  }
  /* Last, so it can override the "Publish" just written above for a post that
     is already live. Running it the other way round would leave the topbar
     offering an action the panel below it has disabled. */
  syncPublishState();
}

/* ── Collapsing the rail ──
   Icons rather than nothing: hiding it outright would leave no way back
   except a control floating over the content, and no sense of where you are.
   The choice is remembered, because a collapsed rail is a working preference
   about screen space, not a per-page state. */
const navCollapseBtn = document.getElementById("nav-collapse");

function setNavCollapsed(collapsed) {
  document.body.classList.toggle("nav-collapsed", collapsed);
  localStorage.setItem("pix-nav-collapsed", collapsed ? "1" : "0");
  if (navCollapseBtn) {
    navCollapseBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    navCollapseBtn.setAttribute("aria-label", collapsed ? "Expand the navigation" : "Collapse the navigation");
    navCollapseBtn.title = collapsed ? "Expand" : "Collapse";
  }
  // The poster canvas is sized from its column, which just changed width.
  requestAnimationFrame(() => { try { renderPoster(); } catch {} });
}

setNavCollapsed(localStorage.getItem("pix-nav-collapsed") === "1");
navCollapseBtn?.addEventListener("click", () =>
  setNavCollapsed(!document.body.classList.contains("nav-collapsed")));

/* ── Keeping the tally true across tabs ──

   The count is a fact about the database, not about this tab, and writers
   work in several at once — scrape in one, write in another, keep a third on
   My posts. An event-driven refresh only ever knew about saves made HERE, so
   every other tab drifted and stayed drifted until someone reloaded it. It
   also went stale on its own overnight: the "today" figure is relative to the
   IST day, so a tab left open past midnight kept yesterday's number.

   Three signals, cheapest first:

   1. Same-browser tabs tell each other directly. BroadcastChannel makes a
      save in one tab land in the others within a frame, so the common case —
      two tabs, one person — needs no polling at all.
   2. Coming back to a tab re-reads. This is when a stale number is actually
      SEEN, and it also covers what a broadcast cannot: a second browser, a
      phone, or a colleague's verdict on your post.
   3. A slow poll underneath, for a tab sitting visible and untouched — a
      writer watching their own count while a reviewer works through the
      queue. 60s, because this is an ornament, not a live feed. */
/* Identifies this tab so a broadcast can be told apart from its own echo.
   crypto.randomUUID is not available on http:// origins in some browsers,
   hence the fallback — the value only has to be unique among open tabs.

   Declared BEFORE the listener that reads it. The callback is deferred so the
   other order would run correctly, but a `const` referenced above its own
   declaration is exactly the shape of the temporal-dead-zone crash this file
   has hit before, and it is not worth leaving for someone to re-derive. */
const PIX_TAB_ID = (crypto.randomUUID?.() || String(Math.random()).slice(2));

/* The most recent /api/pix/stats answer. Today and this week are counted
   across the whole library by the server; the list on screen is capped at 200
   rows, so deriving them from it would quietly under-report for anyone busy
   enough to need the number. */
let lastPixCounts = null;

const pixCountChannel = ("BroadcastChannel" in window) ? new BroadcastChannel("pix-counts") : null;

pixCountChannel?.addEventListener("message", (e) => {
  // Ignore our own echo; a save here already refreshed directly.
  if (e.data?.tab !== PIX_TAB_ID) refreshMyPixCount();
});

function announceCountChange() {
  try { pixCountChannel?.postMessage({ tab: PIX_TAB_ID, at: Date.now() }); } catch {}
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshMyPixCount();
});
window.addEventListener("focus", () => refreshMyPixCount());

setInterval(() => {
  // A hidden tab is not being read, and a signed-out one has nothing to count.
  if (document.visibilityState === "visible" && state.user) refreshMyPixCount();
}, 60_000);

const cmsToday = document.getElementById("cms-today");
if (cmsToday) {
  cmsToday.textContent = new Date().toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function setView(view) {
  // Signed out, there is nothing to list.
  if ((view === "review" || view === "analytics" || view === "writers") && !state.user) view = "poster";
  // Analytics and Writers are QA-only; a writer landing here (stale tab, deep
  // link) goes home. The server refuses them too — this is only the redirect.
  if (view === "analytics" && !canReviewRole(state.user?.role)) view = "poster";
  // The roster is the admin's screen; QA landing here (stale tab, deep link)
  // goes home. The server refuses it too.
  if (view === "writers" && !isAdminRole(state.user?.role)) view = "poster";

  document.body.classList.toggle("view-article", view === "article");
  document.body.classList.toggle("view-review", view === "review");
  document.body.classList.toggle("view-analytics", view === "analytics");
  document.body.classList.toggle("view-writers", view === "writers");
  if (articleView) articleView.hidden = view !== "article";
  if (reviewView) reviewView.hidden = view !== "review";
  if (analyticsView) analyticsView.hidden = view !== "analytics";
  if (writersView) writersView.hidden = view !== "writers";
  if (viewTabs) {
    viewTabs.querySelectorAll(".view-tab").forEach(t => {
      const active = t.dataset.view === view;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
  }
  syncCmsHeader(view);
  // The mobile edit sheet makes no sense away from the poster — drop it
  if (view !== "poster") setSheetOpen(false);
  if (view === "review") loadReviewQueue();
  if (view === "analytics") loadAnalytics({ force: true });
  if (view === "writers") loadWriters();
}

if (viewTabs) {
  viewTabs.addEventListener("click", (e) => {
    const tab = e.target.closest(".view-tab");
    if (tab) setView(tab.dataset.view);
  });
}

/* ═══════════════════════ AI Article Writer ═══════════════════════ */

const articleGenerateBtn = document.getElementById("article-generate-btn");
const articleStatus      = document.getElementById("article-status");
const articleResult      = document.getElementById("article-result");

function setArticleStatus(msg, kind) {
  if (!articleStatus) return;
  articleStatus.className = "status-text" + (kind ? ` ${kind}` : "");
  articleStatus.textContent = msg || "";
}

/**
 * Generate the article package and fill the slides with it.
 *
 * `applyToSlides` is what closes the loop that used to be missing: the writer
 * produced a headline and bullets that only ever landed in the Article tab and
 * the clipboard, so the poster still showed the raw scraped title and the Text
 * slide still showed the raw scraped paragraph. Now one action fills both.
 */
async function generateArticle({ applyToSlides = false } = {}) {
  const headline = (state.headline || "").trim();
  if (!headline) {
    setArticleStatus("No story yet — scrape a link or write a headline first.", "error");
    return null;
  }

  if (articleGenerateBtn) articleGenerateBtn.disabled = true;
  setArticleStatus("Writing headline, bullets and tweet…");

  try {
    const resp = await fetch("/api/generate-article", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        headline,
        sourceUrl: state.sourceUrl || "",
        // Pass the text we already scraped so the server does not re-fetch.
        articleText: state.articleText || state.detailText || "",
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

    renderArticle(data);
    state.article = data;

    if (applyToSlides) {
      // The writer can be typing while this request is in flight — the scrape
      // fires it and it lands ~10s later. Overwriting an edit made in that
      // window silently threw it away, and [highlight brackets] added right
      // after a scrape were the usual casualty.
      if (data.headline && !state.headlineTouched) {
        state.headline = data.headline;
        if (headlineEdit) headlineEdit.value = data.headline;
        if (writeHeadline) writeHeadline.value = data.headline;
      }
      if (Array.isArray(data.bullets) && data.bullets.length && !state.detailTouched) {
        // Bulleted, one per line — drawPixTextScreen already renders a
        // bullet glyph for lines starting with a dash.
        const block = data.bullets.map((b) => `- ${b}`).join("\n");
        state.detailText = limitDetailTextClient(block);
        if (detailEdit) detailEdit.value = state.detailText;
        if (writeDetail) writeDetail.value = state.detailText;
      }
      renderPoster();
    }

    // Thin sources produce thin bullets; say so rather than let it look
    // like the writer underperformed.
    const thin = data.sourceChars !== undefined && data.sourceChars < 200;
    setArticleStatus(
      thin
        ? "✓ Done — but little source text was found, so the points are general. Check the article link."
        : "✓ Done — review before publishing.",
      thin ? "error" : "success"
    );
    return data;
  } catch (err) {
    setArticleStatus(`Generation failed: ${err.message}`, "error");
    return null;
  } finally {
    if (articleGenerateBtn) articleGenerateBtn.disabled = false;
  }
}

if (articleGenerateBtn) {
  articleGenerateBtn.addEventListener("click", () => generateArticle({ applyToSlides: true }));
}

function renderArticle({ headline, bullets, tweet, flags, spec }) {
  // The editorial spec travels with the payload, so these numbers live in
  // exactly one place (server.mjs). Fallbacks only matter for a cached
  // response from an older deploy.
  const HEADLINE_MAX_CHARS = spec?.headlineMax ?? 90;
  const BULLET_MIN_CHARS   = spec?.bulletMin   ?? 115;
  const BULLET_MAX_CHARS   = spec?.bulletMax   ?? 125;

  const headEl   = document.getElementById("article-headline");
  const bulletEl = document.getElementById("article-bullets");
  const tweetEl  = document.getElementById("article-tweet");
  const flagsBlk = document.getElementById("article-flags-block");
  const flagsEl  = document.getElementById("article-flags");

  headEl.textContent = headline;
  const headCount = document.getElementById("article-headline-count");
  headCount.textContent = `${headline.length} / ${HEADLINE_MAX_CHARS}`;
  headCount.classList.toggle("over", headline.length > HEADLINE_MAX_CHARS);

  // Per-bullet counts. The spec is a tight character band, so showing the
  // actual length per bullet is the only way to see at a glance whether the
  // model hit it — a total or an average would hide one bad bullet.
  bulletEl.innerHTML = "";
  bullets.forEach(b => {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = b;
    const count = document.createElement("span");
    count.className = "bullet-count";
    count.textContent = b.length;
    const outOfBand = b.length < BULLET_MIN_CHARS || b.length > BULLET_MAX_CHARS;
    count.classList.toggle("over", outOfBand);
    count.title = outOfBand
      ? `${b.length} characters — outside the ${BULLET_MIN_CHARS}-${BULLET_MAX_CHARS} target`
      : `${b.length} characters`;
    li.append(text, count);
    bulletEl.appendChild(li);
  });

  tweetEl.textContent = tweet;
  const tweetCount = document.getElementById("article-tweet-count");
  tweetCount.textContent = `${tweet.length} / 280`;
  tweetCount.classList.toggle("over", tweet.length > 280);

  if (flags && flags.length) {
    flagsEl.innerHTML = "";
    flags.forEach(f => {
      const li = document.createElement("li");
      li.textContent = f;
      flagsEl.appendChild(li);
    });
    flagsBlk.hidden = false;
  } else {
    flagsBlk.hidden = true;
  }

  articleResult.hidden = false;
}

// Copy buttons — per-block and copy-all
function flashCopied(btn) {
  const prev = btn.textContent;
  btn.textContent = "Copied ✓";
  btn.classList.add("copied");
  setTimeout(() => { btn.textContent = prev; btn.classList.remove("copied"); }, 1400);
}

document.querySelectorAll(".copy-btn[data-copy-target]").forEach(btn => {
  btn.addEventListener("click", async () => {
    const el = document.getElementById(btn.dataset.copyTarget);
    if (!el) return;
    const text = el.tagName === "UL"
      ? [...el.querySelectorAll("li")].map(li => `• ${li.textContent}`).join("\n")
      : el.textContent;
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(btn);
    } catch { /* clipboard denied */ }
  });
});

const copyAllBtn = document.getElementById("article-copy-all");
if (copyAllBtn) {
  copyAllBtn.addEventListener("click", async () => {
    const head    = document.getElementById("article-headline")?.textContent || "";
    const bullets = [...document.querySelectorAll("#article-bullets li")].map(li => `• ${li.textContent}`).join("\n");
    const tweet   = document.getElementById("article-tweet")?.textContent || "";
    const full = `${head}\n\n${bullets}\n\n${tweet}`;
    try {
      await navigator.clipboard.writeText(full);
      const prev = copyAllBtn.textContent;
      copyAllBtn.textContent = "✓ Copied everything";
      setTimeout(() => { copyAllBtn.textContent = prev; }, 1400);
    } catch { /* clipboard denied */ }
  });
}

/* ═══════════════════════ AI Enhance (gpt-image-1) ═══════════════════════ */

const aiEnhanceBtn    = document.getElementById("ai-enhance-btn");
const aiEnhanceStatus = document.getElementById("ai-enhance-status");

function setEnhanceStatus(msg, kind) {
  if (!aiEnhanceStatus) return;
  aiEnhanceStatus.className = "status-text" + (kind ? ` ${kind}` : "");
  aiEnhanceStatus.textContent = msg || "";
}

const enhanceModeSel    = document.getElementById("enhance-mode");
const expandAmountSel   = document.getElementById("expand-amount");
const expandAmountField = document.getElementById("expand-amount-field");

/* Two jobs behind one button.

     restore  the photograph as it is framed, with detail recovered.
     expand   the photograph placed smaller in a wider frame, with the rest of
              the subject and the setting drawn outward into the margin — the
              zoom-out. A press photo cropped at the chest comes back with the
              body; a landscape photo comes back tall enough for a 9:16 poster
              instead of being cut to a strip by the canvas.

   Which one runs is normally the server's stage 1 to decide, from the
   photograph itself — see planEnhance() in server.mjs. The select is there for
   a reviewer who disagrees with a verdict.

   Everything around the call is identical either way — the snapshot, the page
   guard, the status line, the failure path — so there is one of it. What
   differs is the mode header, and what happens to the writer's framing when
   the picture lands. */
const ENHANCE_LABELS = {
  restore: { done: "Restored and upscaled", failed: "Restore failed" },
  expand:  { done: "Expanded and reframed", failed: "Expand failed" },
};

const ENHANCE_WORKING = {
  auto:    "Reading the photograph, then recovering detail at your framing (30–90s)…",
  restore: "Restoring and upscaling — analysing the photo, then recovering detail (30–90s)…",
  expand:  "Expanding — reading how the photo is cropped, then drawing the scene outward (30–90s)…",
};

/* Pull back is the distance to zoom out, and it only means anything when a
   reviewer has forced expand. On Auto the stage that picks the job picks the
   distance from the same look at the photograph, so leaving the control up
   would offer a choice nothing is reading. */
function syncEnhanceModeUI() {
  if (!expandAmountField) return;
  expandAmountField.hidden = (enhanceModeSel?.value || "auto") !== "expand";
}
if (enhanceModeSel) enhanceModeSel.addEventListener("change", syncEnhanceModeUI);
syncEnhanceModeUI();

async function runImageAI() {
  const btn = aiEnhanceBtn;
  const requestedMode = enhanceModeSel?.value || "auto";
  const img = state.mainImage;
  if (!img) return;
  // Whose picture this is. Read before the first await — see the commit below.
  const enhanceOwner = activePage();

  btn.disabled = true;
  btn.classList.add("working");
  setEnhanceStatus(ENHANCE_WORKING[requestedMode] || ENHANCE_WORKING.auto);

  try {
    // Snapshot the current background to a temp canvas, capped at 1536 on
    // the long edge (gpt-image-1's max output — no point uploading more).
    const rawW = img.naturalWidth || img.width;
    const rawH = img.naturalHeight || img.height;
    const scale = Math.min(1, 1536 / Math.max(rawW, rawH));
    const tmp = document.createElement("canvas");
    tmp.width  = Math.round(rawW * scale);
    tmp.height = Math.round(rawH * scale);
    tmp.getContext("2d").drawImage(img, 0, 0, tmp.width, tmp.height);

    const blob = await new Promise(r => tmp.toBlob(r, "image/png"));
    if (!blob) throw new Error("Couldn't read the current image.");

    const resp = await fetch("/api/upscale-image", {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        "X-Image-Orientation": rawW >= rawH ? "landscape" : "portrait",
        // Read by the expand path, which renders into the poster's shape so
        // there is somewhere for the widened scene to go. The restore path
        // ignores it and follows the source — see sizeForRatio() in
        // server.mjs for why asking it for the poster's shape is what
        // produced the invented margin.
        "X-Poster-Ratio": state.aspectRatio || "",
        // Story context helps the vision stage understand what the photo
        // shows, which sharpens the "preserve exactly this" instructions.
        "X-Headline": encodeURIComponent((state.headline || "").slice(0, 200)),
        // Which job to run, or "auto" to let the server's stage 1 choose from
        // the photograph. The server defaults to restore when this is absent
        // or unrecognised — a caller that says nothing gets the job that
        // reframes nothing.
        "X-Enhance-Mode": requestedMode,
        // How far to pull back, when expand has been forced. Ignored on the
        // auto path, where stage 1 sets it; sent always so the request shape
        // does not depend on the mode.
        "X-Expand-Amount": expandAmountSel?.value || "moderate",
        /* The real pixel size, which the server cannot cheaply read out of the
           PNG and the browser has in hand. The planner needs it: an expand
           places the photograph smaller inside a fixed-size output, so a small
           source comes back with less on the face than it started with, and
           shape alone cannot tell a 400px crop from a 3000px one. These are
           the capped dimensions, which is what the model will actually see. */
        "X-Source-Size": `${tmp.width}x${tmp.height}`,
        // How much of the model output to keep. Both upscalers manufacture
        // roughly twice the fine detail the original had, which is what
        // reads as a painted face; mixing back toward a plain resample is
        // the dial for that.
        "X-Enhance-Strength": String((state.enhanceStrength ?? 20) / 100),
      },
      body: blob,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    if (!data.image) throw new Error("No image returned.");

    // Swap the background for the enhanced version
    const enhanced = new Image();
    await new Promise((resolve, reject) => {
      enhanced.onload = resolve;
      enhanced.onerror = () => reject(new Error("Enhanced image failed to load."));
      enhanced.src = data.image;
    });
    await ensureImageFocalPoint(enhanced);
    /* Onto the page that was selected when Enhance was pressed. This runs
       30-90 seconds after the click and had no page guard at all, so a
       writer who clicked through the carousel while waiting watched the
       slide they happened to be looking at swap to page 1's enhanced photo
       — destroying that slide's own picture, unrecoverable when it was a
       drag-and-drop upload. */
    commitFieldToPage(enhanceOwner, "mainImage", enhanced);

    /* An expanded picture is a different picture — wider, with the subject
       smaller inside it — so the zoom and pan the writer set to rescue the
       old framing now fight the new one. A 160% zoom applied to a frame that
       was widened precisely to stop the canvas cropping crops it again, and
       the call is paid for and looks like it did nothing.

       Reset to the unframed defaults, exactly as a freshly picked image
       arrives (see resetImageControls / stashImageForAbsentPage), and let
       the writer reframe from there. A restore keeps its framing: same
       picture, same shape, so the numbers still mean what they meant. */
    if (data.mode === "expand") {
      commitFieldToPage(enhanceOwner, "imageOffset", { x: 0, y: 0 });
      commitFieldToPage(enhanceOwner, "imageZoom", 100);
      if (activePage() === enhanceOwner) {
        syncControl(imgOffsetX, 0);
        syncControl(imgOffsetY, 0);
        syncControl(imgZoom, 100);
      }
    }

    renderPoster();

    /* Say what ran, and on the auto path say why.

       A reviewer who pressed one button and got a reframed photograph is owed
       the reason — not to justify the software, but because the verdict is the
       thing they might disagree with, and the select above is how they say so
       on the next press. "Expanded and reframed" alone gives them nothing to
       push against; "he was cropped at mid-chest with no room below" does. */
    const label = ENHANCE_LABELS[data.mode] || ENHANCE_LABELS.restore;
    const engineLabel = data.engine || "AI";
    const why = requestedMode === "auto" && data.reason ? ` — ${data.reason}` : "";
    setEnhanceStatus(`✓ ${label.done} via ${engineLabel}${why}. Re-pick a stock image to undo.`, "success");
  } catch (err) {
    // Before the response lands there is no resolved mode, so the failure is
    // named after what was asked for. On auto that is neither job yet.
    const failed = ENHANCE_LABELS[requestedMode]?.failed || "Enhance failed";
    setEnhanceStatus(`${failed}: ${err.message}`, "error");
  } finally {
    btn.classList.remove("working");
    btn.disabled = !state.mainImage;
  }
}

if (aiEnhanceBtn) aiEnhanceBtn.addEventListener("click", () => runImageAI());

/* ── Theme toggle (dark default; persisted in localStorage) ── */
(function initThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;

  const themeColorMeta = document.querySelector('meta[name="theme-color"]');

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pix-theme", theme);
    if (themeColorMeta) {
      themeColorMeta.setAttribute("content", theme === "dark" ? "#0e1117" : "#f5f7fb");
    }
    btn.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }

  // Sync meta/aria with whatever the head bootstrap already applied
  applyTheme(document.documentElement.dataset.theme || "light");

  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
  });
})();

/* ═══════════════════════ Slide 2 — video ═══════════════════════

   Slide 2 is either the Text card or a directly uploaded video clip. The clip
   gets trimmed to a range chosen here and is exported with the Pix branding
   burned in by ffmpeg. Legacy URL-backed posts can still be reopened, but new
   videos enter through file upload only.

   Both endpoints are ordinary same-origin routes on this server, which
   shells out to yt-dlp and ffmpeg. An earlier version POSTed to a separate
   host with an HMAC token because Vercel caps serverless request bodies at
   4.5 MB, far below a video upload — Railway has no such cap, so the second
   service, the shared secret and the CORS config are all gone.
   ══════════════════════════════════════════════════════════════ */

const MAX_CLIP_SECONDS = 90;          // matches MAX_CLIP_SECONDS on the service
const MAX_VIDEO_UPLOAD_BYTES = 300 * 1024 * 1024;

const videoFileInput   = document.getElementById("video-file-input");
const videoFileDrop    = document.getElementById("video-file-drop");
const videoFileLabel   = document.getElementById("video-file-label");
const videoStatusEl    = document.getElementById("video-status");
const videoEditor      = document.getElementById("video-editor");
const videoPreviewEl   = document.getElementById("video-preview");
const trimStartInput   = document.getElementById("trim-start");
const trimEndInput     = document.getElementById("trim-end");
const trimStartLabel   = document.getElementById("trim-start-label");
const trimEndLabel     = document.getElementById("trim-end-label");
const trimDurationEl   = document.getElementById("trim-duration");
const videoMuteInput   = document.getElementById("video-mute");
const videoExportBtn   = document.getElementById("video-export-btn");

function setVideoStatus(message, type) {
  if (!videoStatusEl) return;
  videoStatusEl.textContent = message || "";
  videoStatusEl.className = "status-text";
  if (type) videoStatusEl.classList.add(type);
}

function formatTimecode(seconds) {
  const s = Math.max(0, seconds || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}

/* The video endpoints are ordinary same-origin routes on this server — the
   backend shells out to yt-dlp and ffmpeg. There is no second host, no
   shared secret and no token exchange: that only existed to work around
   Vercel's 4.5 MB serverless body cap, which Railway doesn't have. */

// Swap the export button into a visible working state. The encode reports no
// percentage, so this is an indeterminate "still going" signal, not progress.
function setExportWorking(working) {
  const btn = document.getElementById("video-export-btn");
  const label = document.getElementById("video-export-label");
  const bar = document.getElementById("video-export-progress");
  if (btn) btn.classList.toggle("working", working);
  if (label) label.textContent = working ? "Exporting…" : "Export Video";
  if (bar) bar.hidden = !working;
}

async function mediaErrorMessage(res) {
  const data = await res.json().catch(() => null);
  if (data && data.error) return data.error;
  if (res.status === 413) return "That file is too large.";
  if (res.status === 504) return "The server timed out. Try a shorter clip.";
  return `Server error ${res.status}.`;
}

/* ── Source: local file ── */
function loadLocalVideoFile(file) {
  if (!file) return;
  if (!file.type.startsWith("video/")) {
    setVideoStatus("That is not a video file.", "error");
    return;
  }
  if (file.size > MAX_VIDEO_UPLOAD_BYTES) {
    setVideoStatus(`That file is ${(file.size / 1048576).toFixed(0)} MB; the limit is 300 MB.`, "error");
    return;
  }

  state.videoFile = file;
  state.videoUrl = "";
  state.videoMeta = null;
  state.videoSourceKind = "file";
  state.videoFileName = file.name;
  /* A new source means the stored copy is no longer this post's video.

     storedVideoUrl/storedVideoFor were cleared in only two places — starting a
     new post, and blanking a page — never when the clip itself was replaced.
     So swapping the video and then hitting an encode failure saved the row
     pointing at the PREVIOUS clip: reopening played the old footage, and
     restoreStoredVideo stamped storedVideoFor to match it, so the next Submit
     took the "already stored and unchanged" shortcut and reported nothing at
     all. QA then published the old video, to a write-only API. */
  state.storedVideoUrl = null;
  state.storedVideoFor = null;
  state.renderedClip = null;
  if (videoFileLabel) videoFileLabel.textContent = file.name;

  const objectUrl = URL.createObjectURL(file);
  if (videoPreviewEl) {
    videoPreviewEl.poster = "";
    videoPreviewEl.src = objectUrl;
    // Revoking on load would break seeking — the URL is released when the
    // source is replaced instead.
    videoPreviewEl.addEventListener("loadedmetadata", () => {
      setupTrimRange(videoPreviewEl.duration || 0);
      if (videoEditor) videoEditor.hidden = false;
      setVideoStatus(`${file.name} · ${formatTimecode(videoPreviewEl.duration)}`, "success");
      // Onto the video page, not just into state — see commitVideoToItsPage.
      commitVideoToItsPage();
      renderPoster();
      if (!videoPreviewEl.paused) startVideoPreviewLoop();
    }, { once: true });
  }
}

/* File the video under the page that owns it, whatever is selected.

   The video controls live in the left panel, not in the page rail, so the
   natural way to add a clip is to be looking at page 1 while doing it. But the
   video fields are PAGE-owned: syncActivePageContent() captures the fields of
   the SELECTED page, and page 1's list has no video in it — so a clip added
   from page 1 was written into `state` and nowhere else. The moment the writer
   clicked the Video card to look at it, applyPageFields loaded that page's
   (empty) content over the top and the File was gone: state.videoFile null,
   trim back to 0, videoClipKey() null.

   That is why so many posts saved with a trim range and no storedUrl, and why
   the console said "clip skipped, no key" — the file had been destroyed by a
   click, before Save ever ran, and an uploaded File cannot be recovered.

   So the moment a video is loaded it is committed to its own page. Selecting
   that page then LOADS the clip instead of erasing it, and withPrimaryVideo()
   finds it at save time from whichever page is on screen. */
function commitVideoToItsPage() {
  /* The page the writer is actually on, not "the primary video page".

     primaryVideoPage() deliberately prefers a page that ALREADY holds a clip,
     which makes the first video page a permanent magnet: on a post with two
     Video slides, loading footage into slide 4 was written onto slide 2
     instead. And because the commit below replaces every video field at once,
     that did not merely misfile the new clip — it overwrote slide 2's
     storedVideoUrl, destroying footage that was already uploaded and saved.

     Video controls are scope-gated to video pages (PAGE_SCOPE.video), so the
     selected page IS the right answer on the normal path; the primary is only
     a fallback for a clip arriving from somewhere else. */
  const active = activePage();
  const page = (active?.type === "video" ? active : primaryVideoPage()) || ensureVideoPage();

  /* No page to put it on. ensureVideoPage() returns null when the rail is
     full, and every caller discarded that null — the status line had already
     said "success", so the clip simply evaporated at save time inside
     withPrimaryVideo(), which substitutes a blank video page and writes the
     row with no clip WHILE the editor carries on showing the video. Said here
     rather than at the call sites so future callers inherit it. */
  if (!page) {
    setVideoStatus(
      `This post already has all ${MAX_PAGES} slides, so the clip has nowhere to live — remove a page and add the video again.`,
      "error",
    );
    return null;
  }

  if (!page.content) page.content = {};
  Object.assign(page.content, capturePageFields(VIDEO_PAGE_FIELDS));
  return page;
}

/* Commit an async result to the page that OWNED it when the work started.

   Anything that finishes after an await — an enhance, a stock pick, a scrape,
   a vision call, an encode — was started FOR a particular page, and the writer
   is free to click a different card while it runs. Writing the result into
   live `state` on arrival files it under whatever page happens to be selected
   at that moment: the wrong slide gets the picture, and the slide it was meant
   for keeps nothing. Worse, if the selected page does not own the field at
   all, syncActivePageContent() spills it onto page 1.

   So: write through the owning page, and touch `state` only while that page is
   still the one on screen. Same shape as commitVideoToItsPage(). */
function commitFieldToPage(page, field, value) {
  if (!page) return;
  if (!page.content) page.content = {};
  page.content[field] = value;
  if (activePage() === page) state[field] = value;
}

/* ── Trim ── */
function setupTrimRange(duration) {
  const dur = Math.max(0, duration || 0);
  state.trimStart = 0;
  state.trimEnd = Math.min(dur || MAX_CLIP_SECONDS, MAX_CLIP_SECONDS);
  if (trimStartInput) {
    trimStartInput.max = String(dur || MAX_CLIP_SECONDS);
    trimStartInput.value = "0";
  }
  if (trimEndInput) {
    trimEndInput.max = String(dur || MAX_CLIP_SECONDS);
    trimEndInput.value = String(state.trimEnd);
  }
  syncTrimUI();
}

function syncTrimUI() {
  const duration = Math.max(0, state.trimEnd - state.trimStart);
  if (trimStartLabel) trimStartLabel.textContent = formatTimecode(state.trimStart);
  if (trimEndLabel) trimEndLabel.textContent = formatTimecode(state.trimEnd);
  if (trimDurationEl) {
    trimDurationEl.textContent = `${duration.toFixed(1)}s`;
    trimDurationEl.classList.toggle("over-limit", duration > MAX_CLIP_SECONDS || duration <= 0);
  }
  if (videoExportBtn) {
    videoExportBtn.disabled =
      state.videoExporting || duration <= 0 || duration > MAX_CLIP_SECONDS ||
      (!state.videoUrl && !state.videoFile);
  }
}

// Start and End get one range input each; clamping here (rather than
// building a custom dual-handle widget) is what stops them crossing over.
if (trimStartInput) {
  trimStartInput.addEventListener("input", () => {
    state.trimStart = Math.min(parseFloat(trimStartInput.value) || 0, state.trimEnd - 0.1);
    trimStartInput.value = String(state.trimStart);
    if (videoPreviewEl && videoPreviewEl.src) videoPreviewEl.currentTime = state.trimStart;
    syncTrimUI();
  });
}

if (trimEndInput) {
  trimEndInput.addEventListener("input", () => {
    state.trimEnd = Math.max(parseFloat(trimEndInput.value) || 0, state.trimStart + 0.1);
    trimEndInput.value = String(state.trimEnd);
    if (videoPreviewEl && videoPreviewEl.src) videoPreviewEl.currentTime = state.trimEnd;
    syncTrimUI();
  });
}

const trimSetStartBtn = document.getElementById("trim-set-start");
if (trimSetStartBtn) {
  trimSetStartBtn.addEventListener("click", () => {
    if (!videoPreviewEl || !videoPreviewEl.src) return;
    state.trimStart = Math.min(videoPreviewEl.currentTime, state.trimEnd - 0.1);
    if (trimStartInput) trimStartInput.value = String(state.trimStart);
    syncTrimUI();
  });
}

const trimSetEndBtn = document.getElementById("trim-set-end");
if (trimSetEndBtn) {
  trimSetEndBtn.addEventListener("click", () => {
    if (!videoPreviewEl || !videoPreviewEl.src) return;
    state.trimEnd = Math.max(videoPreviewEl.currentTime, state.trimStart + 0.1);
    if (trimEndInput) trimEndInput.value = String(state.trimEnd);
    syncTrimUI();
  });
}

// Preview exactly the selected range, then stop at the out-point.
const trimPlayBtn = document.getElementById("trim-play");
if (trimPlayBtn) {
  trimPlayBtn.addEventListener("click", () => {
    if (!videoPreviewEl || !videoPreviewEl.src) {
      setVideoStatus("Load a video first.", "error");
      return;
    }
    videoPreviewEl.currentTime = state.trimStart;
    videoPreviewEl.play();
    const stopAtEnd = () => {
      if (videoPreviewEl.currentTime >= state.trimEnd) {
        videoPreviewEl.pause();
        videoPreviewEl.removeEventListener("timeupdate", stopAtEnd);
      }
    };
    videoPreviewEl.addEventListener("timeupdate", stopAtEnd);
  });
}

if (videoMuteInput) {
  videoMuteInput.addEventListener("change", () => {
    state.videoMuted = videoMuteInput.checked;
  });
}

/* The caption is painted by drawPixVideoScreen, which produces both the
   live preview and the PNG ffmpeg burns in — so a repaint is all that's
   needed here, and what you see is exactly what gets exported. */
const videoCaptionInput = document.getElementById("video-caption");
if (videoCaptionInput) {
  videoCaptionInput.addEventListener("input", () => {
    state.videoCaption = videoCaptionInput.value;
    renderPoster();
  });
}

const videoCaptionSizeInput = document.getElementById("video-caption-size");
if (videoCaptionSizeInput) {
  videoCaptionSizeInput.addEventListener("input", () => {
    state.videoCaptionSize = Number(videoCaptionSizeInput.value) || 40;
    renderPoster();
  });
}

if (videoFileInput) {
  videoFileInput.addEventListener("change", (e) => loadLocalVideoFile(e.target.files && e.target.files[0]));
}

if (videoFileDrop) {
  videoFileDrop.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    videoFileInput?.click();
  });
  ["dragenter", "dragover"].forEach((ev) =>
    videoFileDrop.addEventListener(ev, (e) => {
      e.preventDefault();
      videoFileDrop.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    videoFileDrop.addEventListener(ev, (e) => {
      e.preventDefault();
      videoFileDrop.classList.remove("dragover");
    })
  );
  videoFileDrop.addEventListener("drop", (e) => {
    const files = (e.dataTransfer && e.dataTransfer.files) || [];
    const file = [...files].find((f) => f.type.startsWith("video/"));
    if (file) loadLocalVideoFile(file);
    else setVideoStatus("Drop a video file.", "error");
  });
}

/* ── Export ── */
/* Render the trim range to an MP4 on the server.
 *
 * Shared by Export and Save. Save stores the *trimmed* clip rather than the
 * source: the source can be a 17-minute file far over Supabase's per-file
 * limit, while the clip is the part that was actually chosen — and it is what
 * gets published.
 */
async function renderTrimmedClip({ width, height, onStatus = () => {} } = {}) {
  const size = (width && height) ? { width, height } : videoTargetSize();
  const duration = state.trimEnd - state.trimStart;
  const overlay = await renderVideoOverlayPng(size.width, size.height);

  const form = new FormData();
  form.append("start", String(state.trimStart));
  form.append("end", String(state.trimEnd));
  form.append("width", String(size.width));
  form.append("height", String(size.height));
  form.append("mute", state.videoMuted ? "true" : "false");
  // ffmpeg must crop the same slice the preview showed, or the exported clip
  // is framed differently from what was approved on screen.
  form.append("focusX", String(state.videoFocus?.x ?? 0.5));
  form.append("focusY", String(state.videoFocus?.y ?? 0.5));
  if (overlay) form.append("overlay", overlay, "overlay.png");
  if (state.videoFile) {
    form.append("video", state.videoFile, state.videoFile.name);
    onStatus(`Uploading and encoding ${duration.toFixed(1)}s… this can take a few minutes.`);
  } else {
    /* Encode from whatever the PREVIEW is playing, not from the original link.
       trimStart/trimEnd are timestamps into the element on screen, so if that
       element is showing the already-trimmed copy from our bucket (a reopened
       post) while this sent the original URL, ffmpeg would cut those seconds
       out of the wrong footage — and fail outright when the original is a
       dead YouTube link or an expired signed URL. */
    const previewSrc = state.storedVideoUrl && videoPreviewEl?.src === state.storedVideoUrl
      ? state.storedVideoUrl
      : state.videoUrl;
    form.append("url", previewSrc);
    onStatus(`Downloading and encoding ${duration.toFixed(1)}s… this can take a few minutes.`);
  }

  // No AbortController timeout: a long download plus encode legitimately runs
  // for minutes, and aborting here would kill work the server is still doing
  // without telling it to stop.
  // No Content-Type header — the browser sets the multipart boundary.
  const res = await fetch("/api/video/clip", { method: "POST", body: form });
  if (!res.ok) throw new Error(await mediaErrorMessage(res));

  const blob = await res.blob();
  if (blob.size < 1000) throw new Error("The encoder returned an empty file.");
  return blob;
}

async function exportVideoClip() {
  if (state.videoExporting) return;
  const duration = state.trimEnd - state.trimStart;
  if (duration <= 0) { setVideoStatus("Set a trim range first.", "error"); return; }
  if (!state.videoUrl && !state.videoFile) { setVideoStatus("Load a video first.", "error"); return; }

  state.videoExporting = true;
  syncTrimUI();
  setExportWorking(true);
  setVideoStatus("Rendering overlay…");

  try {
    const { width, height } = videoTargetSize();
    /* The key and the page BEFORE the encode, not after.

       The encode runs for minutes and the trim sliders stay live throughout.
       Stamping the finished blob with a key computed on ARRIVAL filed old
       footage under the new range: the row recorded the new in/out points, the
       preview played them, and the stored and published mp4 was the old cut,
       with no error anywhere. resolvePublishClipFromState already reads its
       key before the await; this is the same discipline. */
    const clipKey = videoClipKey();
    const clipOwner = activePage();
    const blob = await renderTrimmedClip({ width, height, onStatus: setVideoStatus });

    const title = (state.videoMeta && state.videoMeta.title) || state.headline || "pix-clip";
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${slugify(title)}-slide2.mp4`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);

    setVideoStatus(`Exported ${(blob.size / 1048576).toFixed(1)} MB · ${width}×${height}`, "success");

    /* The encode is done and paid for; keep it so Save can store this exact
       clip without re-rendering it — filed against the page it was rendered
       for, so navigating away mid-export neither loses it nor hands it to a
       different video slide. */
    commitFieldToPage(clipOwner, "renderedClip", { blob, key: clipKey });
  } catch (err) {
    // A dropped connection surfaces as a bare "Failed to fetch", which tells
    // the user nothing — name the likely cause.
    const msg = /failed to fetch|networkerror|load failed/i.test(err.message || "")
      ? "Lost connection to the server during export. The clip may be too large — try a shorter range."
      : (err.message || "Export failed.");
    setVideoStatus(msg, "error");
  } finally {
    state.videoExporting = false;
    setExportWorking(false);
    syncTrimUI();
  }
}

if (videoExportBtn) videoExportBtn.addEventListener("click", exportVideoClip);

// The canvas preview reads frames straight off this element.
if (videoPreviewEl) {
  state.videoEl = videoPreviewEl;
  // Playback drives the rAF loop; everything else is a single repaint.
  // The video card is always visible in the rail, so these fire unconditionally.
  // They used to be gated on state.previewMode === "video", which is only true
  // transiently while that card is being painted — so in practice the guard was
  // always false and the card never updated on play or seek.
  videoPreviewEl.addEventListener("play", () => startVideoPreviewLoop());
  ["seeked", "loadeddata", "pause", "ended"].forEach((ev) =>
    videoPreviewEl.addEventListener(ev, () => {
      // Remember what is loaded, so a video page that later gives up the
      // shared player can reload the same source into its own. Loading a
      // clip is also how a page claims the player in the first place.
      state.videoSrc = videoPreviewEl.currentSrc || videoPreviewEl.getAttribute("src") || "";
      const current = activePage();
      if (current.type === "video") playerOwner = current;
      renderPoster();
    })
  );
}

syncTrimUI();

/* ── Per-card downloads ──
   Each preview card owns its own export. Previously one button exported
   "whatever mode the toggle happened to be in", which is how the X download
   once shipped the Text slide — the mode was ambient state rather than
   something the action declared. Here the button names its slide. */

async function exportSlidePng(mode, targetLongEdges = EXPORT_LONG_EDGES, encode = null) {
  const prev = {
    mode: state.previewMode,
    downloading: state.isDownloading,
    forceText: state.forceTextExport,
    shortly: state.useShortlyLogo,
    /* The caller's text slice belongs in the snapshot too. The restore-render
       in the finally takes renderPoster's full path, which ends every page by
       clearing _detailSlice — so the FIRST compression rung consumed it and
       every rung after it exported the whole paragraph instead of that page's
       slice. On a carousel with two Text pages that publishes both slides with
       identical, overflowing copy. */
    slice: state._detailSlice,
  };
  state.isDownloading = true;
  state.previewMode = mode;
  state.forceTextExport = mode === "text";
  state.useShortlyLogo = false;

  let result = null;
  try {
    result = await renderExportBlob(null, targetLongEdges, encode);
  } catch (err) {
    console.error(`${mode} export failed:`, err);
  } finally {
    state.isDownloading = prev.downloading;
    state.previewMode = prev.mode;
    state.forceTextExport = prev.forceText;
    state.useShortlyLogo = prev.shortly;
    renderPoster();
    /* AFTER the restore-render, not before: that render is itself what clears
       _detailSlice, so restoring first would simply be undone and the next
       compression rung would export the whole paragraph again. */
    state._detailSlice = prev.slice;
  }
  return result;
}

async function downloadSlide(mode) {
  const result = await exportSlidePng(mode);
  if (!result) return null;

  const suffix = mode === "pix" ? "" : `-${mode}`;
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(state.headline || "pix-post")}${suffix}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return result;
}

const previewRail = document.getElementById("preview-rail");
if (previewRail) {
  previewRail.addEventListener("click", async (e) => {
    // Removing a page must not also select it on the way out.
    const removeBtn = e.target.closest("[data-remove-page], [data-remove-card]");
    if (removeBtn) {
      const owner = removeBtn.closest("[data-page]");
      if (!owner) return;
      /* A spine card removes only itself; an added page removes the page.
         Both spine cards share one page, so removing the page would take the
         other card — and the post's content — with it. */
      if (owner.dataset.page === "base") {
        const card = cardForElement(owner);
        if (card) removeCard(card);
      } else {
        removePage(owner.dataset.page);
      }
      return;
    }

    // Clicking the header label (POSTER, TEXT, FOR X, number, etc.) opens the enlarged preview modal
    const anyCardEl = e.target.closest(".preview-card");
    const labelEl = e.target.closest(".preview-card-label");
    if (labelEl && anyCardEl) {
      if (anyCardEl.dataset.previewMode === "x" || anyCardEl.classList.contains("preview-card-pinned")) {
        const xCard = {
          el: anyCardEl,
          mode: "x",
          canvas: xPreviewCanvas || anyCardEl.querySelector("canvas"),
          page: basePage,
          detailSlice: null,
          sliceRange: null,
          isX: true,
        };
        openScreenPreviewModal(xCard);
        return;
      }
      const pageCard = cardForElement(anyCardEl);
      if (pageCard) {
        if (anyCardEl.dataset.page) setActivePage(anyCardEl.dataset.page);
        openScreenPreviewModal(pageCard);
        return;
      }
    }

    /* Selecting first is what makes the per-card exports correct: every
       export path reads live state, so the page has to be live before the
       render starts. Clicking Download on page 4 therefore selects page 4,
       which is also what the writer expects to see happen. */
    const cardEl = e.target.closest(".preview-card[data-page]");
    if (cardEl) setActivePage(cardEl.dataset.page);

    // "Edit" is the same selection, said out loud — the controls that write
    // to this page are in the left column, and on mobile behind the sheet.
    if (e.target.closest("[data-edit-page]")) {
      openEditorForPage(cardEl);
      return;
    }

    const btn = e.target.closest("[data-download]");
    if (!btn) return;
    const mode = btn.dataset.download;

    // X has its own export path: 2x scale (X rejects PNGs over 5 MB),
    // cropped to content, Shortly logo instead of Pix.
    if (mode === "x") {
      downloadXPreview();
      return;
    }

    // The video slide is an MP4 from the server, not a canvas PNG.
    if (mode === "video") {
      if (!state.videoUrl && !state.videoFile) {
        setStatus("Load a video into this page first — open the Video panel.", "error");
        return;
      }
      exportVideoClip();
      return;
    }

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Rendering…";
    // Export the slice this card shows, not the whole paragraph — the file
    // has to match the card it was downloaded from.
    const card = cardEl ? cardForElement(cardEl) : null;
    state._detailSlice = card?.detailSlice || null;
    try {
      const r = await downloadSlide(mode);
      setStatus(r ? `Page downloaded (${r.width}×${r.height}).` : "Export failed.", r ? "success" : "error");
    } finally {
      state._detailSlice = null;
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

/* Put the writer in front of the controls for the page they just picked.
   On mobile that means opening the sheet; on both, the section that
   matters for this page type. */
function openEditorForPage(cardEl) {
  const page = activePage();
  const openAccordion = (el) => {
    const acc = el?.closest(".acc");
    if (!acc || acc.dataset.open === "true") return;
    acc.dataset.open = "true";
    acc.querySelector(":scope > .acc-head")?.setAttribute("aria-expanded", "true");
  };

  if (isMobile()) setSheetOpen(true);

  const mode = cardEl?.dataset.previewMode;
  const focusTarget = page.type === "video" || mode === "video"
    ? videoFileDrop
    : (mode === "text" ? detailEdit : headlineEdit);

  openAccordion(focusTarget);
  requestAnimationFrame(() => {
    focusTarget?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (focusTarget && !focusTarget.disabled) focusTarget.focus({ preventScroll: true });
  });
}

/* ── Reordering ──
   Dragging the grip moves a page; every number, and the division of the
   paragraph's points, follows from the new order on the next paint.

   The grip is a button rather than the whole card for two reasons: the
   video card already claims pointer drags for reframing, and a focusable
   grip gives the whole feature a keyboard path (← →) that a drag cannot. */

function moveSlot(card, toIndex) {
  const from = slotOrder.indexOf(card);
  if (from < 0) return false;
  let to = Math.max(0, Math.min(toIndex, slotOrder.length));
  if (from < to) to -= 1;
  if (to === from) return false;
  slotOrder.splice(from, 1);
  slotOrder.splice(to, 0, card);
  renumberPages();
  return true;
}

(() => {
  const rail = document.getElementById("preview-rail");
  if (!rail) return;

  let dragging = null;

  // Cards are only draggable while their own grip is held, so a plain drag
  // across a card never starts a reorder.
  rail.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest("[data-grip]");
    const fig = grip?.closest(".preview-card[data-page]");
    if (fig) fig.draggable = true;
  });
  rail.addEventListener("pointerup", () => {
    if (!dragging) rail.querySelectorAll(".preview-card[draggable]").forEach((el) => { el.draggable = false; });
  });

  rail.addEventListener("dragstart", (e) => {
    const fig = e.target.closest(".preview-card[data-page]");
    if (!fig || !fig.draggable) { e.preventDefault(); return; }
    dragging = cardForElement(fig);
    if (!dragging) { e.preventDefault(); return; }
    fig.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    // Firefox refuses to start a drag without payload.
    e.dataTransfer.setData("text/plain", fig.dataset.page || "page");
  });

  rail.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const overEl = e.target.closest?.(".preview-card[data-page]");
    if (!overEl || overEl === dragging.el) return;
    const over = cardForElement(overEl);
    if (!over) return;
    const rect = overEl.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    moveSlot(dragging, slotOrder.indexOf(over) + (after ? 1 : 0));
  });

  rail.addEventListener("drop", (e) => { if (dragging) e.preventDefault(); });

  rail.addEventListener("dragend", () => {
    if (dragging) dragging.el.classList.remove("is-dragging");
    rail.querySelectorAll(".preview-card[draggable]").forEach((el) => { el.draggable = false; });
    dragging = null;
    // The order changed, so the points divide differently.
    recomputeDetailSlices({ force: true });
    renderPoster();
  });

  // Keyboard path: focus a grip, then arrow the page along the rail.
  rail.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const grip = e.target.closest("[data-grip]");
    const card = grip && cardForElement(grip.closest(".preview-card[data-page]"));
    if (!card) return;
    e.preventDefault();
    const at = slotOrder.indexOf(card);
    if (!moveSlot(card, e.key === "ArrowLeft" ? at - 1 : at + 2)) return;
    recomputeDetailSlices({ force: true });
    renderPoster();
    grip.focus();
    card.el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  });
})();

/* ── Add page ──
   A menu rather than three buttons: the tile sits in the rail at card
   width, and three labels do not fit there without shrinking to the point
   of being guesswork. */
(() => {
  const tile = document.getElementById("preview-add");
  const btn = document.getElementById("preview-add-btn");
  const menu = document.getElementById("preview-add-menu");
  if (!tile || !btn || !menu) return;

  const setMenuOpen = (open) => {
    menu.hidden = !open;
    // The tile swaps its face for the choices, so the open state lives on
    // the tile — it is what hides the button and widens the column.
    tile.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) menu.querySelector("[data-add-page]")?.focus();
  };
  const closeMenu = () => setMenuOpen(false);

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    /* A full rail used to make this button do nothing whatsoever — no menu,
       no message, no explanation — so a writer building a five-slide carousel
       clicked the plus and watched nothing happen, which reads as the editor
       being broken rather than as a limit being reached.

       The limit counts SLIDES, and the post's own Text slide is one of them.
       That is the part nobody can be expected to guess: a fresh post already
       holds two slides (the poster and the text page) before a single page is
       added, so only three can ever be added while both are in the rail. Say
       so, and say what to do about it. */
    if (!canAddPage()) {
      const hasTextSlide = spineCardsInRail().includes("text");
      setStatus(
        hasTextSlide
          ? `This post already has all ${MAX_PAGES} slides — the poster and the Text slide count towards them. Remove the Text slide to make room for another page.`
          : `This post already has all ${MAX_PAGES} slides. Remove one to add another.`,
        "error"
      );
      return;
    }
    setMenuOpen(menu.hidden);
  });

  menu.addEventListener("click", (e) => {
    if (e.target.closest("[data-add-cancel]")) {
      closeMenu();
      btn.focus();
      return;
    }
    const item = e.target.closest("[data-add-page]");
    if (!item) return;
    closeMenu();
    /* One video per post — the rule primaryVideoPage() and the publish path
       have always assumed, without anything enforcing it. A second Video page
       could be added, but every video operation resolves through the PRIMARY
       page: the publish loop shipped the first clip twice and never sent the
       second, and saving uploaded the first page's footage for both. Since
       DailyMattr's API is write-only, that duplicate is permanent. Refusing
       the second page is the honest reading of a model the rest of the code
       already relies on. */
    if (item.dataset.addPage === "video" && pages.some((p) => p.type === "video")) {
      setStatus("A post carries one video, so it has one Video page. Edit the one you have.", "error");
      return;
    }
    addPage(item.dataset.addPage);
  });

  document.addEventListener("click", (e) => {
    if (!menu.hidden && !tile.contains(e.target)) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
})();

// The way back when an added page is selected. Page 1 is where the post's
// own fields live, so this is also "stop editing an extra".
document.getElementById("page-context-back")?.addEventListener("click", () => {
  setActivePage("base");
  document.getElementById("post-canvas")
    ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
});

// First paint of the counter, the add tile and the selection ring.
renumberPages();

/* ═══ Screen Zoom Preview Modal ═══ */
function openScreenPreviewModal(card) {
  if (!card) return;
  currentModalCard = card;
  const modal = document.getElementById("screen-preview-modal");
  if (!modal) return;
  if (typeof modal.showModal === "function") {
    if (!modal.open) modal.showModal();
  } else {
    modal.setAttribute("open", "");
  }
  updateScreenPreviewModal();
}

function updateScreenPreviewModal() {
  if (!currentModalCard) return;
  const modal = document.getElementById("screen-preview-modal");
  if (!modal) return;

  const numEl = document.getElementById("screen-preview-modal-num");
  const typeEl = document.getElementById("screen-preview-modal-type");
  const modalCanvas = document.getElementById("screen-preview-modal-canvas");
  const canvasWrap = modal.querySelector(".screen-preview-canvas-wrap");
  const headerEl = modal.querySelector(".screen-preview-modal-header");

  const num = cardNumber(currentModalCard);
  const label = cardLabel(currentModalCard).toUpperCase();
  const ratio = state.aspectRatio || "9:16";
  if (numEl) numEl.textContent = num;
  if (typeEl) typeEl.textContent = `${label} · ${ratio}`;

  const srcCanvas = currentModalCard.canvas;
  if (srcCanvas && modalCanvas) {
    modalCanvas.width = srcCanvas.width;
    modalCanvas.height = srcCanvas.height;

    const ratioStr = `${srcCanvas.width} / ${srcCanvas.height}`;
    if (canvasWrap) {
      canvasWrap.style.aspectRatio = ratioStr;
    }
    modalCanvas.style.aspectRatio = ratioStr;

    const mCtx = modalCanvas.getContext("2d");
    mCtx.clearRect(0, 0, modalCanvas.width, modalCanvas.height);
    mCtx.drawImage(srcCanvas, 0, 0);

    requestAnimationFrame(() => {
      const rect = modalCanvas.getBoundingClientRect();
      if (rect.width && headerEl) {
        headerEl.style.maxWidth = `${Math.max(rect.width, 360)}px`;
      }
    });
  }
}

function closeScreenPreviewModal() {
  const modal = document.getElementById("screen-preview-modal");
  if (!modal) return;
  if (typeof modal.close === "function" && modal.open) {
    modal.close();
  } else {
    modal.removeAttribute("open");
  }
  currentModalCard = null;
}

function stepModalCard(delta) {
  if (!currentModalCard) return;
  const allCards = [...slotOrder];
  const xFig = document.querySelector('.preview-card[data-preview-mode="x"]');
  if (xFig && xPreviewCanvas) {
    allCards.push({
      el: xFig,
      mode: "x",
      canvas: xPreviewCanvas,
      page: basePage,
      detailSlice: null,
      sliceRange: null,
      isX: true,
    });
  }
  if (!allCards.length) return;
  let idx = allCards.findIndex((c) => c.canvas === currentModalCard?.canvas || (c.isX && currentModalCard?.isX));
  if (idx < 0) idx = 0;
  const nextIdx = (idx + delta + allCards.length) % allCards.length;
  currentModalCard = allCards[nextIdx];
  if (currentModalCard?.el?.dataset?.page) {
    setActivePage(currentModalCard.page?.id || currentModalCard.el.dataset.page);
  }
  updateScreenPreviewModal();
}

(() => {
  const modal = document.getElementById("screen-preview-modal");
  const closeBtn = document.getElementById("screen-preview-modal-close");
  const prevBtn = document.getElementById("screen-preview-prev-btn");
  const nextBtn = document.getElementById("screen-preview-next-btn");
  const dlBtn = document.getElementById("screen-preview-download-btn");

  closeBtn?.addEventListener("click", () => closeScreenPreviewModal());
  prevBtn?.addEventListener("click", () => stepModalCard(-1));
  nextBtn?.addEventListener("click", () => stepModalCard(1));

  dlBtn?.addEventListener("click", async () => {
    if (!currentModalCard) return;
    const mode = currentModalCard.mode;
    if (mode === "x") {
      downloadXPreview();
    } else if (mode === "video") {
      if (!state.videoUrl && !state.videoFile) {
        setStatus("Load a video into this page first — open the Video panel.", "error");
        return;
      }
      exportVideoClip();
    } else {
      state._detailSlice = currentModalCard.detailSlice || null;
      try {
        const r = await downloadSlide(mode);
        setStatus(r ? `Page downloaded (${r.width}×${r.height}).` : "Export failed.", r ? "success" : "error");
      } finally {
        state._detailSlice = null;
      }
    }
  });

  // Clicking the dark backdrop closes the modal
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeScreenPreviewModal();
  });

  document.addEventListener("keydown", (e) => {
    if (!modal || (!modal.open && !modal.hasAttribute("open"))) return;
    if (e.key === "Escape") {
      closeScreenPreviewModal();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      stepModalCard(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      stepModalCard(1);
    }
  });
})();


/* ── Rail navigation ──
   Arrows page the carousel by one card. They hide themselves when everything
   already fits, so on a wide screen the header stays clean instead of
   carrying two controls that do nothing. */
async function loadDailyMattrMeta({ force = false } = {}) {
  if (!state.user) {
    fillSelectOptions(dailymattrCategory, [], "Sign in to load categories");
    fillSelectOptions(dailymattrState, [], "Optional");
    dailymattrMetaLoaded = false;
    return;
  }
  if (dailymattrMetaLoaded && !force) return;

  setDailyMattrStatus("Loading DailyMattr categories…");
  try {
    const response = await fetch(DAILYMATTR_META_ENDPOINT, { credentials: "same-origin" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) return handleSignedOut();
      setDailyMattrStatus(payload.error || `Could not load DailyMattr (${response.status}).`, "error");
      return;
    }
    if (!payload.configured) {
      fillSelectOptions(dailymattrCategory, [], "DailyMattr not configured");
      fillSelectOptions(dailymattrState, [], "Optional");
      setDailyMattrStatus(
        payload.missing?.length
          ? `Server setup missing: ${payload.missing.join(", ")}`
          : "DailyMattr is not configured on this server.",
        "error",
      );
      return;
    }

    fillSelectOptions(dailymattrCategory, payload.categories || [], "Choose a category");
    fillSelectOptions(dailymattrState, payload.states || [], "Optional");
    // Options exist now, so the saved choice can actually take.
    syncSectionInputs();
    dailymattrMetaLoaded = true;
    syncDailyMattrDraft();
    setDailyMattrStatus(`DailyMattr ready. ${payload.categories?.length || 0} categories loaded.`, "success");
  } catch (err) {
    setDailyMattrStatus(err.message || "Could not load DailyMattr options.", "error");
  }
}

/* ── Is this post publishable at all? ──

   Set when a publish attempt ended without an answer — the server kept its
   claim on the row and a retry would be refused, but this session should not
   even offer the button. Session-scoped on purpose: it describes what just
   happened in this tab, whereas state.publishedAt describes the row, and a
   reload correctly re-reads the row rather than remembering the scare. */
let publishOutcomeUnknown = false;

/* One place decides whether Publish is available and what it says, because
   three things can close it and they used to be checked nowhere:

     - the row is already live on DailyMattr (their API has no delete, so a
       second publish is a permanent duplicate)
     - a previous attempt's outcome is unknown, so the post may be live
     - the row is rejected, and publishing it would erase the rejection

   Called on load, on role change, and after every publish attempt. The server
   refuses all three as well and is the guard that actually counts; this is
   here so QA finds out BEFORE a multi-minute encode and upload, and so the
   button stops reading "Publish" on a story that is already out.

   `announce` writes the reason to the status line, and defaults OFF because
   most callers run at moments where that would be noise or worse: the finally
   below runs immediately after a SUCCESSFUL publish, where the row is now
   published and re-announcing it as an error would paint over the "Published,
   ID 1379, marked approved" line QA needs to read. Opening a post is the one
   moment the line is empty and the standing is news. */
/* The ids of copies this post has already put on the public site and then
   superseded, oldest first. Not the current one — that is state.publishedId —
   because the two call for different things: the current copy is the story, the
   superseded ones are litter that has to be deleted by hand. */
function supersededPublishedIds() {
  const history = Array.isArray(state.publishedHistory) ? state.publishedHistory : [];
  return history.map((entry) => (entry && entry.id != null ? String(entry.id) : "")).filter(Boolean);
}

function syncPublishState({ announce = false } = {}) {
  if (!dailymattrPublishBtn) return;

  let reason = "";
  let short = "";
  /* A published post with a known ID is not shut — it is the CORRECTION case.
     It used to be blocked here, which made the whole republish path dead code:
     publishToDailyMattr() opens a "Publish a corrected copy?" confirm for
     exactly this state and the server accepts `republish` for it, but neither
     could ever be reached because this function disabled the only button that
     calls them (and the topbar proxy refuses a disabled target). A typo in a
     live story was therefore permanent, which is the opposite of what the
     guard was for: it exists to stop an ACCIDENTAL second send — a reload, a
     stray click, a retry after a timeout — and that job is done by the confirm
     dialog, which names the live ID and says the old copy stays up. So the
     button stays live and says what pressing it will do. */
  let correction = false;
  /* Not gated on state.pixId. An unsaved poster has no library row to claim,
     so the server cannot guard it — but this session knows perfectly well that
     it just sent one, and refusing a second click here is the only thing
     standing between QA and two identical live stories. */
  if (state.publishedAt && state.publishedId && !publishOutcomeUnknown) {
    correction = true;
    short = "Republish";
    const older = supersededPublishedIds();
    reason = `Already live as ID ${state.publishedId}. Publishing again sends a CORRECTED COPY as a new entry — the existing one stays up until you delete it in the DailyMattr portal.`
      /* Named, not counted. Somebody has to go and delete these, and a bare
         "2 earlier copies" sends them hunting through the portal for ids the
         app already knows. */
      + (older.length
          ? ` Earlier ${older.length === 1 ? "copy" : "copies"} still on the site unless already removed: ${older.join(", ")}.`
          : "");
  } else if (state.publishedAt || publishOutcomeUnknown) {
    /* Sent, never confirmed. Deliberately shut rather than merely warned: the
       one thing nobody can do from here is find out, and the retry that feels
       harmless is the one that duplicates a live story. */
    short = "Outcome unknown";
    reason = "A publish of this post was sent and no confirmation came back, so it may already be live. Check the DailyMattr portal before publishing again.";
  } else if (state.pixId && state.rejected) {
    short = "Rejected";
    reason = `Rejected by ${state.rejectedByName || "a reviewer"}. Withdraw the rejection in Review ("Undo reject") before publishing.`;
  }

  const blocked = Boolean(reason) && !correction;
  dailymattrPublishBtn.disabled = blocked;
  dailymattrPublishBtn.textContent = blocked
    ? `${short} — cannot publish`
    : (correction ? "Republish a corrected copy" : "Publish to DailyMattr");
  dailymattrPublishBtn.title = reason;

  /* The topbar button proxies this one. The 500ms mirror copies disabled and
     hidden but not the label, and syncPrimaryAction owns "Publish"/"Submit" —
     so the label is set here for the reviewer case only, leaving a writer's
     "Submit" (which drives Save, not this button) alone. */
  const primary = document.querySelector('.cms-topbar-actions .btn-primary');
  if (primary && primary.dataset.proxy === "dailymattr-publish-btn") {
    primary.textContent = blocked ? short : (correction ? "Republish" : "Publish");
    primary.title = reason || "Publish this pix to the web app";
  }

  /* Say why the button is shut. A disabled control with no explanation reads
     as a broken page, and this one is shut for a reason QA has to act on.

     The correction case is not an error — the button still works — so it is
     announced without the error styling, or opening a published post would
     paint a red line over a post that is doing nothing wrong. */
  if (announce && reason) setDailyMattrStatus(reason, correction ? "" : "error");
}

/* Get the slide-2 MP4 for publishing, by the cheapest route that is still
   correct.

   The bug this replaces: publish always called renderTrimmedClip(), which
   re-encodes from state.videoUrl — the ORIGINAL source. On a reopened post
   that URL is a YouTube link or an expiring signed URL, while the preview the
   writer approved is playing the trimmed copy in our own bucket. So the
   preview and the export were reading from two different places, and the
   export lost: dead link, expired signature, or yt-dlp needed all over again.
   The visible symptom is a post that publishes its images and silently drops
   the video.

   Order of preference:
     1. the clip already rendered in this session
     2. the trimmed copy in our bucket, when nothing has been edited since
     3. a fresh encode — only when there is genuinely nothing to reuse

   videoClipKey() covers trim range, mute, focus, caption and ratio, so any
   edit invalidates 1 and 2 and correctly forces a re-render. */
function resolvePublishClip(onStatus = () => {}) {
  // The clip lives on a video page, so read it from there rather than from
  // whichever page QA left selected.
  return withPrimaryVideo(() => resolvePublishClipFromState(onStatus));
}

async function resolvePublishClipFromState(onStatus = () => {}) {
  const clipKey = videoClipKey();
  if (!clipKey) return null;

  if (state.renderedClip?.key === clipKey && state.renderedClip.blob) {
    return state.renderedClip.blob;
  }

  if (state.storedVideoUrl && state.storedVideoFor === clipKey) {
    try {
      onStatus("Attaching the stored video…");
      const res = await fetch(state.storedVideoUrl);
      if (res.ok) {
        const blob = await res.blob();
        if (blob.size > 1000) return blob;
      }
      // Fall through to a fresh encode rather than failing — the bucket object
      // could have been pruned.
      console.warn("stored clip unreadable, re-encoding");
    } catch (err) {
      console.warn("stored clip fetch failed, re-encoding:", err.message);
    }
  }

  const videoReady = state.videoEl
    && state.videoEl.readyState >= 2
    && state.videoEl.videoWidth > 0
    && state.trimEnd > state.trimStart;
  if (!videoReady) return null;

  onStatus("Rendering the video — this can take a few minutes…");
  const blob = await renderTrimmedClip({ onStatus });
  if (blob) state.renderedClip = { blob, key: clipKey };
  return blob;
}

/* Assembly moves the SELECTION from page to page and waits on a multi-second
   PNG encode at each stop (see the loop below). For those seconds live state
   belongs to whichever page is being exported, and the idle poller has no way
   to tell that from a person editing — so publishing a post with a second
   Poster page could write that page's headline, tag and image into the post's
   own columns, permanently if QA closed the tab on the "Published" dialog.
   Publishing owns the row while it runs. */
let publishInFlight = false;

/* Returns true only when DailyMattr accepted the post; every other path falls
   out as undefined. Approve & Publish reads that, because it hands control back
   to the Review list where the publish panel's own status line is off screen.

   `skipConfirm` is for callers that have already shown their own confirmation —
   not a way to publish without one. */
async function publishToDailyMattr({ skipConfirm = false } = {}) {
  /* Local, not module-scoped. It describes one press — set by the republish
     confirm, read when the form is built — and as a module variable every
     early return between those two points (a missing category, an unloaded
     meta list, a media validation refusal) leaked it into the next press,
     because only the finally cleared it and none of those returns reach one.
     A leaked `true` is the worst possible value to leak: it is the field that
     lifts the already-published guard, so the following ordinary publish would
     have gone out unguarded. Scoped to the call, that cannot happen. */
  let republishRequested = false;
  if (!state.user) {
    setDailyMattrStatus("Sign in to publish.", "error");
    return;
  }
  if (!state.headline.trim()) {
    setDailyMattrStatus("Build a poster first.", "error");
    return;
  }
  /* The states that make publishing wrong rather than merely unnecessary.
     syncPublishState() has already disabled the button for each of them, so
     this is the belt to that braces — the button can be re-enabled by the
     proxy mirror, a stale render or a keyboard activation, and the cost of
     getting through is a permanent duplicate on a public site. The server
     refuses them as well; this exists so QA is told before the encode rather
     than after it.

     The walls come FIRST, before the republish confirm below. A post can be
     both published and rejected — QA can reject one it already sent — and
     asked in the other order that post got the "publish a corrected copy?"
     dialog, was answered yes, and was then refused anyway by the rejection
     wall. A confirmation collected for an action that cannot happen is how
     people learn to click through them. */
  if (publishOutcomeUnknown) {
    setDailyMattrStatus(
      "The last publish was sent and no confirmation came back — this post may already be live. Check the DailyMattr portal before publishing again.",
      "error",
    );
    return;
  }
  if (state.pixId && state.rejected) {
    setDailyMattrStatus(
      `This post was rejected by ${state.rejectedByName || "a reviewer"}. Withdraw the rejection in Review ("Undo reject") before publishing — publishing it would erase who turned it down and when.`,
      "error",
    );
    return;
  }
  if (state.publishedAt) {
    /* Two different situations, and only one of them can be offered a way
       forward.

       KNOWN live (we hold an id): a correction has nowhere else to go, since
       DailyMattr cannot edit an entry. So this is a real choice — send the
       edited version as a NEW entry — rather than a wall. It is a confirm,
       not a notice, and the wording has to be blunt: republishing does not
       replace anything. The old story stays up until somebody removes it in
       their portal by hand, and the dialog names the id to remove.

       UNKNOWN (a publish was started and never confirmed): still a wall. We
       cannot say whether the first attempt is live, so "publish another copy"
       might mean one copy or two, and nobody can tell which afterwards. Their
       portal is the only place that knows. */
    if (!state.publishedId) {
      const message = "A publish of this post was started and never confirmed, so it may already be live. Check the DailyMattr portal before publishing again.";
      setDailyMattrStatus(message, "error");
      confirmAction({
        notice: true,
        title: "Publish outcome unknown",
        body: message,
        facts: ["No DailyMattr ID was recorded for that attempt — only their portal can say whether the story exists."],
        confirmLabel: "Close",
      });
      return;
    }

    const goAgain = await confirmAction({
      title: "Publish a corrected copy?",
      body: `This story is already live as ID ${state.publishedId}. DailyMattr cannot edit an entry, so the corrected version goes up as a SEPARATE new post with its own ID.`,
      facts: [
        `The existing copy (ID ${state.publishedId}) stays live until you delete it in the DailyMattr portal.`,
        "Both versions will be on the site until you do.",
        /* The old line promised the ids were "kept, so you can find the old
           ones" without ever showing them — they were in published_history and
           readable nowhere. Listed here instead, because this dialog is the
           moment the list grows by one. */
        supersededPublishedIds().length
          ? `Already superseded, and still up unless removed: ${supersededPublishedIds().join(", ")}.`
          : "Every ID this post produces is kept, so the older ones stay findable.",
      ],
      confirmLabel: "Publish as new",
      danger: true,
    });
    if (!goAgain) {
      setDailyMattrStatus("Not republished — the live copy is unchanged.", "");
      return;
    }
    republishRequested = true;
  }
  if (!dailymattrMetaLoaded) {
    await loadDailyMattrMeta({ force: true });
    if (!dailymattrMetaLoaded) return;
  }

  const categoryId = dailymattrCategory?.value || "";
  const stateId = dailymattrState?.value || "";
  const content = (dailymattrContent?.value || "").trim() || defaultDailyMattrContent();
  /* Priority: what QA typed here, then what the writer saved with the post,
     then a guess from the headline. The writer's wording used to be discarded
     — keywords were only ever inferred at publish time — so a deliberate
     choice lost to an automatic one. */
  const keywords = (dailymattrKeywords?.value || "").trim()
    || (state.keywords || "").trim()
    || inferDailyMattrKeywords();
  const mediaError = validateDailyMattrExtraFiles();
  if (!categoryId) {
    setDailyMattrStatus("Choose a DailyMattr category.", "error");
    return;
  }
  if (!content) {
    setDailyMattrStatus("Enter a caption before publishing.", "error");
    return;
  }
  if (mediaError) {
    setDailyMattrStatus(mediaError, "error");
    return;
  }
  /* Same idea for the clip length. MAX_CLIP_SECONDS was enforced in exactly
     two places: the Export button, which greys out with no explanation, and
     the server — AFTER the entire several-hundred-megabyte upload had been
     received. So a writer who dragged the end handle past the limit watched
     every slide render and the whole file upload, and only then read "Clip is
     200s; the limit is 90s." Checked here it costs a click. */
  const clipForLimit = primaryVideoContent();
  const clipSeconds = (clipForLimit.trimEnd ?? 0) - (clipForLimit.trimStart ?? 0);
  if (clipSeconds > MAX_CLIP_SECONDS) {
    setDailyMattrStatus(
      `The video is ${clipSeconds.toFixed(0)}s and the limit is ${MAX_CLIP_SECONDS}s. Shorten the trim range on the Video page, then publish.`,
      "error",
    );
    return;
  }

  /* DailyMattr rejects the State category without a state. Caught here so the
     failure costs a click, not a multi-minute video encode and upload first. */
  if (stateIsRequired(categoryId) && !stateId) {
    setDailyMattrStatus("The State category needs a state. Choose one above, then publish.", "error");
    dailymattrState?.focus();
    return;
  }

  /* The one genuinely irreversible action in the app: DailyMattr has no
     delete route on the integration API, so a mistaken publish has to be
     removed by hand from their portal. Worth one click to confirm, and worth
     showing exactly what is about to go. */
  const catLabel = dailymattrCategory?.selectedOptions?.[0]?.textContent || "none";
  const stLabel = dailymattrState?.value ? (dailymattrState.selectedOptions?.[0]?.textContent || "") : "";
  /* Read the clip off the video page, not off live state: the video moved
     onto its own page, so `state.video*` only holds it while that page is
     the selected one — and QA confirms this dialog from page 1. */
  const clip = primaryVideoContent();
  /* Mirror videoClipKey()'s own gate — a source AND a real trim range — rather
     than accepting a stored URL on its own. The two predicates used to
     disagree: the dialog said "including the video" whenever storedVideoUrl
     was set, while the assembly needs trimEnd > trimStart, which on a
     just-reopened post is not true until the <video> fires loadedmetadata.
     QA confirmed a count the publish could not deliver. The assembly now
     aborts instead of skipping (see the loop below), so a disagreement is
     loud either way — but it should not arise in the first place. */
  const hasVideo = Boolean(
    (clip.storedVideoUrl || clip.videoUrl || clip.videoFile)
    && clip.trimEnd > clip.trimStart
  );
  const extraCount = dailyMattrExtraFiles().length;
  /* Count the same way the assembly does — every card in the rail plus the
     attached files — or the dialog promises a number the publish will not
     deliver. It previously counted a fixed poster+text+clip, which silently
     under-reported the moment a third page existed. */
  const railCount = slotOrder.filter((card) => card.mode !== "video" || hasVideo).length;
  const mediaCount = railCount + extraCount;

  /* Approve & Publish has already shown this same warning and collected the
     category, so a second identical dialog would only train QA to click
     through it. This skips the duplicate, never the confirmation. */
  /* `republishRequested` counts as a confirmation. The republish dialog above
     is the stronger of the two — it names the live ID, says the old copy stays
     up, and its button reads "Publish as new" — so following it with the
     generic "Publish to DailyMattr?" would ask a weaker version of a question
     just answered, and a second dialog is exactly where people stop reading. */
  const go = (skipConfirm || republishRequested) ? true : await confirmAction({
    title: "Publish to DailyMattr?",
    body: "This goes live on shortlyindia.com straight away. It cannot be undone from here — a mistake has to be removed from their portal by hand.",
    facts: [
      `Category: ${catLabel}${stLabel ? ` \u00b7 ${stLabel}` : ""}`,
      `${mediaCount} media item${mediaCount === 1 ? "" : "s"}${hasVideo ? ", including the video" : ""}`,
      state.pixId ? "The post will be marked approved" : "Not saved yet, so it will not be marked approved",
    ],
    confirmLabel: "Publish now",
  });
  if (!go) return;

  /* Claimed before anything else, and cleared in the finally that also
     re-enables the button: every early return in the body below is inside
     that try, so there is no path out of here that leaves it set. Disabling
     dailymattrPublishBtn is not enough on its own — considerAutosave() only
     stands down for savePixBtn, which publishing never touches. */
  publishInFlight = true;
  dailymattrPublishBtn.disabled = true;
  dailymattrPublishBtn.textContent = "Publishing…";
  setDailyMattrStatus("Rendering slide images…");
  /* Divides the catch below into "nothing left the browser" and "we do not
     know". Everything up to the fetch — rendering, encoding, assembling the
     form — is local, so a throw there is provably harmless; after it, it is
     not. */
  let publishRequestSent = false;

  try {

    const form = new FormData();
    form.append("content_en", content);
    form.append("category_id", categoryId);
    if (keywords) form.append("keywords", keywords);
    if (stateId) form.append("state_id", stateId);
    if (state.sourceUrl) form.append("source_url", state.sourceUrl);
    // Lets the server mark this post approved once DailyMattr accepts it —
    // sending a story live IS the approval. Absent when the poster was never
    // saved, in which case there is no library row to mark.
    if (state.pixId) form.append("pix_id", state.pixId);
    /* Sent only when QA has just answered the republish dialog, and cleared
       the moment this attempt ends — a flag that outlived its confirmation
       would turn the next ordinary publish into an unguarded one. */
    if (republishRequested) form.append("republish", "true");
    /* Publish every page in the rail, in the order the reader will swipe
       them — not a fixed poster-plus-text pair.

       This used to export exactly one "pix" card and one "text" card. Once
       pages became addable (up to five, of any type) that quietly dropped
       everything past the first two: a writer could build a four-page story,
       press publish, and have pages three and four vanish with no warning.
       The confirmation dialog counted the same way, so it did not warn
       either — it under-reported and the mismatch was invisible.

       Each card is exported from ITS page. setActivePage swaps the page's
       content into live state (headline, tag, filters, framing) and
       syncActivePageContent folds the current one back first, so a second
       poster page exports its own headline rather than page one's. The
       original selection is restored in the finally, whatever happens.

       The "For X" card stays out of this: it is a Twitter/X crop with its own
       framing, and on the news app it would read as a duplicate of the poster
       in the wrong aspect. It is not in slotOrder, so it is excluded by
       construction rather than by a filter someone has to remember. */
    const slug = slugify(state.headline || "pix-post");
    const outboundMedia = [];
    const restorePageId = activePageId;
    try {
      for (const card of slotOrder) {
        const n = outboundMedia.length + 1;
        setActivePage(card.el?.dataset?.page || "base", { force: true });

        if (card.mode === "video") {
          setDailyMattrStatus(`Preparing page ${n} (video)…`);
          const clip = await resolvePublishClip((msg) => setDailyMattrStatus(msg));
          /* Abort, do not skip. This was `continue`, and it was the only
             failure in this loop that did not stop the publish — the oversize
             branch just below and the failed-PNG branch further down both
             return. So a post whose clip could not be prepared went live with
             its images only, after a dialog that had just told QA the video
             was included, and the success dialog reported nothing missing.
             DailyMattr's API is write-only, so there is no adding it
             afterwards: the story is permanently a partial.

             Both surviving causes are invisible to QA and both are ordinary.
             The clip key is null until the reopened <video> fires
             loadedmetadata (state.trimEnd is 0 until then), and a stored clip
             whose bucket URL has expired or 404s never fires it at all — so
             that second one silently drops the video on EVERY publish of that
             post. Neither is a reason to ship a partial story. */
          if (!clip) {
            const message = `Page ${n}'s video could not be prepared, so nothing was published. Open the Video page, wait for the clip to load, and try again — if it never loads, its stored copy is gone and the video must be re-added.`;
            setDailyMattrStatus(message, "error");
            confirmAction({
              notice: true,
              title: "Not published",
              body: message,
              facts: ["Nothing was sent — the post is unchanged and still publishable."],
              confirmLabel: "Close",
            });
            return;
          }
          if (clip.size > DAILYMATTR_MAX_MEDIA_BYTES) {
            const mb = (v) => (v / 1048576).toFixed(1);
            setDailyMattrStatus(
              `Page ${n}'s clip is ${mb(clip.size)} MB, over the ${mb(DAILYMATTR_MAX_MEDIA_BYTES)} MB limit. Shorten the trim range and try again.`,
              "error",
            );
            return;
          }
          outboundMedia.push({ blob: clip, filename: `${slug}-p${n}.mp4` });
          continue;
        }

        // A text card shows one slice of the paragraph; export the slice that
        // card displays, or the file will not match what is on screen.
        setDailyMattrStatus(`Rendering page ${n}…`);
        state._detailSlice = card.detailSlice || null;
        let shot = null;
        try {
          shot = await exportSlideForPublish(card.mode);
        } finally {
          state._detailSlice = null;
        }
        if (!shot?.blob) {
          setDailyMattrStatus(`Could not render page ${n}.`, "error");
          return;
        }
        // Extension follows the encoder — a JPEG named .png is refused by a
        // validator that checks the two against each other.
        outboundMedia.push({
          blob: shot.blob,
          filename: `${slug}-p${n}${shot.blob.type === "image/jpeg" ? ".jpg" : ".png"}`,
        });
      }
    } finally {
      setActivePage(restorePageId, { force: true });
    }

    if (!outboundMedia.length) {
      setDailyMattrStatus("There is nothing to publish yet — build at least one page.", "error");
      return;
    }

    for (const { file } of dailyMattrExtraFiles()) {
      const squeezed = await compressAttachedImage(file);
      if (squeezed !== file) {
        setDailyMattrStatus(
          `Compressed ${file.name} from ${mbLabel(file.size)} to ${mbLabel(squeezed.size)}…`,
        );
      }
      outboundMedia.push({ blob: squeezed, filename: squeezed.name || file.name });
    }
    if (outboundMedia.length > DAILYMATTR_MAX_MEDIA_ITEMS) {
      setDailyMattrStatus(
        `This post has ${outboundMedia.length} media files and DailyMattr accepts ${DAILYMATTR_MAX_MEDIA_ITEMS}. Remove one and try again.`,
        "error",
      );
      return;
    }
    /* The whole-post weight, checked before anything leaves the browser.

       DailyMattr's refusal for an oversized post is "Validation Error" and
       nothing else — no field, no size, no limit — so left to them this fails
       with the one message QA cannot act on. Checked here it fails with the
       numbers, and only after compression has already had its go, so this
       fires for a genuinely huge post rather than for a normal one. */
    const isVideoItem = (m) => String(m.blob?.type || "").startsWith("video/");
    const totalBytes = outboundMedia.reduce((sum, m) => sum + (m.blob?.size || 0), 0);
    const videoBytes = outboundMedia.filter(isVideoItem)
      .reduce((sum, m) => sum + (m.blob?.size || 0), 0);
    const slideBytes = totalBytes - videoBytes;

    const heaviest = (items) => [...items]
      .sort((a, b) => (b.blob?.size || 0) - (a.blob?.size || 0))
      .slice(0, 3)
      .map((m, i) => `${i + 1}. ${m.filename} — ${mbLabel(m.blob.size)}`);

    /* The pictures, which we render and can compress. Video is excluded on
       purpose — see the two constants. */
    if (slideBytes > DAILYMATTR_SLIDES_BUDGET_BYTES) {
      const message = `The pictures in this post come to ${mbLabel(slideBytes)}, over the ${mbLabel(DAILYMATTR_SLIDES_BUDGET_BYTES)} limit.`;
      setDailyMattrStatus(message, "error");
      confirmAction({
        notice: true,
        title: "Too large to publish",
        body: message,
        facts: [
          "Nothing was sent — the post is unchanged.",
          "The heaviest items:",
          ...heaviest(outboundMedia.filter((m) => !isVideoItem(m))),
          "Remove a slide, or replace the heaviest picture with a smaller one.",
        ],
        confirmLabel: "Close",
      });
      return;
    }

    /* The whole upload. Only a very long clip can reach this, and the remedy
       is a shorter trim — not "replace a picture", which is what this used to
       tell people holding a perfectly ordinary video. */
    if (totalBytes > DAILYMATTR_TOTAL_CEILING_BYTES) {
      const message = `This post is ${mbLabel(totalBytes)} of media, over the ${mbLabel(DAILYMATTR_TOTAL_CEILING_BYTES)} limit.`;
      setDailyMattrStatus(message, "error");
      confirmAction({
        notice: true,
        title: "Too large to publish",
        body: message,
        facts: [
          "Nothing was sent — the post is unchanged.",
          "The heaviest items:",
          ...heaviest(outboundMedia),
          videoBytes
            ? `The video accounts for ${mbLabel(videoBytes)} — shorten its trim range on the Video page.`
            : "Remove a slide, or replace the heaviest picture with a smaller one.",
        ],
        confirmLabel: "Close",
      });
      return;
    }
    console.info(
      `[pix] publishing ${outboundMedia.length} media, ${mbLabel(totalBytes)} total` +
      (videoBytes ? ` (${mbLabel(videoBytes)} video)` : ""),
    );

    // Numbered by position, so the pages are always 1..N with no gaps no
    // matter which of the optional items are present.
    outboundMedia.forEach(({ blob, filename }, index) => {
      form.append(`media_page_${index + 1}`, blob, filename);
    });

    setDailyMattrStatus("Sending to DailyMattr…");
    /* From here on the request is in the air. If anything below throws — an
       aborted fetch, a dropped connection, the tab going offline mid-upload —
       the server may already have forwarded the whole thing to DailyMattr, so
       the catch must not report it as a clean failure. */
    publishRequestSent = true;
    const response = await fetch(DAILYMATTR_PUBLISH_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) return handleSignedOut();
      setDailyMattrStatus(payload.error || `Publish failed (${response.status}).`, "error");

      /* Two very different failures used to read identically. The dialog said
         "Nothing was sent — fix the problem and publish again" for every
         non-200, including the case where DailyMattr had accepted the post and
         only the answer went missing. QA did as instructed and the story went
         live twice, permanently — their API has no delete.

         The server now says which it was. `indeterminate` means the request
         left it and no usable answer came back; nobody, on either side, can
         tell whether the story exists. The only correct instruction is to go
         and look, so this never invites a retry and the button stays shut for
         the rest of the session. */
      if (payload.indeterminate) {
        publishOutcomeUnknown = true;
        confirmAction({
          notice: true,
          title: "Publish outcome unknown",
          body: payload.error
            || "The post was sent to DailyMattr and no confirmation came back, so it may already be live.",
          facts: [
            "Do NOT publish again yet — a second attempt would create a second live story that cannot be deleted.",
            "Open the DailyMattr portal and check whether this story is there.",
            "If it is not there, reload this page and publish once more.",
          ],
          confirmLabel: "Close",
        });
        return;
      }

      /* Already published, or rejected: the server refused before sending
         anything. Adopt what it told us about the row so the button and the
         status line stop offering an action that cannot succeed — the client's
         copy is stale precisely because someone else changed the row. */
      if (payload.alreadyPublished) {
        state.publishedAt = payload.publishedAt || new Date().toISOString();
        state.publishedId = payload.publishedId || null;
      }
      if (payload.rejected) {
        state.rejected = true;
        state.rejectedByName = payload.rejectedByName || state.rejectedByName;
      }

      /* A failure needs the dialog more than a success does: the post is NOT
         live, and a red line at the foot of the column is exactly the thing
         someone scrolls past before assuming it went out. */
      /* What was actually wrong, one line per field, above the generic
         reassurance. This dialog used to carry a single sentence and the fact
         "Nothing was sent — fix the problem and publish again", which told QA
         to fix something the dialog had never named: the per-field refusals
         from DailyMattr were parsed away long before they reached here, so a
         carousel rejected over one bad slide read exactly like a carousel
         rejected for any other reason. */
      const refusals = Array.isArray(payload.details) ? payload.details.filter(Boolean) : [];
      confirmAction({
        notice: true,
        title: payload.alreadyPublished ? "Already published" : "Not published",
        body: (refusals.length ? payload.summary : "")
          || payload.error
          || `DailyMattr refused the post (HTTP ${response.status}).`,
        facts: [
          ...(refusals.length ? ["DailyMattr refused it because:", ...refusals] : []),
          payload.alreadyPublished || payload.rejected
            ? "Nothing was sent this time."
            : "Nothing was sent — the post is unchanged and still publishable.",
        ],
        confirmLabel: "Close",
      });
      return;
    }

    const publishedId = payload.publishedId ? ` ID ${payload.publishedId}.` : "";

    /* The row is now live, so record that here too — the button must close
       immediately rather than only after the next reload. `publishRecord`
       reports whether the server managed to write the id onto the row; the
       claim itself is committed either way, so the guard holds regardless and
       what a failure costs is only the id. */
    state.publishedAt = payload.publishRecord?.publishedAt || new Date().toISOString();
    state.publishedId = payload.publishRecord?.publishedId || payload.publishedId || null;
    /* `??`, not `||`: an empty array is the truthful answer for a first
       publish, and falling through to the old value on it would leave a
       corrected post still listing the copy it just superseded as current. */
    state.publishedHistory = payload.publishRecord?.publishedHistory ?? state.publishedHistory;
    // Publishing approves, and approval takes a post out of draft server-side.
    state.isDraft = false;
    /* Carried in state for the same reason as publishedAt: the row has a
       verdict now, and autosave refuses to rewrite a post that has one. The
       publish flag alone would cover this tab, but the two travel together
       everywhere else and a half-updated standing is how they drift apart. */
    if (payload.approval?.ok) state.approved = true;

    /* Say what happened to the approval as well as the publish. The two can
       legitimately disagree — the story is live either way, but if it was not
       marked approved QA needs to know to do it by hand, and a bare
       "Published" would hide that. */
    let approvalNote = "";
    if (payload.approval?.ok) {
      approvalNote = payload.approval.alreadyApproved ? " Already approved." : " Marked approved.";
    } else if (payload.approval?.reason === "post not saved") {
      approvalNote = " Save the post to mark it approved.";
    } else if (payload.approval) {
      approvalNote = ` Published, but could not mark it approved (${payload.approval.reason}) — approve it in Review.`;
    }
    setDailyMattrStatus(`Published to DailyMattr.${publishedId}${approvalNote}`, "success");

    /* And say it in a dialog. Publishing is the one action in this app that
       cannot be undone — the story is on a public site and their API is
       write-only, so a mistake means asking DailyMattr to delete a row. A
       status line at the foot of a scrolling column is the wrong weight for
       that, and it was being missed.

       The id is the useful part: it is the only handle anyone has if the post
       later needs pulling, and it exists nowhere else on our side. */
    const facts = [];
    if (payload.publishedId) facts.push(`DailyMattr ID ${payload.publishedId}`);
    if (state.headline) facts.push(cleanHeadlineForPublish(state.headline));
    /* What actually went, not what was promised. An irreversible action should
       end with a receipt someone can reconcile against the live post — the
       count and whether a clip was among it are the two things that were
       silently wrong before the assembly learned to abort. */
    const sentVideos = outboundMedia.filter(({ filename }) => /\.(mp4|mov)$/i.test(filename)).length;
    facts.push(`${outboundMedia.length} media item${outboundMedia.length === 1 ? "" : "s"} sent`
      + (sentVideos ? `, including ${sentVideos === 1 ? "the video" : `${sentVideos} videos`}` : ", no video"));
    if (payload.publishRecord && payload.publishRecord.ok === false && payload.publishRecord.reason !== "post not saved") {
      facts.push(`Warning: the DailyMattr ID could not be saved onto this post (${payload.publishRecord.reason}). Write it down.`);
    }
    if (approvalNote.trim()) facts.push(approvalNote.trim());
    confirmAction({
      notice: true,
      title: "Published",
      body: "This pix is live on the web app.",
      facts,
      confirmLabel: "Done",
    });

    // The badge in Review is rebuilt on entry, but refresh now so a QA who is
    // already looking at the list sees it flip.
    if (payload.approval?.ok) loadReviewQueue();
    return true;
  } catch (err) {
    /* The quietest path of all, and until now the one that showed no dialog.
       If the request had already left the browser, this is the same
       indeterminate state the server reports with `indeterminate` — an aborted
       upload, a dropped connection, a tab put to sleep — and the server may
       well have forwarded the whole post to DailyMattr before the socket
       closed. Say so, and stop offering the button. */
    if (publishRequestSent) {
      publishOutcomeUnknown = true;
      const message = "The connection dropped while this post was being sent, so it may already be live on DailyMattr. "
        + "Check their portal before publishing again — a second attempt cannot be undone.";
      setDailyMattrStatus(message, "error");
      confirmAction({
        notice: true,
        title: "Publish outcome unknown",
        body: message,
        facts: [
          err.message || "The upload failed part-way through.",
          "Do NOT publish again until you have checked the DailyMattr portal.",
        ],
        confirmLabel: "Close",
      });
    } else {
      setDailyMattrStatus(err.message || "Could not publish to DailyMattr.", "error");
    }
  } finally {
    publishInFlight = false;
    /* Not `disabled = false` any more. syncPublishState() owns both the label
       and the disabled flag, and it is the only thing that knows the post is
       now published, or that the last attempt's outcome is unknown — putting
       "Publish to DailyMattr" back on an enabled button in either of those
       cases is precisely how a duplicate gets made. */
    syncPublishState();
  }
}

if (dailymattrRefreshBtn) {
  dailymattrRefreshBtn.addEventListener("click", () => loadDailyMattrMeta({ force: true }));
}
if (dailymattrPublishBtn) {
  // Wrapped, so the click event is never read as the options object.
  dailymattrPublishBtn.addEventListener("click", () => publishToDailyMattr());
}
if (dailymattrContent) {
  dailymattrContent.addEventListener("input", () => { dailymattrDraftTouched.content = true; });
}
if (dailymattrKeywords) {
  dailymattrKeywords.addEventListener("input", () => { dailymattrDraftTouched.keywords = true; });
}
/* QA overriding the section is a deliberate act, so it must not be undone by a
   later sync from the post. Same contract the caption and keywords already
   use. */
if (dailymattrCategory) {
  dailymattrCategory.addEventListener("change", () => {
    dailymattrDraftTouched.category = true;
    state.categoryId = dailymattrCategory.value;
    if (!stateIsRequired(state.categoryId)) {
      state.stateId = "";
      dailymattrDraftTouched.state = false;
    }
    syncSectionInputs();
  });
}
if (dailymattrState) {
  dailymattrState.addEventListener("change", () => {
    dailymattrDraftTouched.state = true;
    state.stateId = dailymattrState.value;
    syncSectionInputs();
  });
}
dailymattrMediaInputs.forEach((item) => {
  item.input?.addEventListener("change", () => {
    const file = item.input.files?.[0] || null;
    if (!file) {
      resetDailyMattrMediaSlot(item);
      return;
    }
    const error = validateDailyMattrExtraFiles();
    if (error) {
      resetDailyMattrMediaSlot(item);
      setDailyMattrStatus(error, "error");
      return;
    }
    if (item.name) item.name.textContent = file.name;
    if (item.card) item.card.classList.add("has-file");
    if (item.remove) item.remove.hidden = false;
    syncDailyMattrMediaCount();
    setDailyMattrStatus(`Output ${item.slot} ready.`, "success");
  });
  item.remove?.addEventListener("click", () => resetDailyMattrMediaSlot(item));
});

(() => {
  const rail = document.getElementById("preview-rail");
  const prev = document.getElementById("rail-prev");
  const next = document.getElementById("rail-next");
  if (!rail || !prev || !next) return;

  const step = () => {
    const card = rail.querySelector(".preview-card");
    // Card width plus the gap, so one press moves exactly one card.
    const gap = parseFloat(getComputedStyle(rail).columnGap || getComputedStyle(rail).gap || "14") || 14;
    return card ? card.getBoundingClientRect().width + gap : rail.clientWidth * 0.8;
  };

  const scrollable = () => rail.scrollWidth - rail.clientWidth > 4;

  function sync() {
    const on = scrollable();
    prev.hidden = next.hidden = !on;
    if (!on) return;
    // Disable rather than hide at the ends — a control that vanishes
    // mid-interaction makes the row jump.
    prev.disabled = rail.scrollLeft <= 2;
    next.disabled = rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 2;
  }

  prev.addEventListener("click", () => rail.scrollBy({ left: -step(), behavior: "smooth" }));
  next.addEventListener("click", () => rail.scrollBy({ left:  step(), behavior: "smooth" }));
  rail.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", sync);
  // The cards resize when the aspect ratio changes, which changes whether the
  // rail overflows at all.
  if (window.ResizeObserver) new ResizeObserver(sync).observe(rail);

  // Layout is not settled when this module runs, so the first sync would read
  // scrollWidth === clientWidth and leave the arrows in the wrong state.
  sync();
  requestAnimationFrame(sync);
  window.addEventListener("load", sync);
})();


/* ── Drag to reframe a video page ──
   Cropping a landscape clip to 9:16 throws away most of its width, so the
   default centre crop often cuts the subject in half. Dragging the video
   card picks the slice to keep. The value is normalised, so the preview and
   ffmpeg's crop agree at any resolution.

   Every video page gets this, so the handler takes the canvas and the page
   it belongs to: the drag edits live state, which means the page has to be
   the selected one first. Grabbing an unselected card selects it, so the
   gesture works on first touch rather than needing a click to arm it. */
function attachVideoReframe(card, pageId) {
  if (!card) return;
  card.classList.add("video-reframe");

  let dragging = false;
  let startX = 0, startY = 0, startFocus = null;

  const hasVideo = () => {
    const v = state.videoEl;
    return v && v.readyState >= 2 && v.videoWidth > 0;
  };

  // How far the frame can travel on each axis, in canvas pixels. Zero on the
  // axis that exactly fits — dragging there would only reveal black.
  function overflow() {
    const v = state.videoEl;
    const scale = Math.max(canvas.width / v.videoWidth, canvas.height / v.videoHeight);
    return {
      x: Math.max(0, v.videoWidth * scale - canvas.width),
      y: Math.max(0, v.videoHeight * scale - canvas.height),
    };
  }

  function pointerDown(e) {
    if (pageId && activePageId !== pageId) setActivePage(pageId);
    if (!hasVideo()) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startFocus = { ...(state.videoFocus || { x: 0.5, y: 0.5 }) };
    card.setPointerCapture?.(e.pointerId);
    card.classList.add("dragging");
    e.preventDefault();
  }

  function pointerMove(e) {
    if (!dragging) return;
    const rect = card.getBoundingClientRect();
    // The card is displayed smaller than the canvas, so convert CSS pixels
    // of travel into canvas pixels before dividing by the overflow.
    const scaleToCanvas = canvas.width / rect.width;
    const over = overflow();
    const dx = (e.clientX - startX) * scaleToCanvas;
    const dy = (e.clientY - startY) * scaleToCanvas;
    const next = {
      x: over.x ? clamp(startFocus.x - dx / over.x, 0, 1) : 0.5,
      y: over.y ? clamp(startFocus.y - dy / over.y, 0, 1) : 0.5,
    };
    state.videoFocus = next;
    renderPoster();
  }

  function pointerUp(e) {
    if (!dragging) return;
    dragging = false;
    card.releasePointerCapture?.(e.pointerId);
    card.classList.remove("dragging");
  }

  card.addEventListener("pointerdown", pointerDown);
  card.addEventListener("pointermove", pointerMove);
  card.addEventListener("pointerup", pointerUp);
  card.addEventListener("pointercancel", pointerUp);

  // Double-click recentres — quicker than dragging back by feel.
  card.addEventListener("dblclick", () => {
    if (pageId && activePageId !== pageId) setActivePage(pageId);
    state.videoFocus = { x: 0.5, y: 0.5 };
    renderPoster();
  });
}

// Video pages get this when they are created; there is no video card on the
// spine any more, so nothing to attach here.

// Timestamp toggle — the stamp is on by default; some posters do not want it.
/* ── Date on the slide, and keywords ─────────────────────────────────
   state.createdAt existed but was never assigned, so formatCreatedAt() always
   fell through to new Date() — the stamp read "today" and no one could change
   it. That is wrong whenever a story is written up a day after the event.

   Kept as a real Date in state and stored as ISO in the design snapshot, so
   the value survives a save and does not drift with the reader's timezone.
   Null still means "today", which is the behaviour everything had before. */
const postDateInput = document.getElementById("post-date");
const postKeywordsInput = document.getElementById("post-keywords");

function toDateInputValue(d) {
  // <input type="date"> wants local YYYY-MM-DD. toISOString() would convert to
  // UTC first, which in IST (UTC+5:30) shows the previous day before 05:30.
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function syncDateAndKeywordInputs() {
  if (postDateInput) {
    const d = state.createdAt instanceof Date && !isNaN(state.createdAt) ? state.createdAt : new Date();
    const want = toDateInputValue(d);
    if (postDateInput.value !== want) postDateInput.value = want;
  }
  if (postKeywordsInput && postKeywordsInput.value !== (state.keywords || "")) {
    postKeywordsInput.value = state.keywords || "";
  }
}

if (postDateInput) {
  postDateInput.addEventListener("change", () => {
    const raw = postDateInput.value;
    if (!raw) { state.createdAt = null; renderPoster(); return; }
    // Parse as LOCAL midday, not midnight: midnight in a timezone behind UTC
    // can roll the date back a day when it is normalised.
    const [y, m, d] = raw.split("-").map(Number);
    const parsed = new Date(y, m - 1, d, 12, 0, 0);
    state.createdAt = isNaN(parsed) ? null : parsed;
    renderPoster();
  });
}

// Start the field on today rather than blank — an empty date box reads as
// "no date", when the slide has always stamped the current one.
syncDateAndKeywordInputs();

document.getElementById("post-date-today")?.addEventListener("click", () => {
  state.createdAt = null;      // null = follow the clock, as before
  syncDateAndKeywordInputs();
  renderPoster();
});

if (postKeywordsInput) {
  postKeywordsInput.addEventListener("input", () => {
    state.keywords = postKeywordsInput.value;
    // Mirror into the publish panel so QA sees what the writer wrote.
    if (dailymattrKeywords && !dailymattrDraftTouched.keywords) {
      dailymattrKeywords.value = state.keywords;
    }
  });
}

/* ── Confirmation dialog ─────────────────────────────────────────────
   Replaces window.confirm for the actions that cannot be taken back.

   window.confirm is fine functionally, but it renders as a browser chrome
   alert with no room to say WHAT is about to happen — and for publishing that
   detail is the whole point: which section, how many files, whether a video
   is going. It also cannot be styled, so it reads as a browser error rather
   than part of the app.

   Built on native <dialog>: Esc-to-cancel, focus trapping and top-layer
   stacking come free, and this page has enough stacking contexts (the mobile
   sheet, the aurora backdrop, the preview rail) that a hand-rolled overlay
   would land behind something eventually.

   Returns a promise for true/false so callers keep reading top to bottom. */
const pixDialogEl = document.getElementById("pix-dialog");

/* `extras` is an optional element rendered inside the dialog — used by
   Approve & Publish to ask for a category the post never carried. It stays the
   caller's node, so the caller reads its values straight off it after this
   resolves; detaching it from the dialog does not clear a <select>. */
/* `notice: true` turns this into a one-button acknowledgement — same dialog,
   no choice to make. A notice is telling the user something happened, so a
   Cancel would be answering a question that was never asked. */
function confirmAction({ title, body = "", facts = [], confirmLabel = "Confirm", danger = false, extras = null, notice = false } = {}) {
  // No <dialog> (very old browser, or the element was removed): fall back
  // rather than silently proceeding with something irreversible.
  if (!pixDialogEl || typeof pixDialogEl.showModal !== "function") {
    if (notice) {
      window.alert(`${title}\n\n${body}`);
      return Promise.resolve(true);
    }
    return Promise.resolve(window.confirm(`${title}\n\n${body}`));
  }

  document.getElementById("pix-dialog-title").textContent = title;
  const bodyEl = document.getElementById("pix-dialog-body");
  bodyEl.textContent = body;
  bodyEl.hidden = !body;

  const factsEl = document.getElementById("pix-dialog-facts");
  factsEl.textContent = "";
  factsEl.hidden = !facts.length;
  for (const fact of facts) {
    const li = document.createElement("li");
    li.textContent = fact;
    factsEl.appendChild(li);
  }

  // Rebuilt on every open, so a picker left by a previous call cannot linger
  // into a plain confirm.
  const extrasEl = document.getElementById("pix-dialog-extras");
  if (extrasEl) {
    extrasEl.textContent = "";
    extrasEl.hidden = !extras;
    if (extras) extrasEl.appendChild(extras);
  }

  const confirmBtn = document.getElementById("pix-dialog-confirm");
  confirmBtn.textContent = confirmLabel;
  confirmBtn.classList.toggle("is-danger", Boolean(danger));

  const cancelBtn = document.getElementById("pix-dialog-cancel");
  cancelBtn.hidden = notice;

  return new Promise((resolve) => {
    /* Resolve from whichever signal arrives first, rather than trusting the
       "close" event alone.

       That event is the obvious hook and it is what this originally used — but
       it does not fire in every environment (measured: the dialog opened,
       closed and set returnValue correctly while "close" never fired at all).
       When that happens the promise never settles and the caller hangs
       forever with no error: the Publish button would sit disabled and the
       user would have no idea why. Button clicks are the signal we actually
       control, so they decide, and the events are a safety net for Esc and
       the backdrop. */
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      pixDialogEl.removeEventListener("cancel", onCancel);
      pixDialogEl.removeEventListener("close", onClose);
      if (pixDialogEl.open) pixDialogEl.close();
      resolve(value);
    };
    const onCancel = () => finish(false);
    const onConfirm = () => finish(true);
    const onClose = () => finish(pixDialogEl.returnValue === "confirm");

    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    pixDialogEl.addEventListener("cancel", onCancel);   // Esc
    pixDialogEl.addEventListener("close", onClose);     // backdrop / programmatic

    pixDialogEl.returnValue = "cancel";   // anything but an explicit yes means no
    pixDialogEl.showModal();
    // Focus Cancel, not Confirm: a stray Enter must not publish. A notice has
    // no Cancel and nothing to guard against, so its one button takes focus.
    (notice ? confirmBtn : cancelBtn).focus();
  });
}

const showTimestampInput = document.getElementById("show-timestamp");
if (showTimestampInput) {
  showTimestampInput.addEventListener("change", () => {
    state.showTimestamp = showTimestampInput.checked;
    renderPoster();
  });
}


/* ── Keep the date stamp current ──
   Computing the date at paint time is only half of it: an idle tab never
   repaints, so the canvas would keep showing the day it was last drawn.
   This schedules a repaint just after local midnight, and re-checks whenever
   the tab becomes visible again — a sleeping laptop does not fire timers, so
   waking up is the case a timer alone would miss. Also covers the machine's
   clock or timezone being changed while the tab sits open. */
(() => {
  const label = () => formatCreatedAt(state.createdAt);
  let lastLabel = label();
  let timer = 0;

  function refreshIfRolledOver() {
    const now = label();
    if (now !== lastLabel) {
      lastLabel = now;
      renderPoster();
    }
  }

  function scheduleNextMidnight() {
    clearTimeout(timer);
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);      // 00:00 tomorrow, local
    // A couple of seconds past the boundary, so the new day is unambiguous.
    const wait = Math.max(1000, nextMidnight.getTime() - now.getTime() + 2000);
    timer = setTimeout(() => {
      refreshIfRolledOver();
      scheduleNextMidnight();
    }, wait);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    refreshIfRolledOver();
    scheduleNextMidnight();   // the pending timer may have been throttled
  });
  window.addEventListener("focus", refreshIfRolledOver);

  scheduleNextMidnight();
})();

// Enhance strength — how much of the AI upscale to keep. Applies to the NEXT
// enhance; it is a request parameter, not a canvas filter, so there is
// nothing to re-render on change.
const enhanceStrengthInput = document.getElementById("enhance-strength");
const enhanceStrengthHint = document.getElementById("enhance-strength-hint");
if (enhanceStrengthInput) {
  const describe = (v) =>
    v >= 90 ? `${v}% — full model output, sharpest but most artificial.`
    : v >= 60 ? `${v}% — strong, and where faces start to look painted.`
    : v >= 25 ? `${v}% — mostly a clean resample, very natural.`
    : `${v}% — raise this only if the image still looks soft.`;
  enhanceStrengthInput.addEventListener("input", () => {
    state.enhanceStrength = Number(enhanceStrengthInput.value);
    if (enhanceStrengthHint) enhanceStrengthHint.textContent = describe(state.enhanceStrength);
  });
}

/* ── Saving to Supabase ────────────────────────────────────────────────────
   A post reaches the pix_posts table only when the user presses Save. Nothing
   is written on scrape, on rewrite or on download: the editor is a workspace,
   and half-finished experiments do not belong in the library.

   A saved row holds the source article and the text extracted from it, what
   the AI wrote, which image was chosen, and the complete editor snapshot
   (ratio, accent, offsets, filters, logo, video trim) — enough to rebuild the
   poster exactly. */

const PIX_SAVE_ENDPOINT = "/api/pix";
let pixSaveInFlight = null;

/**
 * Begin a new post: forget the row this session was editing, forget the
 * provenance of the last story, and — via resetPostModel() — forget its pages
 * and everything on them. Called when a scrape brings in a different article
 * and when a poster is built from hand-written text — both are new posts, and
 * without this the next save would land on the previous row and pair a new
 * headline with an old source URL.
 *
 * Deliberately not window.location.reload() like the New post button: both
 * callers assign the new story's headline and text immediately after this
 * returns, and a reload would throw away the scrape that was just fetched.
 */
function startNewPix() {
  state.pixId = null;
  // The next story starts unfinished, whatever the last one ended as. Without
  // this a writer who submitted, then pressed New post, began the next
  // article already flagged as submitted.
  state.isDraft = true;
  /* A new post has no history, and forgetting to say so is the dangerous
     direction: the previous story's publish record would otherwise keep the
     Publish button shut on a post that has never been sent anywhere. */
  state.publishedAt = null;
  state.publishedId = null;
  state.publishedHistory = [];
  state.approved = false;
  state.rejected = false;
  state.rejectedByName = "";
  state.article = null;
  state.storedImageFor = null;
  state.storedImageUrl = null;
  state.storedVideoFor = null;
  state.storedVideoUrl = null;
  state.renderedClip = null;
  state.headlineTouched = false;
  state.detailTouched = false;
  state.sourceUrl = "";
  syncSourceUrlInput();
  state.categoryId = "";
  state.stateId = "";
  syncSectionInputs();
  state.createdAt = null;
  state.keywords = "";
  syncDateAndKeywordInputs();
  state.articleText = "";
  state.scrapedTitle = "";
  state.imageQuery = "";
  state.sourceImageUrl = null;
  /* The rail, the pages and everything they own. The scalar clears above are
     the post's provenance; this is the post's content, and it lives on the
     pages rather than on `state` — which is why the three lines above that
     clear storedVideoFor/storedVideoUrl/renderedClip never actually dropped
     the last story's clip. Runs before syncDailyMattrDraft({force}) below so
     that draft is rebuilt from a blank post, not from the previous headline. */
  resetPostModel();
  dailymattrDraftTouched.content = false;
  dailymattrDraftTouched.keywords = false;
  dailymattrDraftTouched.category = false;
  dailymattrDraftTouched.state = false;
  resetDailyMattrExtraMedia();
  syncDailyMattrDraft({ force: true });
  publishOutcomeUnknown = false;
  syncPublishState();
}

/**
 * Write the current post to the library.
 *
 * Answers { ok, id?, error? } rather than throwing: the button has to be able
 * to tell the user precisely why a save did not happen.
 */
/* `asDraft` is the whole difference between the two buttons. A draft is saved
   but not handed over: it stays out of QA's queue until it is submitted. Left
   undefined the post keeps whatever it already was, so autosave never quietly
   promotes a draft into the queue.

   `auto` says this write came from the idle timer rather than from a press.
   The server treats the two differently in one place — lifting the rejection
   on a post its author has corrected, which has to be a deliberate handover
   and not something a 2.5s timer does mid-sentence. */
async function savePixToLibrary({ asDraft, auto = false } = {}) {
  /* Resolve the intent for THIS write into a local and leave state.isDraft
     alone until the server has accepted it. Writing it here, above the
     guards, meant a submit refused for a missing category still flipped the
     post to non-draft — permanently, because there is no un-submit — and the
     next Save then created the row in QA's queue mid-sentence.

     The demotion rule is unchanged and load-bearing: submitting always
     applies, but asking for a draft only holds for a post that is still one.
     Hence `!state.isDraft` rather than a flat `false` on the asDraft:true
     branch — otherwise QA pressing Save on a post they are reviewing would
     pull it out of their own queue, which is exactly what makes it safe for
     the in-editor button to be hard-wired to "draft" for every role. */
  const submitting = asDraft === false ? true : !state.isDraft;
  if (!state.user) {
    return { ok: false, error: "Sign in to save posts." };
  }
  if (state.user.role === "writer" && !state.categoryId) {
    return { ok: false, error: "Choose a category before saving." };
  }
  if (state.user.role === "writer" && stateIsRequired(state.categoryId) && !state.stateId) {
    return { ok: false, error: "Choose a state before saving a State category post." };
  }
  // Nothing worth a row yet.
  if (!state.headline && !state.sourceUrl) {
    return { ok: false, error: "Nothing to save yet — scrape a link or write a headline first." };
  }
  /* Source link is required, for every role.

     It is the only record of where a story came from. QA checks it on every
     post, it is what Review searches, and it is what anyone answering "where
     did this come from" months later has to work with — and once a post is
     published to DailyMattr there is no going back to add it, because their
     API is write-only. A scrape fills it in automatically, so the only way to
     arrive here empty is a hand-written post, which is exactly the case where
     the provenance is least obvious and most worth recording. */
  if (submitting && !String(state.sourceUrl || "").trim()) {
    return { ok: false, error: "Add the source link before submitting.", needsSource: true };
  }

  // Impatient double-clicks are the one way two saves overlap. Serialising
  // them keeps the first response — which carries the new id — from racing
  // the second request into creating a duplicate row.
  const run = async () => {
    /* Which post this write is FOR, fixed before the first await.

       The upload below is not quick — several MB of pasted image, or a
       server-side video encode measured in tens of seconds — and the editor
       stays live throughout. Open another post from Review in that window and
       the payload, assembled afterwards, picked up the NEW post's id and the
       new post's fields: the save started for A landed on B, or, after
       "New post", created a fresh row holding a mixture of the two.

       `?? null` rather than a bare read: an unsaved post has no id, and the
       undefined-to-defined transition is exactly the startNewPix case that
       has to be caught too. */
    const targetId = state.pixId ?? null;
    try {
      // Uploads first: the row stores URLs, and a data: URL has none.
      const mediaProblems = await ensureMediaUploaded((message) => {
        if (savePixLabel) savePixLabel.textContent = message;
      });
      /* The payload cannot simply be built before the awaits — describeMainImage
         and the design snapshot read the stored URLs that the upload has just
         produced, so assembling first would record null for exactly the media
         that was uploaded. Abort here instead, after the upload (its side
         effects are still wanted if the writer comes back to this post) and
         before anything is sent. */
      if ((state.pixId ?? null) !== targetId) {
        return { ok: false, error: "Not saved — another post was opened while this one was uploading." };
      }

      /* A video that did not store must not be handed to QA.

         Submitting used to go ahead regardless: the writer got a dialog saying
         the clip had failed, pressed "Got it", and the post was already in the
         review queue — without its video. QA then opened a post whose video
         does not play, and publishing refused with "the video could not be
         prepared", by which time the writer's file was long gone from their
         tab and the footage was unrecoverable. Eight of the twelve most recent
         video posts in the library are in exactly that state.

         So the hand-over is held back and the post stays a draft. Nothing is
         lost — every word and every picture is saved — and it stays with the
         one person who can still fix it, because they are the only one who
         still has the file. */
      const heldBack = submitting && Boolean(videoStoreFailure || imageStoreFailure);
      const handOver = submitting && !heldBack;
      if (savePixLabel) savePixLabel.textContent = "Saving…";
      const response = await fetch(PIX_SAVE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        // `autosave` rides alongside the columns rather than in them: it
        // describes the request, not the post, and normalise() on the server
        // only reads keys it maps to columns.
        body: JSON.stringify({ ...collectPixPayload(handOver), autosave: auto }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.warn(`[pix] not saved: ${data.error || response.status}`);
        // 401: the cookie expired while the tab was open. Put the login back
        // up — retrying the save without a session would just fail again.
        if (response.status === 401) handleSignedOut();
        return { ok: false, error: data.error || `Save failed (${response.status}).` };
      }
      /* Only now is the post's standing what the request claimed it was. A
         refused or failed save leaves the session exactly as it found it.

         Same ownership check as before the fetch, because the response is one
         more await later: the row was written correctly either way, but if
         the editor has moved on since, these three lines would stamp this
         post's id, draft flag and saved-baseline onto a different one — and a
         wrong baseline is the silent failure, because it tells the unsaved
         dot that a post nobody has saved is already stored. */
      if ((state.pixId ?? null) === targetId) {
        /* The server's answer, not the intent. They differ on a post that has
           already been handed over: an asDraft save cannot un-submit one (see
           handleSave), so believing the intent here would leave the editor
           calling a submitted post a draft — and the next line of feedback,
           the pill and the autosave gate all read this flag. */
        state.isDraft = data.isDraft ?? !handOver;
        state.pixId = data.id || state.pixId;
        /* The server lifted a rejection because this save was the author's
           correction, so the post is back in QA's Awaiting queue. Carried into
           state or the editor would keep describing it as rejected — the
           Publish button reads state.rejected, and the writer would be told to
           ask for a withdrawal that has already happened. */
        if (data.resubmitted) {
          state.rejected = false;
          syncPublishState();
        }
        markPixSaved();
      }
      /* Every save, not only the ones that create a row.

         "Only a new row moves the tally" was true before drafts existed. It
         is now exactly backwards: a draft CREATES a row but is not counted,
         and submitting it is an UPDATE — so the single moment the number
         actually changes was the one moment nothing refreshed it, and a
         writer watched their count sit still all day. Approving and rejecting
         move it too, and neither is a create. A count query is cheap; being
         wrong about someone's day's work is not. */
      refreshMyPixCount();
      announceCountChange();
      console.log(`[pix] saved ${data.id}`);
      return {
        ok: true,
        id: data.id,
        created: data.created,
        resubmitted: Boolean(data.resubmitted),
        warning: mediaProblems.length ? mediaProblems.join("; ") : null,
        videoStoreFailure,
        imageStoreFailure,
        /* The submit was downgraded to a draft because the clip is missing —
           and the SERVER agreed. Asserting this from intent alone told a
           writer their post "was kept as YOUR draft" when the row had come
           back non-draft, which happens whenever the post was already with QA:
           an asDraft save cannot un-submit one. The sharpest case is a
           rejected post, where the same save also lifts the rejection and
           pushes it back into the Awaiting queue — so the writer is told it is
           safe in Drafts while QA is holding it, clipless, right now. */
        heldBack: heldBack && (data.isDraft ?? !handOver) === true,
      };
    } catch (err) {
      console.warn("[pix] not saved:", err.message);
      return { ok: false, error: err.message || "Save failed." };
    }
  };

  pixSaveInFlight = (pixSaveInFlight || Promise.resolve()).then(run, run);
  return pixSaveInFlight;
}

/* `submitting` is passed in rather than read off state.isDraft: the caller
   decides what this particular write means, and a save that is later refused
   must not have left a changed flag behind for the next one to pick up. */
/* `view` is the base-page reading of `state` (see basePageView). Every field
   below is taken off it rather than off `state` directly — not because all of
   them are page-owned, but because a mixed convention is what let headline,
   tag and mainImage quietly go back to the live selection. For anything the
   pages do not own the two are the same object value anyway. */
function collectPixPayload(submitting, view = basePageView()) {
  const article = view.article || {};
  const image = describeMainImage(view);

  return {
    id: view.pixId || undefined,
    isDraft: !submitting,

    // The scrape
    sourceUrl: view.sourceUrl || null,
    categoryId: view.categoryId || null,
    stateId: view.stateId || null,
    scrapedTitle: view.scrapedTitle || null,
    articleText: view.articleText || null,
    detailText: view.detailText || null,
    imageQuery: view.imageQuery || null,
    sourceImageUrl: view.sourceImageUrl || null,

    // What the writer produced
    aiHeadline: article.headline || null,
    aiBullets: Array.isArray(article.bullets) ? article.bullets : [],
    aiTweet: article.tweet || null,
    aiFlags: Array.isArray(article.flags) ? article.flags : [],

    // What the poster shows
    headline: view.headline || null,
    detailBody: view.detailText || null,
    mainImageUrl: image.url,
    mainImageSource: image.source,
    aspectRatio: view.aspectRatio,
    accentColor: view.accent,
    tag: view.tag,

    design: collectDesignSnapshot(view),
  };
}

/* The main image is held as an <img>, not a URL, so the source has to be read
   back off it. Remote images always travel through /api/image?url=…, so the
   original address is recoverable from the proxy query; a data: URL means a
   local upload or an AI enhance, which has no address to store. */
/* `view` must be a base-page reading (basePageView): mainImage is owned by
   every page type that shows one, so reading it off live `state` describes
   whichever page is selected rather than the post. */
function describeMainImage(view) {
  const src = view.mainImage?.src || "";
  if (!src) return { url: null, source: null };
  if (src.startsWith("data:")) {
    // An upload or an AI enhance. It has a URL only once it has been pushed
    // to storage — see ensureMediaUploaded, which Save runs first.
    return {
      url: view.storedImageFor === src ? view.storedImageUrl : null,
      source: "upload",
    };
  }

  let url = src;
  try {
    const parsed = new URL(src, window.location.origin);
    if (parsed.pathname === "/api/image" && parsed.searchParams.has("url")) {
      url = parsed.searchParams.get("url");
    } else {
      // imageFromUrl appends a cache-busting ?t= — not part of the address.
      parsed.searchParams.delete("t");
      url = parsed.toString();
    }
  } catch { /* keep src as-is */ }

  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const source =
    /pexels\.com$/i.test(host) || /pexels/i.test(host) ? "stock"
    : /fal\.(media|ai)$/i.test(host) || /fal\./i.test(host) ? "flux"
    : url === view.sourceImageUrl ? "scraped"
    : "search";

  /* Our own copy wins over the address it came from. ensureMediaUploaded now
     stores remote pictures too, and pointing the post at that copy is what
     stops a published story losing its image because a news site reorganised
     its CDN. `source` still records where it originally came from. */
  const stored = view.storedImageFor === src ? view.storedImageUrl : null;
  return { url: stored || url, source };
}

/* Everything the canvas reads that is not text or an image. Deliberately a
   flat, explicit list rather than a clone of `state`: the live objects in
   there (Image elements, the <video>, File handles) are not serialisable and
   would silently bloat or break the row. */
/* `view` must be a base-page reading (basePageView). The typography, framing
   and filter fields here are all page-owned, so the same page-selection leak
   that emptied main_image_url also stamped an added page's crop and font size
   onto the post's design blob. */
function collectDesignSnapshot(view) {
  return {
    aspectRatio: view.aspectRatio,
    accent: view.accent,
    headlineStyle: view.headlineStyle,
    fontSize: view.fontSize,
    enhanceStrength: view.enhanceStrength,
    imageOffset: { ...view.imageOffset },
    imageZoom: view.imageZoom,
    logo: { x: view.logoX, y: view.logoY, size: view.logoSize },
    tag: view.tag,
    showTimestamp: view.showTimestamp,
    createdAt: view.createdAt instanceof Date && !isNaN(view.createdAt)
      ? view.createdAt.toISOString()
      : null,
    keywords: view.keywords || "",
    previewMode: view.previewMode,
    filters: {
      preset: view.filterPreset,
      brightness: view.filterBrightness,
      contrast: view.filterContrast,
      saturation: view.filterSaturation,
      blur: view.filterBlur,
    },
    /* The post's video. Read off the primary video page rather than live
       state: the clip belongs to that page now, and saving while page 1 is
       selected must not write out whatever video fields happen to be left
       over in state. */
    video: (() => {
      const v = primaryVideoContent();
      return {
        sourceKind: v.videoSourceKind || "link",
        url: v.videoUrl || null,
        // The bucket copy: the rendered clip, already cut to the range below
        // and with the caption burned in. `url` above is the original link,
        // which for a scraped clip is a signed URL that expires within hours.
        storedUrl: v.storedVideoUrl || null,
        storedTrimmed: Boolean(v.storedVideoUrl),
        title: v.videoMeta?.title || null,
        // What the writer actually added, so a reviewer can see it later.
        fileName: v.videoFileName || v.videoFile?.name || null,
        trimStart: v.trimStart ?? 0,
        trimEnd: v.trimEnd ?? 0,
        muted: Boolean(v.videoMuted),
        focus: { x: v.videoFocus?.x ?? 0.5, y: v.videoFocus?.y ?? 0.5 },
        caption: v.videoCaption || null,
        captionSize: v.videoCaptionSize ?? view.videoCaptionSize,
      };
    })(),
    // Pages the writer added on top of the spine. The spine itself is the
    // rest of this snapshot, so only the extras are listed.
    pages: serializePages(),
    // Which spine cards are still in the rail. Without this, removing the
    // poster or the text page comes undone on the next open.
    spine: spineCardsInRail(),
    savedAt: new Date().toISOString(),
  };
}

/* ── Save button ──
   The only path into the library. Nothing is stored until this is pressed, so
   the feedback has to be unambiguous: the label reports what happened and the
   preview status line carries the reason whenever it did not. */
const savePixBtn = document.getElementById("save-pix-btn");
const savePixLabel = document.getElementById("save-pix-label");
let saveResetTimer = null;

function showSaveState(label, className = "") {
  if (!savePixBtn) return;
  if (savePixLabel) savePixLabel.textContent = label;
  savePixBtn.classList.remove("is-saved", "is-error");
  if (className) savePixBtn.classList.add(className);
  clearTimeout(saveResetTimer);
  saveResetTimer = setTimeout(() => {
    // Back to whatever this role's resting label is, not a hard-coded "Save".
    if (savePixLabel) savePixLabel.textContent = saveButtonLabel();
    savePixBtn.classList.remove("is-saved", "is-error");
  }, 3000);
}

/* The single save path, shared by the in-editor button and the topbar
   proxies. `intent` is a parameter and nothing else: it used to be read back
   off savePixBtn.dataset, where a "submit" left by one click outlived the
   post that set it. The in-editor button always passes "draft"; only a proxy
   carrying data-intent="submit" — the writer's topbar primary — can submit. */
async function runSave(intent) {
  if (!savePixBtn) return;
  savePixBtn.disabled = true;
  if (savePixLabel) savePixLabel.textContent = "Saving…";
  savePixBtn.classList.remove("is-saved", "is-error");

  const result = await savePixToLibrary({ asDraft: intent !== "submit" });

  savePixBtn.disabled = false;
  if (result?.ok) {
    /* savePixToLibrary only commits state.isDraft once the server accepted,
       so this is the row's real standing, not the intent that was asked for —
       an asDraft:true save of a post QA already has stays submitted. */
    const draft = Boolean(state.isDraft);
    // "Updated" rather than "Saved" when this post is already in the
    // library, so pressing Save twice does not look like it made two.
    showSaveState(result.created ? "Saved" : "Updated", "is-saved");
    if (result.warning) {
      setPostStatus(`Saved, but the ${result.warning}.`, "error");
    }

    /* A clip that failed to store gets a dialog, not a line of red text.

       This is the ONLY moment it can still be recovered. An uploaded video
       lives in the tab as a File; the row keeps a URL, and if the encode
       failed there is no URL to keep. Reload or reopen the post and the File
       is gone for good — videoClipKey() then finds no source, resolvePublishClip
       returns null, and publishing refuses with "the video could not be
       prepared" long after anyone could do anything about it. Four of the five
       saved video posts in the library are already in that state.

       So: say it now, while the file is still in memory and pressing Save
       again is a real fix. */
    /* A missing slide picture gets the same treatment as a missing clip. Both
       reach QA as a post that looks finished and is not, and in both cases the
       only moment it can still be fixed cheaply is now, while the source is
       still loaded in this tab. */
    if (result.videoStoreFailure || result.imageStoreFailure) {
      const missingVideo = Boolean(result.videoStoreFailure);
      const thing = missingVideo ? "video" : "picture";
      await confirmAction({
        notice: true,
        title: result.heldBack
          ? `Not sent to QA — the ${thing} is missing`
          : `The ${thing} was not saved`,
        body: result.heldBack
          ? `Your writing is saved, but the ${thing} could not be stored — so this post was kept as YOUR draft instead of going to QA. A post with a missing ${thing} cannot be published by anyone.`
          : `Everything else was saved, but the ${thing} could not be stored — so this post cannot be published as it stands.`,
        facts: [
          result.videoStoreFailure || result.imageStoreFailure,
          "Press Submit again now. The file is still loaded in this tab.",
          `Do NOT reload or open another post first — an uploaded ${thing} cannot be recovered after that, and would have to be added again.`,
          ...(result.heldBack
            ? ["It stays in your Drafts until it goes through, so nothing you have written is lost."]
            : []),
        ],
        confirmLabel: "Got it",
      });
    }

    if (!result.warning) {
      /* Say where it went and how to move on. Writers were typing the next
         story over a saved poster because nothing told them Save would keep
         landing on the same row. The draft wording matters as much: this line
         claimed "the copy QA is reviewing has been updated" on every save,
         including drafts QA has never been shown. */
      setPostStatus(
        /* A correction to a rejected post is its own outcome, and the most
           useful thing this line can say: the post has left the Rejected tab
           and is back in the queue, which is exactly what the writer was
           trying to achieve and previously never happened. */
        result.resubmitted
          ? "Saved and back with QA — your correction returns the post to the review queue."
          /* A submit that was held back for a missing clip really did stay a
             draft, so it must not be described as sent. */
          : result.heldBack
            ? "Kept as your draft — the video did not save, so it was not sent to QA."
            : draft
            ? (result.created
                ? "Draft saved. QA cannot see it until you press Submit."
                : "Draft updated. QA cannot see it until you press Submit.")
            : (result.created
                ? "Saved and sent to QA for review. Press New post to start the next one."
                : "Saved — the copy QA is reviewing has been updated. Press New post to start a different story."),
        "success",
      );
    }

    /* Writers get this as a dialog, not just a status line. Handing the story
       over is the end of their work on it, and a line of text under the
       preview was being missed — writers kept typing the next story over the
       row they had just sent. QA sees no dialog: saving is not a handoff for
       them, and a modal on every edit would be in the way. */
    /* Not when the hand-over was held back: the writer has just been told, in
       its own dialog, that the post stayed with them because the video is
       missing. A second dialog immediately after saying "Sent to QA" would
       contradict it — and the reassuring one is the lie. */
    if (state.user?.role === "writer" && !result.heldBack) {
      confirmAction({
        notice: true,
        title: result.resubmitted
          ? "Back with QA"
          : draft ? "Draft saved" : (result.created ? "Sent to QA" : "Update sent to QA"),
        body: result.resubmitted
          ? "The rejection has been lifted and your corrected post is in the review queue again."
          : draft
            ? "Kept in My posts. QA cannot see it until you press Submit."
            : (result.created
                ? "Your article is saved and has moved to QA for review."
                : "Your changes are saved. QA is reviewing the updated copy."),
        facts: [
          state.headline ? cleanHeadlineForPublish(state.headline) : "(untitled)",
          result.resubmitted
            ? "It is waiting for approval again — no need to ask anyone to reopen it."
            : draft ? "Press Submit when it is ready for review."
                    : "Press New post to start the next story.",
        ],
        confirmLabel: "Got it",
      });
    }
  } else {
    showSaveState("Not saved", "is-error");
    setPostStatus(result?.error || "Could not save this post.", "error");
    /* A missing source link gets a dialog rather than a status line: it is
       the one failure here that is a step the person skipped rather than
       something that went wrong, so it needs to say what to do and put them
       in front of the field. */
    if (result?.needsSource) {
      await confirmAction({
        notice: true,
        title: "Source link required",
        body: "Every pix needs the link it came from. Paste the article URL into Source Link.",
        facts: [
          "QA checks it on every post, and Review searches by it.",
          "Scraping a link fills it in for you.",
        ],
        confirmLabel: "Add it now",
      });
      focusSourceLink();
    }
  }
}

/* Hard-coded "draft", deliberately. This button is the writer's checkpoint,
   not their handoff — Submit is the topbar primary. It is safe for a reviewer
   too: savePixToLibrary honours asDraft:true only on a post that is already a
   draft, so pressing Save on something in QA's queue cannot pull it out. */
if (savePixBtn) {
  savePixBtn.addEventListener("click", () => { runSave("draft"); });
}

/* ── Starting the next post ────────────────────────────────────────────────

   Save writes to state.pixId when there is one, which is right for "fix a typo
   and save again" and wrong for "that one is done, here is the next story".
   startNewPix() already drops the row id, but only Scrape & Build and Write
   Text call it — so a writer who cleared the headline and typed a new one by
   hand kept saving over the post QA was reviewing, with no sign anything was
   amiss.

   This reloads rather than unsetting fields one by one. A poster carries pages,
   images, a video with its trim, filters, logo placement and framing; clearing
   that by hand means enumerating state no one can be sure is complete, and a
   single missed field means the next story silently inherits it. The session
   cookie survives a reload, so the writer stays signed in and lands on an
   editor that is genuinely empty. */
const newPixBtn = document.getElementById("new-pix-btn");
if (newPixBtn) {
  newPixBtn.addEventListener("click", async () => {
    /* Deliberately not the button's is-dirty class: that is suppressed for a
       post which has never been saved, and unsaved work is exactly what must
       not be thrown away without asking. */
    const hasContent = Boolean(state.headline || state.sourceUrl);
    const unsaved = hasContent
      && (lastSavedFingerprint === null || pixFingerprint() !== lastSavedFingerprint);

    if (unsaved) {
      const go = await confirmAction({
        title: "Start a new post?",
        body: "This poster has changes that are not in the library yet. Starting a new one discards them.",
        facts: [state.headline ? `“${state.headline}”` : "Untitled poster"],
        confirmLabel: "Discard and start new",
        danger: true,
      });
      if (!go) return;
    }
    window.location.reload();
  });
}

/* ── Opening a saved post ──────────────────────────────────────────────────
   The list itself lives on the Review page (one page, scoped by role). What
   is left here is everything needed to pull a stored row back into the
   editor. */

function formatLibraryDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/* The date a row should show is the date it is being SORTED by.

   Every row showed updated_at (falling back to created_at) whatever list it
   was in. On the Published tab that is the wrong clock twice over: the rows
   arrive newest-published-first, but each one prints the day it was last
   edited — so a story written last week and published this morning sits at the
   top under last week's date, and the column reads as though the ordering is
   broken when it is the label that is lying.

   Answers { at, label }. The label is dropped on All, where created_at needs
   no explaining and a prefix on every row would only add noise. */
function reviewRowStamp(post) {
  if (reviewFilter === "published") return { at: post.published_at, label: "published" };
  if (reviewFilter === "approved") return { at: post.approved_at, label: "approved" };
  if (reviewFilter === "rejected") return { at: post.rejected_at, label: "rejected" };
  if (reviewFilter === "awaiting" || reviewFilter === "drafts") {
    return { at: post.updated_at || post.created_at, label: "edited" };
  }
  return { at: post.created_at, label: "" };
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

async function openSavedPost(id) {
  setReviewStatus("Opening…");
  try {
    const response = await fetch(`/api/pix?id=${encodeURIComponent(id)}`, { credentials: "same-origin" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) return handleSignedOut();
      setReviewStatus(payload.error || `Could not open that post (${response.status}).`, "error");
      return;
    }
    await loadPixIntoEditor(payload.post);
    setReviewStatus("");
    /* The unpublishable case gets the line, not the cheerful one.

       A post carrying a video page with no stored clip cannot be published by
       anybody, and the only place that ever said so was the publish button —
       after QA had read the article, edited it, and committed to sending it.
       Saying it on open means the first thing a reviewer learns about an
       unpublishable post is that it is unpublishable, while the writer may
       still have the file and a rejection can still recover the footage.

       Set here rather than inside loadPixIntoEditor because the success line
       above runs afterwards and would overwrite it. */
    if (canReviewRole(state.user?.role) && primaryVideoPage() && !state.storedVideoUrl) {
      setStatus(
        "This post has a video page but no stored clip, so it cannot be published. Reject it back to the writer to have the video added again.",
        "error",
      );
    } else {
      setStatus("Opened — edit it, then press Save.", "success");
    }
  } catch (err) {
    setReviewStatus(err.message || "Could not open that post.", "error");
  }
}

/* ── Opening a row is not editing it ──
   loadPixIntoEditor is async: it awaits the main image, and the restored clip
   finishes later still, on `loadedmetadata`. The 800ms poller does not know
   any of that. It saw the new post's id, a fingerprint that no longer matched
   the PREVIOUS post's baseline, and — after ~3s of a half-restored editor —
   wrote what it found: main_image_url = null over the post just opened, and,
   because state.storedVideoFor is not stamped until the clip's metadata
   arrives, a full re-encode and re-upload of a source URL that has usually
   expired by then. Nobody had touched a key.

   `editorLoading` closes the synchronous body. `editorLoadSeq` is what closes
   the tails: a load's re-baseline only counts while that load is still the
   current one, so a slow image or clip belonging to post A cannot declare
   post B "saved" after the user has moved on. */
let editorLoading = false;
let editorLoadSeq = 0;

/* Rebuild the editor from a stored row. The design snapshot carries anything
   that is not text or an image; missing keys fall back to what is already in
   state, so a row saved by an older version still opens. */
async function loadPixIntoEditor(post) {
  if (!post) return;
  const design = post.design || {};

  /* Not markPixSaved(): that would record a half-restored post — no image,
     trimEnd 0 — as the stored truth, which is a worse thing to leave behind
     if the image fetch then fails. Null hits considerAutosave's existing
     "no baseline yet" guard and blanks the unsaved dot for the duration, and
     it structurally cannot leave a baseline belonging to the previous post. */
  const loadToken = ++editorLoadSeq;
  lastSavedFingerprint = null;
  editorLoading = true;
  try {
    resetDailyMattrExtraMedia();

    /* The publish line belongs to the post that was open, not to the panel.
       Without this, "Published to DailyMattr" stayed on screen when the next
       article was opened, so an untouched post read as already sent — the one
       mistake this panel must never invite. */
    setDailyMattrStatus("");

    state.pixId = post.id;
    state.isDraft = Boolean(post.is_draft);
    /* Carry the row's standing into the editor. Without it the publish panel
       had no idea whether this post was already live or already turned down,
       so the only thing that could refuse either was the server — after the
       encode and the upload, as an error QA had no way to anticipate. */
    state.publishedAt = post.published_at || null;
    state.publishedId = post.published_id || null;
    state.publishedHistory = Array.isArray(post.published_history) ? post.published_history : [];
    state.approved = Boolean(post.approved);
    state.rejected = Boolean(post.rejected);
    state.rejectedByName = post.rejected_by_name || "";
    publishOutcomeUnknown = false;
    state.headline = post.headline || post.ai_headline || post.scraped_title || "";
    state.detailText = post.detail_body || post.detail_text || "";
    state.articleText = post.article_text || "";
    state.sourceUrl = post.source_url || "";
    syncSourceUrlInput();
    state.categoryId = post.category_id ? String(post.category_id) : "";
    state.stateId = post.state_id ? String(post.state_id) : "";
    syncSectionInputs();
    state.scrapedTitle = post.scraped_title || "";
    state.imageQuery = post.image_query || "";
    state.sourceImageUrl = post.source_image_url || null;
    state.article = (post.ai_headline || (post.ai_bullets || []).length)
      ? {
          headline: post.ai_headline || "",
          bullets: post.ai_bullets || [],
          tweet: post.ai_tweet || "",
          flags: post.ai_flags || [],
        }
      : null;
    state.ready = true;
    dailymattrDraftTouched.content = false;
    dailymattrDraftTouched.keywords = false;
    dailymattrDraftTouched.category = false;
    dailymattrDraftTouched.state = false;

    applyDesignSnapshot(design, post);
    syncDailyMattrDraft({ force: true });

    // Text inputs
    if (headlineEdit) headlineEdit.value = state.headline;
    if (detailEdit) detailEdit.value = state.detailText;
    if (writeHeadline) writeHeadline.value = state.headline;
    if (writeDetail) writeDetail.value = state.detailText;
    if (editPanel) editPanel.hidden = false;
    if (imagePanel) imagePanel.hidden = false;

    // The article tab reads from the DOM, so refill it too when there is one.
    if (state.article) {
      renderArticle({
        headline: state.article.headline || state.headline,
        bullets: state.article.bullets,
        tweet: state.article.tweet,
        flags: state.article.flags,
      });
    }

    // A stored image is a URL; it goes back through the proxy exactly as it did
    // the first time. An upload has no URL, so the poster opens without it.
    // A stored video plays straight from the bucket.
    /* A stored clip belongs to a Video page. Posts saved before video became
       its own page carry no page list, so give them a page to land in. */
    if (design.video?.storedUrl) {
      const videoPage = ensureVideoPage();
      if (videoPage) {
        renumberPages();
        setActivePage(videoPage.id);
        restoreStoredVideo(design.video);
        bindRestoredVideoToPage(videoPage, loadToken);
        setActivePage("base");
      } else {
        setStatus("Opened, but this post is full — its video has no page to open into.", "error");
      }
    }

    state.mainImage = null;
    if (post.main_image_url) {
      try {
        state.mainImage = await imageFromUrl(`/api/image?url=${encodeURIComponent(post.main_image_url)}`);
      } catch {
        setStatus("Opened, but the image could not be reloaded.", "error");
      }
    }

    renderPoster();
    // What was just loaded is, by definition, what is stored — but only if
    // this is still the load the editor is showing.
    if (loadToken === editorLoadSeq) {
      markPixSaved();
      /* Same guard: a stale load must not put ITS post's publish state on the
         button and the status line of the post now on screen. Announced here
         and nowhere else — setDailyMattrStatus("") a few lines up has just
         cleared the previous post's publish line, so this is the one place
         where the standing is both news and unobstructed. */
      syncPublishState({ announce: true });
    }
  } finally {
    /* Guarded too: an older load unwinding must not declare the newer one
       finished. And it must be a finally — applyDesignSnapshot and the
       restores are synchronous and can throw, and a stuck flag would kill
       autosave for the rest of the session. */
    if (loadToken === editorLoadSeq) editorLoading = false;
  }
}

function applyDesignSnapshot(design, post) {
  const ratio = design.aspectRatio || post.aspect_ratio;
  if (ratio && LAYOUT_PRESETS[ratio]) applyAspectRatio(ratio);

  state.accent = design.accent || post.accent_color || state.accent;
  state.tag = design.tag || post.tag || "none";
  state.headlineStyle = design.headlineStyle || state.headlineStyle;
  state.fontSize = numberOr(design.fontSize, state.fontSize);
  state.enhanceStrength = numberOr(design.enhanceStrength, state.enhanceStrength);
  state.imageZoom = numberOr(design.imageZoom, 100);
  state.imageOffset = {
    x: numberOr(design.imageOffset?.x, 0),
    y: numberOr(design.imageOffset?.y, 0),
  };
  state.logoX = numberOr(design.logo?.x, state.logoX);
  state.logoY = numberOr(design.logo?.y, state.logoY);
  state.logoSize = numberOr(design.logo?.size, state.logoSize);
  state.showTimestamp = design.showTimestamp !== false;
  const restoredDate = design.createdAt ? new Date(design.createdAt) : null;
  state.createdAt = restoredDate && !isNaN(restoredDate) ? restoredDate : null;
  state.keywords = typeof design.keywords === "string" ? design.keywords : "";
  syncDateAndKeywordInputs();

  const filters = design.filters || {};
  state.filterPreset = filters.preset || "none";
  state.filterBrightness = numberOr(filters.brightness, 100);
  state.filterContrast = numberOr(filters.contrast, 100);
  state.filterSaturation = numberOr(filters.saturation, 100);
  state.filterBlur = numberOr(filters.blur, 0);

  // Push the values back into the controls, or the panel would show the
  // previous post's settings while the canvas shows this one's.
  syncControl(imgOffsetX, state.imageOffset.x);
  syncControl(imgOffsetY, state.imageOffset.y);
  syncControl(imgZoom, state.imageZoom);
  syncControl(fontSizeInput, state.fontSize);
  syncControl(accentColorInput, state.accent);
  syncControl(filterBrightnessInput, state.filterBrightness);
  syncControl(filterContrastInput, state.filterContrast);
  syncControl(filterSaturationInput, state.filterSaturation);
  syncControl(filterBlurInput, state.filterBlur);
  if (accentHexLabel) accentHexLabel.textContent = String(state.accent).toUpperCase();

  // Rebuild the added pages, then hand the editor back to page 1 — which is
  // what the writer is looking at when a post opens.
  /* The spine goes IN, rather than being applied after the fact: restorePages
     spends the 5-slide budget as it rebuilds, so it has to start from the
     arrangement the post was saved with or it drops the last page. */
  restorePages(design.pages, design.spine);
  // Still called: it is the path that puts a spine card BACK, and the one
  // that handles a legacy post with no spine recorded at all.
  restoreSpineCards(design.spine);
  setActivePage("base", { force: true });
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function syncControl(el, value) {
  if (el && value !== undefined && value !== null) el.value = value;
}

/* A session can expire mid-edit. Say so once, plainly, and put the login back
   up rather than letting every later action fail on its own. */
function handleSignedOut() {
  setReviewStatus("");
  setAuthState("blocked", "Your session expired. Sign in again — your poster is still on screen.");
}

/* ── Saved posts / Review ──────────────────────────────────────────────────
   One page, read two ways. The server scopes the list by role, so this file
   renders whatever it is handed:

     writer — "My posts": their own — drafts included, since nowhere else
              lists them — with Open and a read-only Draft / Awaiting /
              Approved / Rejected pill.
     qa     — "Review": everyone's, filterable by sign-off, with Open,
              Approve / Unapprove and Delete.

   Approving is deliberately not part of saving. A save writes the post; an
   approval records a judgement about it and touches none of its fields — so
   QA can approve without the risk of nudging a slider on the way past. */

const reviewList = document.getElementById("review-list");
const reviewStatus = document.getElementById("review-status");
const reviewFilters = document.getElementById("review-filters");
const reviewRefreshBtn = document.getElementById("review-refresh");
const reviewTabLabel = document.getElementById("review-tab-label");
const reviewTitle = document.getElementById("review-title");
const reviewDesc = document.getElementById("review-desc");

/* "all" | "drafts" | "awaiting" | "approved" | "rejected" | "published". Not
   QA-only any more: All and Drafts are offered to writers too, because a
   writer's own drafts are listed nowhere else. The rest are the queue's states
   and stay marked qa-only in the markup.

   "published" is the odd one and belongs to QA alone: it is not a verdict but
   the record of what has left the building, and it exists because a correction
   has to begin by reopening the exact post that went out. */
let reviewFilter = "all";

/* Selecting a tab means two things — which rows to ask for, and which button
   looks pressed — and they have to move together. The variable used to be
   assigned directly in two places, one of which (the role clamp below) left
   the buttons showing a tab that was no longer the one being listed. */
function selectReviewFilter(name) {
  reviewFilter = name;
  if (!reviewFilters) return;
  reviewFilters.querySelectorAll(".review-filter").forEach((t) => {
    const active = t.dataset.filter === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
}

/* Title, tab label and blurb all follow the role. Called whenever a session
   resolves, so a writer signing in after QA never sees QA's wording. */
function syncReviewCopy() {
  const isQa = canReviewRole(state.user?.role);
  if (reviewTabLabel) reviewTabLabel.textContent = isQa ? "Review" : "My posts";
  if (reviewTitle) reviewTitle.innerHTML = isQa ? "Review<br>and publish." : "Your<br>saved posts.";
  if (reviewDesc) {
    // Approving is no longer something QA does from this list — a post is
    // approved by being published from the editor — so the wording points at
    // the route that exists rather than at a button that has gone.
    reviewDesc.textContent = isQa
      ? "Every post the writers have saved. Open one to edit and publish it, or send it back with Reject."
      : "Everything you have saved. Open one to keep working on it — QA reviews them from their own view.";
  }
  /* Reset only out of a tab this role cannot see. The old flat reset to "all"
     ran on every session resolve, so with writers now offered Drafts it would
     have thrown them straight back out of it. What it is actually for is a
     role change in one tab — QA signing out and a writer signing in — where a
     filter left behind would otherwise keep listing under a tab that has just
     been hidden. */
  if (!isQa && reviewFilter !== "all" && reviewFilter !== "drafts") selectReviewFilter("all");
}

function setReviewStatus(message, kind) {
  if (!reviewStatus) return;
  reviewStatus.textContent = message || "";
  reviewStatus.className = "status-text" + (kind ? ` ${kind}` : "");
}

if (reviewFilters) {
  reviewFilters.addEventListener("click", (event) => {
    const btn = event.target.closest(".review-filter");
    if (!btn) return;
    selectReviewFilter(btn.dataset.filter);
    loadReviewQueue();
  });
}

if (reviewRefreshBtn) reviewRefreshBtn.addEventListener("click", () => loadReviewQueue());

/* ═══════════════════════ Writer accounts (QA only) ═══════════════════════

   Accounts previously existed only if someone ran `npm run users:seed`, which
   creates a fixed roster of six — adding a seventh writer meant shell access
   to the server. QA runs the team, so QA gets the screen.

   Everything here is rendered with DOM nodes, never innerHTML: usernames and
   display names are operator-supplied text and would otherwise be a script
   injection into the one screen only QA can see. */
const writersView = document.getElementById("writers-view");
const writersList = document.getElementById("writers-list");
const writersStatusEl = document.getElementById("writers-status");
const writerCreateForm = document.getElementById("writer-create-form");

function setWritersStatus(message, kind) {
  if (!writersStatusEl) return;
  writersStatusEl.className = "status-text" + (kind ? ` ${kind}` : "");
  writersStatusEl.textContent = message || "";
}

async function usersRequest(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  const payload = await res.json().catch(() => ({}));
  if (res.status === 401) { handleSignedOut(); throw new Error("Signed out."); }
  if (!res.ok) throw new Error(payload.error || `Request failed (${res.status}).`);
  return payload;
}

let writerStats = new Map();     // user id -> { sent, approved, pending }
let selectedWriterId = null;

/* The roster and the output figures come from two places and are merged here:
   /api/users knows who exists (including anyone who has never written a word,
   who is absent from the post table entirely), while the analytics writers
   board knows how much each has produced. Neither alone is the answer. */
async function loadWriters() {
  if (!writersList || !isAdminRole(state.user?.role)) return;
  setWritersStatus("Loading writers...");
  try {
    const [{ users }, analytics] = await Promise.all([
      usersRequest("/api/users"),
      // Counts are a nicety - a failure here must not empty the roster.
      usersRequest("/api/pix-analytics").catch(() => null),
    ]);

    writerStats = new Map();
    for (const row of analytics?.analytics?.writers || []) {
      if (row.user_login_id) {
        writerStats.set(row.user_login_id, {
          sent: row.sent_count || 0,
          week: row.week_count || 0,
          approved: row.approved_count || 0,
          pending: row.pending_count || 0,
        });
      }
    }

    writersList.textContent = "";
    for (const u of users) writersList.appendChild(renderWriterRow(u));

    const active = users.filter((u) => u.active).length;
    setWritersStatus(`${users.length} account${users.length === 1 ? "" : "s"} \u00b7 ${active} active`);

    // Keep the open writer open across a refresh (e.g. after a disable).
    if (selectedWriterId) {
      const still = users.find((u) => u.id === selectedWriterId);
      if (still) openWriter(still);
    }
  } catch (err) {
    setWritersStatus(err.message, "error");
  }
}

function renderWriterRow(u) {
  const li = document.createElement("li");
  li.className = "writers-item"
    + (u.active ? "" : " is-disabled")
    + (u.id === selectedWriterId ? " is-selected" : "");
  li.dataset.userId = u.id;

  // The row itself opens the writer; the admin buttons sit outside it so a
  // click on "Disable" does not also select the row.
  const open = document.createElement("button");
  open.type = "button";
  open.className = "writers-item-open";
  open.addEventListener("click", () => openWriter(u));

  const avatar = document.createElement("span");
  avatar.className = "writers-avatar";
  avatar.textContent = initialsOf(u.displayName || u.username);

  const main = document.createElement("span");
  main.className = "writers-item-main";
  const name = document.createElement("span");
  name.className = "writers-item-name";
  name.textContent = u.displayName || u.username;
  const meta = document.createElement("span");
  meta.className = "writers-item-meta";
  const stats = writerStats.get(u.id);
  meta.textContent = [
    roleLabel(u.role),
    stats ? `${stats.sent} post${stats.sent === 1 ? "" : "s"}` : "no posts yet",
    u.active ? null : "disabled",
  ].filter(Boolean).join(" \u00b7 ");
  main.append(name, meta);

  /* This week's output, called out rather than buried in the meta line \u2014 it is
     the number the roster exists to answer. A lifetime total tells you who has
     been here longest, not who is producing now. */
  if (stats) {
    const week = document.createElement("span");
    week.className = "writers-week";
    week.textContent = `${stats.week} this week`;
    week.title = "Posts created in the last 7 days";
    main.appendChild(week);
  }
  open.append(avatar, main);

  const actions = document.createElement("div");
  actions.className = "writers-item-actions";

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "btn-ghost";
  resetBtn.textContent = "Reset password";
  resetBtn.addEventListener("click", async () => {
    const next = window.prompt(`New password for ${u.username} (at least 6 characters):`);
    if (next === null) return;
    if (next.length < 6) { setWritersStatus("Passwords must be at least 6 characters.", "error"); return; }
    try {
      await usersRequest("/api/users/password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u.username, password: next }),
      });
      setWritersStatus(`Password updated for ${u.username}.`, "success");
    } catch (err) { setWritersStatus(err.message, "error"); }
  });

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "btn-ghost";
  toggleBtn.textContent = u.active ? "Disable" : "Enable";
  const isSelf = state.user && u.username === state.user.username;
  if (isSelf && u.active) {
    // The server refuses this too; disabling it here explains why rather than
    // waiting for an error after the click.
    toggleBtn.disabled = true;
    toggleBtn.title = "You cannot disable your own account.";
  }
  toggleBtn.addEventListener("click", async () => {
    /* Disabling has no visible consequence on this screen beyond a greyed row,
       but it locks the person out completely — and a disabled account fails
       login with "Incorrect username or password", so from their side it looks
       like a broken password, not a switched-off account. That already
       happened once in production. Confirm before doing it; enabling needs no
       confirmation because it cannot lock anyone out. */
    if (u.active) {
      const ok = await confirmAction({
        title: `Disable ${u.displayName || u.username}?`,
        body: "They will be signed out immediately and will not be able to log in. Sign-in will tell them the password is wrong, so let them know.",
        facts: ["Their posts stay exactly as they are", "You can re-enable them at any time"],
        confirmLabel: "Disable",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await usersRequest("/api/users/active", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u.username, active: !u.active }),
      });
      setWritersStatus(`${u.username} ${u.active ? "disabled" : "enabled"}.`, "success");
      loadWriters();
    } catch (err) { setWritersStatus(err.message, "error"); }
  });

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "btn-ghost";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openEditWriterDialog(u);
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn-ghost is-danger";
  deleteBtn.textContent = "Delete";
  if (isSelf) {
    deleteBtn.disabled = true;
    deleteBtn.title = "You cannot delete your own account.";
  }
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = await confirmAction({
      title: `Delete ${u.displayName || u.username}?`,
      body: "They will be permanently removed. Their posts will remain but without an attached author.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await usersRequest("/api/users/delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u.username }),
      });
      setWritersStatus(`${u.username} deleted.`, "success");
      loadWriters();
    } catch (err) { setWritersStatus(err.message, "error"); }
  });

  actions.append(editBtn, deleteBtn, resetBtn, toggleBtn);
  li.append(open, actions);
  return li;
}

function initialsOf(name) {
  const parts = String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((w) => w[0].toUpperCase()).join("") || "?";
}

/* Everything one writer has produced. Reuses the list endpoint's existing
   ?user= filter - QA may narrow to any author, a writer is pinned to their
   own - so this needed no new server route. */
async function openWriter(u) {
  selectedWriterId = u.id;
  document.querySelectorAll(".writers-item").forEach((el) => {
    el.classList.toggle("is-selected", el.dataset.userId === u.id);
  });

  const emptyEl = document.getElementById("writer-detail-empty");
  const bodyEl = document.getElementById("writer-detail-body");
  const listEl = document.getElementById("writer-posts");
  if (!bodyEl || !listEl) return;
  if (emptyEl) emptyEl.hidden = true;
  bodyEl.hidden = false;

  document.getElementById("writer-detail-name").textContent = u.displayName || u.username;
  const stats = writerStats.get(u.id);
  document.getElementById("writer-detail-meta").textContent = [
    u.username,
    roleLabel(u.role),
    stats ? `${stats.approved} approved \u00b7 ${stats.pending} pending` : "no posts yet",
  ].join(" \u00b7 ");

  listEl.textContent = "";
  const loading = document.createElement("li");
  loading.className = "writer-posts-empty";
  loading.textContent = "Loading...";
  listEl.appendChild(loading);

  try {
    const res = await fetch(`/api/pix?limit=100&user=${encodeURIComponent(u.id)}`, { credentials: "same-origin" });
    if (res.status === 401) return handleSignedOut();
    const payload = await res.json().catch(() => ({}));
    listEl.textContent = "";
    const posts = payload.posts || [];
    if (!posts.length) {
      const none = document.createElement("li");
      none.className = "writer-posts-empty";
      none.textContent = `${u.displayName || u.username} has not written anything yet.`;
      listEl.appendChild(none);
      return;
    }
    // renderReviewItem already draws a post row with its thumbnail, status and
    // Open/Approve/Delete actions - no reason to grow a second one.
    for (const post of posts) listEl.appendChild(renderReviewItem(post));
  } catch (err) {
    listEl.textContent = "";
    const failed = document.createElement("li");
    failed.className = "writer-posts-empty";
    failed.textContent = `Could not load posts: ${err.message}`;
    listEl.appendChild(failed);
  }
}

/* Create the account. This handler was lost when the writers block was
   rewritten — the form still opened, so the page looked complete, but
   submitting it did nothing at all. */
if (writerCreateForm) {
  writerCreateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const usernameEl = document.getElementById("writer-username");
    const passwordEl = document.getElementById("writer-password");
    const username = (usernameEl?.value || "").trim();
    const displayName = (document.getElementById("writer-display")?.value || "").trim();
    const password = passwordEl?.value || "";
    const role = document.getElementById("writer-role")?.value || "writer";

    if (!username) { setWritersStatus("Give the account a username.", "error"); usernameEl?.focus(); return; }
    if (password.length < 6) { setWritersStatus("Passwords must be at least 6 characters.", "error"); passwordEl?.focus(); return; }

    const btn = document.getElementById("writer-create-btn");
    if (btn) btn.disabled = true;
    setWritersStatus("Creating…");
    try {
      const { user } = await usersRequest("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, role, displayName }),
      });
      writerCreateForm.reset();
      writerCreateForm.hidden = true;
      setWritersStatus(
        `Created ${user.username}. Pass on the password you just set — it is stored hashed and cannot be read back.`,
        "success",
      );
      await loadWriters();
    } catch (err) {
      setWritersStatus(err.message, "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

document.getElementById("writers-add-toggle")?.addEventListener("click", () => {
  const form = document.getElementById("writer-create-form");
  if (!form) return;
  form.hidden = !form.hidden;
  if (!form.hidden) document.getElementById("writer-username")?.focus();
});

document.getElementById("writers-refresh")?.addEventListener("click", () => loadWriters());

/* ── Section (category + state) ──────────────────────────────────────
   The writer files the story while they build it: they have the context, and
   QA would otherwise be guessing at review time. QA can still change it at
   publish — this is the starting point, not a lock.

   The one hard rule comes from DailyMattr: the "State" category REQUIRES a
   state. Matched by NAME against their live list rather than by a hard-coded
   id, so it survives them renumbering. Enforced on the server too — this is
   the early, friendly half. */
const postCategorySelect = document.getElementById("post-category");
const postStateSelect = document.getElementById("post-state");
const postSectionHint = document.getElementById("post-section-hint");
const postStateField = document.getElementById("post-state-field");
const postSectionRow = postCategorySelect?.closest(".section-row");
const postCategoryRequired = document.getElementById("post-category-required");

let stateCategoryId = null;   // the id of the category literally named "State"
/* Shared with the analytics category filter, which lists the same sections. */
let sectionCategories = [];

function stateIsRequired(categoryId) {
  return Boolean(stateCategoryId) && String(categoryId || "") === String(stateCategoryId);
}

/* Show the rule before it bites, rather than letting a publish fail on it. */
function syncSectionHint() {
  const needsState = stateIsRequired(state.categoryId);
  const writerNeedsCategory = state.user?.role === "writer";
  if (postCategorySelect) {
    postCategorySelect.required = writerNeedsCategory;
    postCategorySelect.setAttribute("aria-required", String(writerNeedsCategory));
  }
  if (postCategoryRequired) postCategoryRequired.hidden = !writerNeedsCategory;
  if (postStateField) {
    postStateField.hidden = !needsState;
    postStateField.classList.toggle("is-required", needsState);
  }
  if (postSectionRow) postSectionRow.classList.toggle("has-state", needsState);
  if (postStateSelect) {
    postStateSelect.required = needsState;
    postStateSelect.setAttribute("aria-required", String(needsState));
  }
  if (!postSectionHint) return;
  if (writerNeedsCategory && !state.categoryId) {
    postSectionHint.textContent = "Category is required before saving.";
    postSectionHint.className = "helper-text is-warning";
  } else if (needsState && !state.stateId) {
    postSectionHint.textContent = "The State category needs a state — pick one.";
    postSectionHint.className = "helper-text is-warning";
  } else {
    postSectionHint.textContent = "Where this story is filed on the web app.";
    postSectionHint.className = "helper-text";
  }
}

function syncSectionInputs() {
  if (postCategorySelect && postCategorySelect.value !== (state.categoryId || "")) {
    postCategorySelect.value = state.categoryId || "";
  }
  if (postStateSelect && postStateSelect.value !== (state.stateId || "")) {
    postStateSelect.value = state.stateId || "";
  }

  /* Mirror into the publish panel, so what the writer filed under is what QA
     sees rather than "Choose a category". Skipped once QA has picked
     something themselves — their override wins.

     Setting .value on a <select> whose options have not loaded yet is a silent
     no-op, which is why loadDailyMattrMeta() and loadSectionOptions() both
     call back here after populating their lists. */
  if (dailymattrCategory && !dailymattrDraftTouched.category
      && dailymattrCategory.value !== (state.categoryId || "")) {
    dailymattrCategory.value = state.categoryId || "";
  }
  if (dailymattrState && !dailymattrDraftTouched.state
      && dailymattrState.value !== (state.stateId || "")) {
    dailymattrState.value = state.stateId || "";
  }
  syncSectionHint();
}

/* Editing the section here is the same act as editing it in the publish panel
   — one value, two places to change it. Both go through syncSectionInputs()
   so the mirroring and the override guard live in exactly one function; the
   direct assignment that used to sit here bypassed the guard and could
   overwrite a choice QA had already made. */
postCategorySelect?.addEventListener("change", () => {
  state.categoryId = postCategorySelect.value;
  if (!stateIsRequired(state.categoryId)) {
    state.stateId = "";
    dailymattrDraftTouched.state = false;
  }
  // A hand edit here outranks an earlier hand edit in the publish panel: the
  // guard exists to stop AUTOMATIC syncs clobbering a choice, not to make the
  // two controls disagree. Clearing it lets this one through.
  dailymattrDraftTouched.category = false;
  syncSectionInputs();
});
postStateSelect?.addEventListener("change", () => {
  state.stateId = postStateSelect.value;
  dailymattrDraftTouched.state = false;
  syncSectionInputs();
});

/* Everyone signed in can read the lists — a writer needs them to file a story.
   Publishing remains QA-only on the server. */
async function loadSectionOptions() {
  if (!postCategorySelect || !state.user) return;
  try {
    const res = await fetch(DAILYMATTR_META_ENDPOINT, { credentials: "same-origin" });
    if (!res.ok) return;
    const payload = await res.json();
    const categories = payload.categories || [];
    const states = payload.states || [];
    const stateCat = categories.find((c) => /^state$/i.test(String(c.name).trim()));
    stateCategoryId = stateCat ? String(stateCat.id) : null;
    fillSelectOptions(postCategorySelect, categories, "Choose a category");
    fillSelectOptions(postStateSelect, states, "Choose a state");
    syncSectionInputs();
    // The analytics category filter lists these same sections, by the same ids.
    sectionCategories = categories;
    fillCategoryOptions(categories);
  } catch { /* the picker is a convenience; the publish panel still works */ }
}

/* Source link — the writer can type it, not only inherit it from a scrape.

   state.sourceUrl had exactly one writer before this: runScrape(). A
   hand-written post could never record where it came from, and reopening a
   saved post showed no trace of the stored link.

   Two ordering traps, both of which cost the value silently:
     - startNewPix() clears state.sourceUrl, and it runs INSIDE the "Build
       Poster" handler, so this listener must own the field afterwards rather
       than the handler reading it before.
     - loadPixIntoEditor() restores state but refills only the headline and
       paragraph inputs, so the box has to be refilled explicitly or it looks
       empty over a post that has one. */
const sourceUrlEdit = document.getElementById("source-url-edit");

/* Open the section, scroll to it and focus. Telling someone a field is
   required and leaving them to find it — inside a collapsed accordion, in a
   three-column editor — is most of the annoyance of a required field. */
function focusSourceLink() {
  if (!sourceUrlEdit) return;
  const acc = sourceUrlEdit.closest(".acc");
  if (acc) acc.dataset.open = "true";
  sourceUrlEdit.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => sourceUrlEdit.focus(), 320);
}
if (sourceUrlEdit) {
  sourceUrlEdit.addEventListener("input", () => {
    state.sourceUrl = sourceUrlEdit.value.trim();
  });
}

/* Keep the box and the state in step wherever either changes. */
function syncSourceUrlInput() {
  if (sourceUrlEdit && sourceUrlEdit.value.trim() !== (state.sourceUrl || "")) {
    sourceUrlEdit.value = state.sourceUrl || "";
  }
}

/* Search is a server round-trip, so it is debounced — every keystroke firing a
   query would put the list into a race where an early, slower response lands
   after a later one and overwrites it with stale rows. */
const reviewSearchInput = document.getElementById("review-search");
if (reviewSearchInput) {
  let searchTimer = null;
  reviewSearchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadReviewQueue(), 300);
  });
  // Enter searches immediately rather than waiting out the debounce.
  reviewSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); clearTimeout(searchTimer); loadReviewQueue(); }
  });
}

/* ── Review stats ──

   The counts object goes in whole and THIS function decides which fields to
   show. The previous shape let the caller pick — it passed written_today and
   the renderer labelled it "Reviewed today" — so a reviewer saw their writing
   count under a reviewing label: 0 beside a chip reading 42. A label and the
   number under it were being chosen in two different places, which is a shape
   that can always drift. One place now.

   A reviewer gets three numbers because they do three distinct things, and
   the difference between them is the point: 57 approved, 21 rejected and 42
   published in a day are all true at once and none substitutes for another.
   A writer gets one, because they do one.

   Day and week figures come from the server, which counts the whole library;
   the verdict split is derived from the rows on screen and describes exactly
   what is listed below. */
function renderReviewStats({ counts, approved, rejected, awaiting, drafts, published, total, filtered }) {
  const host = document.getElementById("review-list");
  if (!host) return;
  let strip = document.getElementById("review-stats");
  if (!strip) {
    strip = document.createElement("div");
    strip.id = "review-stats";
    strip.className = "review-stats";
    host.parentNode.insertBefore(strip, host);
  }

  /* First paint can beat the counts request — the view opens, the list loads,
     and lastPixCounts is still null, so the personal tiles would render empty
     and stay that way until something else refreshed them. Ask, then redraw
     once. Guarded so the redraw cannot ask again and loop. */
  if (!lastPixCounts && state.user && !renderReviewStats._awaiting) {
    renderReviewStats._awaiting = true;
    refreshMyPixCount().finally(() => {
      renderReviewStats._awaiting = false;
      if (document.body.classList.contains("view-review")) loadReviewQueue();
    });
  }

  const reviewer = canReviewRole(state.user?.role);
  const tile = (label, value, tone = "", title = "") =>
    value === undefined || value === null
      ? ""
      : `<div class="review-stat${tone ? " is-" + tone : ""}"${title ? ` title="${title}"` : ""}>
           <span class="review-stat-value">${formatCount(value)}</span>
           <span class="review-stat-label">${label}</span>
         </div>`;

  /* Several people hold both roles — they review the queue AND write their own
     stories. Showing a reviewer only their verdicts meant that half of their
     day simply had no number anywhere on their screen, while the same work
     done by a writer was counted. The tile appears when they have actually
     written something, so a reviewer who never writes is not given a
     permanent zero to explain. */
  const alsoWrites = reviewer && (Number(counts?.written_week) || Number(counts?.written_total));

  const own = reviewer
    ? [
        tile("Reviewed today", counts?.reviewed_today, "",
             "Posts you approved or rejected today. A post you did both to counts once."),
        tile("Published today", counts?.published_today, "published",
             "Sent to DailyMattr by you today"),
        alsoWrites ? tile("Written today", counts?.written_today, "",
             "Posts you wrote yourself today — counted the same way a writer's are") : "",
        tile("Reviewed this week", counts?.reviewed_week),
        alsoWrites ? tile("Written this week", counts?.written_week) : "",
      ]
    : [
        tile("Submitted today", counts?.written_today, "",
             "Posts you handed to QA today. Drafts are not counted."),
        tile("Submitted this week", counts?.written_week),
      ];

  /* Under a filter the verdict tiles would restate the filter back at you —
     "5 rejected" beside a list showing only rejected posts. The personal
     figures stay: they describe the day, not the list. */
  strip.innerHTML = [
    ...own,
    filtered ? "" : tile("Approved", approved, "approved"),
    filtered ? "" : tile("Rejected", rejected, "rejected"),
    filtered ? "" : tile("Awaiting QA", awaiting, "awaiting"),
    /* Only when there is one. A permanent zero here would read as "publishing
       is broken" on a library that simply has not sent anything yet, and the
       tile is a way in to the Published tab rather than a target. */
    filtered ? "" : (published ? tile("Published", published, "published",
         "On DailyMattr. Open one to send a corrected copy — their API has no edit.") : ""),
    filtered ? "" : (drafts ? tile("Drafts", drafts, "draft") : ""),
    filtered ? tile("Shown", total) : "",
  ].filter(Boolean).join("");
  strip.hidden = !strip.innerHTML;
}

async function loadReviewQueue() {
  if (!reviewList || !state.user) return;
  setReviewStatus("Loading…");
  reviewList.innerHTML = "";

  /* 200 is the server's ceiling. It was 100 against a library that has passed
     220 posts, so the oldest 120 were unreachable — ordered newest first, a
     writer's submission simply fell off the end of QA's list as newer ones
     arrived, which reads exactly like "my post never showed up".
     Hitting even this ceiling is reported below rather than hidden. */
  const PAGE_LIMIT = 200;
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  // `status` rather than `approved`: the queue has three states now, and a
  // boolean cannot say "rejected".
  /* "mine" is a scope, not a status — it narrows WHOSE posts are listed rather
     than which stage they are at, so it travels as `user` and leaves `status`
     unset. The server has taken ?user= all along (the analytics Writers screen
     uses it); the review list simply never asked, which is why a reviewer who
     also writes could not find their own work in a library of everyone's. */
  if (reviewFilter === "mine") {
    if (state.user?.id) params.set("user", String(state.user.id));
  } else if (reviewFilter !== "all") {
    params.set("status", reviewFilter);
  }
  const term = (reviewSearchInput?.value || "").trim();
  if (term) params.set("q", term);

  try {
    const response = await fetch(`/api/pix?${params}`, { credentials: "same-origin" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) return handleSignedOut();
      setReviewStatus(payload.error || `Could not load the queue (${response.status}).`, "error");
      return;
    }

    const posts = payload.posts || [];
    if (!posts.length) {
      const empty = document.createElement("li");
      empty.className = "review-empty";
      empty.textContent = reviewFilter === "mine"
        ? "You have not written a post yet. Build one, then press Save."
        : reviewFilter === "published"
        ? "Nothing has been published to DailyMattr yet."
        : reviewFilter === "approved"
        ? "Nothing approved yet."
        : reviewFilter === "rejected"
          ? "Nothing rejected."
          : reviewFilter === "awaiting"
            ? "Nothing waiting — every saved post has a verdict."
            /* Drafts are the viewer's own, whoever is looking, so this line is
               about them and not about the library. */
            : reviewFilter === "drafts"
              ? "No drafts of yours — everything you have saved has been submitted."
              : canReviewRole(state.user?.role)
                ? "No posts saved yet."
                : "You have not saved a post yet. Build one, then press Save.";
      reviewList.appendChild(empty);
      /* Redraw the tiles on the empty path too. Returning early left the
         PREVIOUS filter's numbers sitting above an empty list — "3 approved"
         over "no drafts of yours" — which reads as a contradiction rather
         than as a stale panel. Today and this week still stand: they are
         facts about the day, not about whatever is listed. */
      renderReviewStats({
        counts: lastPixCounts,
        approved: 0, rejected: 0, awaiting: 0, drafts: 0, published: 0,
        total: 0,
        filtered: reviewFilter !== "all",
      });
      setReviewStatus("");
      return;
    }

    /* Say so when the list is full. Silent truncation is what made the old
       100-post cap look like lost work rather than a paging limit: a writer's
       post really was missing from QA's screen, with nothing on the page
       admitting it. If this ever fills up, it says so and says what to do. */
    if (posts.length >= PAGE_LIMIT) {
      setReviewStatus(
        `Showing the ${PAGE_LIMIT} most recent — older posts are not on this page. Narrow it with a filter or the search box.`,
        "error",
      );
    }

    const approvedCount = posts.filter((p) => p.approved).length;
    const rejectedCount = posts.filter((p) => p.rejected).length;
    const publishedCount = posts.filter((p) => p.published_at).length;
    /* Drafts are counted apart from "awaiting". The All list now includes the
       viewer's own drafts, and folding them into the awaiting figure would
       report unfinished work as sitting with QA — the same false statement the
       row pill below avoids. */
    const draftCount = posts.filter((p) => isStillDraft(p)).length;
    const awaitingCount = posts.length - approvedCount - rejectedCount - draftCount;
    /* Tiles rather than one run-on sentence. The old line packed five numbers
       into a single row of small grey text, so the two a writer actually asks
       for — how much today, how much this week — were not in it at all, and
       the three that were had to be read like prose. Each figure now has its
       own label and its own place. */
    renderReviewStats({
      counts: lastPixCounts,
      approved: approvedCount,
      rejected: rejectedCount,
      awaiting: awaitingCount,
      drafts: draftCount,
      published: publishedCount,
      total: posts.length,
      filtered: reviewFilter !== "all",
    });
    setReviewStatus("");

    posts.forEach((post) => reviewList.appendChild(renderReviewItem(post)));
  } catch (err) {
    setReviewStatus(err.message || "Could not load the queue.", "error");
  }
}

/* "Still unsubmitted", matching what the server lists: a row that carries a
   verdict has left the drafts stage whatever its flag says, and the few rows
   that predate approval clearing the flag must not be relabelled Draft after
   QA has already signed them off. */
function isStillDraft(post) {
  return Boolean(post.is_draft) && !post.approved && !post.rejected;
}

/* Every DailyMattr id this post has ever produced, newest first: the copy that
   is live now, then the superseded ones still sitting on the public site
   because their API has no delete. Tolerant of a malformed column — this is
   list decoration, and a bad row must not take the whole queue down with it. */
function publishedCopies(post) {
  const history = Array.isArray(post.published_history) ? post.published_history : [];
  const past = history.map((entry) => (entry && entry.id != null ? String(entry.id) : "")).filter(Boolean);
  return post.published_id ? [String(post.published_id), ...past.reverse()] : past.reverse();
}

function renderReviewItem(post) {
  const li = document.createElement("li");
  /* Published outranks approved for the row's colour for the same reason it
     does for the pill: publishing auto-approves, so every published post is
     also an approved one, and drawing them alike is what made a live story
     impossible to pick out of the Approved list. */
  li.className = "review-item"
    + (post.published_at ? " is-published" : post.approved ? " is-approved" : post.rejected ? " is-rejected" : "");

  // The stored image is a URL, so the thumbnail is the real poster image
  // rather than a re-render — cheap, and enough to recognise a post by.
  if (post.main_image_url) {
    const thumb = document.createElement("img");
    thumb.className = "review-thumb";
    thumb.loading = "lazy";
    thumb.alt = "";
    thumb.src = `/api/image?url=${encodeURIComponent(post.main_image_url)}`;
    thumb.addEventListener("error", () => thumb.remove());
    li.appendChild(thumb);
  }

  const main = document.createElement("div");
  main.className = "review-item-main";

  const title = document.createElement("span");
  title.className = "review-item-title";
  title.textContent = post.headline || "(untitled)";

  const meta = document.createElement("span");
  meta.className = "review-item-meta";
  meta.textContent = [
    post.user_name || "unknown",
    /* Falls back to the row's own dates when the sorted-by timestamp is
       missing — a post approved before approved_at existed still has to show
       something, and an empty gap in the middle of the meta line reads as a
       rendering fault rather than as missing history. */
    (() => {
      const stamp = reviewRowStamp(post);
      const when = formatLibraryDate(stamp.at) || formatLibraryDate(post.updated_at || post.created_at);
      if (!when) return "";
      return stamp.label && stamp.at ? `${stamp.label} ${when}` : when;
    })(),
    hostOf(post.source_url),
    post.approved && post.approved_by_name ? `approved by ${post.approved_by_name}` : "",
    post.rejected && post.rejected_by_name ? `rejected by ${post.rejected_by_name}` : "",
    /* The handle for finding this story in DailyMattr's portal, which is the
       only place it can be deleted from. Named in the list rather than only
       inside the editor because that is where somebody clearing up after a
       correction is working. */
    post.published_at && post.published_id ? `DailyMattr ${post.published_id}` : "",
    post.published_at && !post.published_id ? "publish unconfirmed" : "",
  ].filter(Boolean).join(" · ");

  const pill = document.createElement("span");
  /* Draft outranks the verdict, the same way the analytics list does it: an
     unsubmitted post has no verdict to report, and "Awaiting approval" would
     tell the writer their draft is with QA when QA cannot see it at all. */
  const draft = isStillDraft(post);
  /* Published outranks approved. It is the more specific fact and the one that
     changes what QA can do next: an approved post can still be edited freely,
     a published one can only be corrected by sending a second copy. */
  const published = Boolean(post.published_at);
  pill.className = "status-pill"
    + (draft ? " is-draft" : published ? " is-published" : post.approved ? " is-approved" : post.rejected ? " is-rejected" : "");
  pill.textContent = draft ? "Draft"
    : published ? "Published"
      : post.approved ? "Approved" : post.rejected ? "Rejected" : "Awaiting approval";

  main.append(title, meta, document.createElement("br"), pill);

  /* A post that has been sent more than once has more than one copy on the
     public site, and only one of them is the current text. The count is the
     warning; the ids are in the title so whoever is tidying up can read them
     without opening the post. */
  const copies = publishedCopies(post);
  if (copies.length > 1) {
    const superseded = document.createElement("span");
    superseded.className = "status-pill is-superseded";
    superseded.textContent = `${copies.length} copies live`;
    superseded.title = `Every ID this post has produced, newest first: ${copies.join(", ")}. `
      + "Only the newest is the corrected text — the rest stay on the site until they are deleted in the DailyMattr portal.";
    main.append(document.createTextNode(" "), superseded);
  }

  const actions = document.createElement("div");
  actions.className = "review-item-actions";

  const open = document.createElement("button");
  open.type = "button";
  open.className = "btn-ghost";
  open.textContent = "Open";
  open.addEventListener("click", async () => {
    await openSavedPost(post.id);
    setView("poster");
  });

  actions.append(open);

  /* Three actions, and approving is not one of them.

     Approval is not a decision made from a list — it is made after reading the
     post, which means opening it, and publishing from the editor marks the
     post approved on the way out. A row-level Approve was therefore a second
     path to the same state that skipped the reading, and Approve & Publish put
     the one irreversible action in this app next to four reversible ones.

     Reject stays here because it is the verdict that does NOT need the editor:
     a row can be sent back on the strength of its headline and writer alone.
     Rejecting from inside the post is available too, on the editor toolbar. */
  if (canReviewRole(state.user?.role)) {
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "btn-ghost" + (post.rejected ? "" : " btn-reject");
    reject.textContent = post.rejected ? "Undo reject" : "Reject";
    reject.addEventListener("click", () => setPostVerdict(post, post.rejected ? "awaiting" : "rejected", reject));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn-ghost";
    del.textContent = "Delete";
    del.addEventListener("click", () => deleteReviewPost(post, li));

    /* Reopen, and ONLY on a post that is already approved. The row stays
       Open / Reject / Delete for everything in the queue — approving is still
       not something done from a list.

       This exists because locking an author out of an approved post created a
       dead end: the server tells them "ask QA to reopen it before editing",
       and until now there was nothing for QA to press. An instruction that
       names a control which does not exist is worse than no instruction.

       Withdrawing the approval is a verdict change, not an edit, so it goes
       through the same setPostVerdict path as Reject and lands the post back
       in Awaiting. */
    if (post.approved) {
      const reopen = document.createElement("button");
      reopen.type = "button";
      reopen.className = "btn-ghost";
      reopen.textContent = "Reopen";
      reopen.title = post.published_at
        ? "Withdraw the approval so the writer can edit — the copy already on DailyMattr will not change"
        : "Withdraw the approval and put this back in the queue so the writer can edit it";
      reopen.addEventListener("click", async () => {
        /* A published post is the one case worth a confirmation: reopening
           does not and cannot retract the live story, and someone reaching
           for this button may believe it does. */
        if (post.published_at) {
          const ok = await confirmAction({
            title: "Reopen a published post?",
            body: "The writer will be able to edit it again. The copy already on DailyMattr will NOT change — their API has no edit and no delete.",
            facts: ["Editing here will make the library disagree with the public site."],
            confirmLabel: "Reopen anyway",
            danger: true,
          });
          if (!ok) return;
        }
        setPostVerdict(post, "awaiting", reopen);
      });
      actions.append(reopen);
    }

    actions.append(reject, del);
  }
  li.append(main, actions);
  return li;
}

/* verdict: "approved" | "rejected" | "awaiting" */
async function setPostVerdict(post, verdict, button) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = { approved: "Approving…", rejected: "Rejecting…", awaiting: "Withdrawing…" }[verdict];
  try {
    const response = await fetch(`/api/pix/approve?id=${encodeURIComponent(post.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ approved: verdict === "approved", rejected: verdict === "rejected" }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) return handleSignedOut();
      setReviewStatus(payload.error || `Could not update the verdict (${response.status}).`, "error");
      button.textContent = previous;
      return;
    }
    setReviewStatus({
      approved: "Approved.",
      rejected: "Rejected.",
      awaiting: "Verdict withdrawn — back to awaiting approval.",
    }[verdict], "success");
    // Re-fetch rather than patch the row in place: under the Pending or
    // Approved filter the post has just left the list it is sitting in.
    loadReviewQueue();
    refreshMyPixCount();   // a verdict is a review, so the reviewer's tally moved
    announceCountChange();  // ...and the author's, in whichever tab they have open
  } catch (err) {
    setReviewStatus(err.message || "Could not update the verdict.", "error");
    button.textContent = previous;
  } finally {
    button.disabled = false;
  }
}

async function deleteReviewPost(post, itemEl) {
  const ok = await confirmAction({
    title: "Delete this post?",
    body: `"${post.headline || "Untitled post"}" will be removed from the library for everyone. This cannot be undone.`,
    facts: [
      `Written by ${post.user_name || "unknown"}`,
      post.approved ? "It is currently approved" : "It is still pending",
    ],
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    const response = await fetch(`/api/pix?id=${encodeURIComponent(post.id)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) return handleSignedOut();
      setReviewStatus(payload.error || `Could not delete (${response.status}).`, "error");
      return;
    }
    itemEl.remove();
    if (state.pixId === post.id) state.pixId = null;
    setReviewStatus("Deleted.", "success");
  } catch (err) {
    setReviewStatus(err.message || "Could not delete.", "error");
  }
}

/* ── Unsaved-changes indicator ──────────────────────────────────────────────
   Nothing is written until Save is pressed, so an edit made after the last
   Save — a rewritten headline, a pair of [highlight brackets], a swapped
   image — lives only in the tab. That is easy to miss, and the post looks
   fine on screen while the database still holds the previous version.

   The button says so: it reads "Save •" while the poster differs from what
   was last stored, and settles back to "Save" once they match. */

let lastSavedFingerprint = null;

/* A cheap stand-in for the whole payload. Only the fields that end up in a
   column count — `design.savedAt` is a timestamp and would make every check
   look like a change. */
/* Read off the same base-page view as collectPixPayload, and for the same
   reason: this is what decides whether the post "changed", and merely
   SELECTING another page changes live `state`. Reading `state` here made the
   dirty dot light — and the idle autosave fire — on a page click, which is
   how a blank added page's fields reached the row unattended. The two
   readings must also agree with each other: markPixSaved() records this value
   as "what is stored", so a fingerprint computed against a different page
   than the payload would never match and autosave would re-fire forever. */
function pixFingerprint(view = basePageView()) {
  const article = view.article || {};
  return JSON.stringify([
    view.headline,
    view.detailText,
    view.sourceUrl,
    describeMainImage(view).url,
    view.aspectRatio,
    view.accent,
    view.tag,
    view.headlineStyle,
    view.fontSize,
    view.imageZoom,
    view.imageOffset?.x,
    view.imageOffset?.y,
    view.logoX, view.logoY, view.logoSize,
    view.filterPreset, view.filterBrightness, view.filterContrast,
    view.filterSaturation, view.filterBlur,
    view.showTimestamp,
    article.headline, (article.bullets || []).join("|"), article.tweet,
    view.videoUrl, view.trimStart, view.trimEnd, view.videoCaption,
    // Added pages are part of the post, so editing one has to light the
    // unsaved dot the same way editing page 1 does.
    JSON.stringify(serializePages()),
  ]);
}

function markPixSaved() {
  lastSavedFingerprint = pixFingerprint();
  refreshSaveIndicator();
}

/* The button is wired to the draft path for everyone, so for a writer — whose
   handoff is the separate topbar Submit — it has to say "draft" out loud. A
   button labelled "Save" that had silently become a Submit is what let a
   half-written article reach QA; the label now cannot disagree with what the
   press does. Reviewers have no draft/submit split to explain, so they keep
   the plain word. */
function saveButtonLabel() {
  return state.user && !canReviewRole(state.user.role) ? "Save draft" : "Save";
}

function refreshSaveIndicator() {
  if (!savePixBtn || !savePixLabel) return;
  // Mid-flight labels ("Saving…", "Saved", "Updated") own the button for a
  // few seconds; leave them alone.
  if (savePixBtn.disabled || savePixBtn.classList.contains("is-saved") || savePixBtn.classList.contains("is-error")) return;

  const nothingToSave = !state.headline && !state.sourceUrl;
  const dirty = !nothingToSave && lastSavedFingerprint !== null && pixFingerprint() !== lastSavedFingerprint;
  const label = saveButtonLabel();

  savePixBtn.classList.toggle("is-dirty", dirty);
  savePixLabel.textContent = dirty ? `${label} •` : label;
  savePixBtn.title = dirty
    ? "This post has changes that are not in the library yet"
    : (label === "Save draft"
        ? "Save a draft — QA cannot see it until you press Submit"
        : "Save this post to the library");
}

/* Polled rather than wired into every control: the editor changes state from
   dozens of places — sliders, drags, chips, the AI writer, an image load —
   and a single cheap comparison is more reliable than remembering to call a
   hook from all of them. */
/* ── Reject, from the editor ──

   Shown only once the open post has a row and only to a reviewer: rejecting
   something that was never saved would have nothing to write to, and the
   button would be a dead control for every writer.

   confirmAction first. Rejection is visible to the writer and resets the
   post's standing, so it should not be one stray click away. */
const rejectPixBtn = document.getElementById("reject-pix-btn");
const rejectPixLabel = document.getElementById("reject-pix-label");

function syncRejectButton() {
  if (!rejectPixBtn) return;
  const allowed = Boolean(state.user && canReviewRole(state.user.role) && state.pixId);
  rejectPixBtn.hidden = !allowed;
}

if (rejectPixBtn) {
  rejectPixBtn.addEventListener("click", async () => {
    if (!state.pixId) return;
    const ok = await confirmAction({
      title: "Reject this post?",
      body: "It goes back to the writer as rejected. They can edit it and it returns to the queue.",
      confirmLabel: "Reject",
      danger: true,
    });
    if (!ok) return;

    rejectPixBtn.disabled = true;
    if (rejectPixLabel) rejectPixLabel.textContent = "Rejecting…";
    try {
      const response = await fetch(`/api/pix/approve?id=${encodeURIComponent(state.pixId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ approved: false, rejected: true }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) return handleSignedOut();
        setStatus(payload.error || `Could not reject that post (${response.status}).`, "error");
        return;
      }
      setStatus("Rejected — sent back to the writer.", "success");
      // The Review list is now stale by one row.
      if (typeof loadReviewQueue === "function") loadReviewQueue();
      refreshMyPixCount();
    } catch (err) {
      setStatus(err.message || "Could not reject that post.", "error");
    } finally {
      rejectPixBtn.disabled = false;
      if (rejectPixLabel) rejectPixLabel.textContent = "Reject";
    }
  });
}

/* ── Autosave ──

   Only for a post that already has a row. A new post still needs one manual
   Save, for two reasons: a writer has to choose a category before the server
   will accept it at all, so an autosave before that could only fail; and most
   experiments in this editor are never meant to be kept, so creating a row the
   moment someone types a headline would fill the library with abandoned
   drafts. Once the row exists, every later edit saves itself.

   That is exactly the case QA is in — they only ever open posts that are
   already saved — which is where edits were being lost.

   Idle-triggered rather than on a fixed timer: saving mid-sentence would write
   half a headline and, with QA editing a post a writer may also have open,
   the fewer intermediate versions written the better. */
const AUTOSAVE_IDLE_MS = 2500;
let autosaveFingerprint = null;
let autosaveDirtySince = 0;
let autosaveInFlight = false;

function considerAutosave() {
  if (!state.user || !state.pixId || autosaveInFlight) return;
  // A manual save owns the button and the row while it runs.
  if (savePixBtn?.disabled) return;
  /* So do the two other things that drive `state` themselves. Autosave can
     only ever tell "the post changed" from a fingerprint, and both of these
     change it for reasons that are not edits: an open is still restoring the
     post it is about to declare saved, and a publish is stepping the
     selection through every page to export it. Neither is a person typing. */
  if (editorLoading || publishInFlight) return;
  /* An export is already encoding this clip. ensureMediaUploaded would post
     the whole original file to /api/video/clip a SECOND time — two ffmpeg jobs
     on the same footage, two multi-hundred-megabyte uploads, from a timer
     nobody pressed. The publish button refuses for the same reason. */
  if (state.videoExporting) return;
  if (lastSavedFingerprint === null) return;

  /* ── Where autosave stops ──
     It had no notion of workflow state at all: any row it could see, it kept
     rewriting.

     A post that is approved — or already on DailyMattr, whose API has no edit
     and no delete — must not be changed by a timer. The row is the only record
     of what QA signed off and of what went out; overwriting it 2.5s after
     somebody scrolled past leaves "approved by <QA>" over text no reviewer read
     and a library that disagrees with the public site. `publishOutcomeUnknown`
     counts as published for the same reason it shuts the Publish button: the
     story may be live and nothing here can find out.

     For a writer, the line is earlier — anything that is not a draft. Once
     work has been handed over, QA may be reading it right now, and a
     background write pushes half-typed sentences under their eyes; that is the
     incident this whole audit came from. It also makes the resubmission of a
     rejected post an act rather than an accident: the server lifts a rejection
     on an explicit save (see clearRejection), and this is why an idle timer
     cannot do it for them.

     Refusing is not the same as losing the edit. The unsaved dot stays lit and
     the Save button still works — that is the point, an explicit press instead
     of an ambient one. QA keeps the manual route on an approved post too; only
     the author is locked out server-side, since only QA can reopen one. */
  if (state.approved || state.publishedAt || publishOutcomeUnknown) return;
  if (!canReviewRole(state.user.role) && !state.isDraft) return;

  const fingerprint = pixFingerprint();
  if (fingerprint === lastSavedFingerprint) {
    autosaveDirtySince = 0;
    return;
  }
  // Still changing — restart the clock so it fires after typing stops.
  if (fingerprint !== autosaveFingerprint) {
    autosaveFingerprint = fingerprint;
    autosaveDirtySince = Date.now();
    return;
  }
  if (Date.now() - autosaveDirtySince < AUTOSAVE_IDLE_MS) return;

  autosaveInFlight = true;
  /* Say the intent out loud rather than letting savePixToLibrary infer it. A
     background write must only ever re-save the post as what it already is;
     leaving the argument off made autosave inherit whatever the last resolved
     intent happened to be, which is how one mis-set flag turned an idle timer
     into a repeated submission to QA. */
  savePixToLibrary({ asDraft: state.isDraft, auto: true })
    .then((result) => {
      if (result.ok && result.videoStoreFailure) {
        /* Saved, but not with its video — so it must not read as saved.

           Autosave used to print "Saved automatically" and light "Autosaved at
           14:32" whatever happened to the clip, dropping both result.warning
           and result.videoStoreFailure on the floor. The writer saw green,
           believed the post was safe, reloaded or opened the next story, and
           the footage was gone for good: the row keeps a trim range and no
           URL, and an uploaded File does not survive a reload.

           No dialog here — a modal from a background timer would interrupt
           typing every few seconds — but the line is red, it names the clip,
           and the "saved" stamp is deliberately withheld. */
        setStatus(`Saved automatically, but the video was not: ${result.videoStoreFailure}. Press Save to try the clip again.`, "error");
      } else if (result.ok) {
        setStatus(result.warning ? `Saved automatically, but the ${result.warning}.` : "Saved automatically.",
          result.warning ? "error" : "success");
        showAutosaved(`Autosaved at ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`);
      } else {
        /* Quietly. The unsaved dot stays lit, so the state is still visible,
           and a validation failure here would otherwise reappear as a toast
           every few seconds until the writer happened to fix it. */
        console.warn("[pix] autosave skipped:", result.error);
      }
    })
    .finally(() => {
      autosaveInFlight = false;
      autosaveDirtySince = 0;
      autosaveFingerprint = null;
    });
}

setInterval(() => {
  refreshSaveIndicator();
  syncRejectButton();
  considerAutosave();
  syncDailyMattrDraft();
  syncDailyMattrMediaCount();
}, 800);

/* ── Uploaded media ─────────────────────────────────────────────────────────
   An uploaded image lives in the tab as a `data:` URL and an uploaded video as
   a File — neither has an address, so neither can go in a database row. On
   Save they are pushed to Supabase Storage first and the row keeps the URL
   that comes back.

   Uploads happen at Save, not at drop: most experiments never get saved, and
   uploading every image the moment it is dragged in would spend storage on
   posters nobody keeps. */

/* PUT a blob with progress. fetch() cannot report upload progress at all, and
   a writer staring at a still screen through a 45 MB clip has no way to tell a
   slow upload from a dead one — so this stays XHR. */
function putWithProgress(url, blob, { contentType, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    // Storage rejects a repeat PUT to the same path without this; a retry of a
    // half-finished upload must be allowed to land on its own key.
    xhr.setRequestHeader("x-upsert", "true");

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
      let detail = "";
      try { detail = JSON.parse(xhr.responseText)?.message || ""; } catch { /* not json */ }
      reject(new Error(detail || `Storage refused the upload (${xhr.status}).`));
    };
    // A dropped connection lands here rather than in onload, and it is the
    // failure that orphaned every stray clip in the bucket.
    xhr.onerror = () => reject(new Error("The connection dropped during the upload."));
    xhr.ontimeout = () => reject(new Error("The upload timed out."));
    xhr.onabort = () => reject(new Error("The upload was cancelled."));
    xhr.send(blob);
  });
}

/**
 * Store one blob and return the URL it can be read back from.
 *
 * Three steps, and the third is the one that matters: the server is asked to
 * CONFIRM the object is in the bucket before this resolves. Until that check
 * existed, "uploaded" meant "the request did not visibly fail", which is how
 * 27 clips ended up in Storage with no post pointing at them.
 *
 * The bytes go straight from here to Supabase. They no longer pass through the
 * app server, which used to hold each whole file in memory while forwarding it.
 */
async function uploadMediaBlob(blob, filename, { onProgress } = {}) {
  const contentType = blob?.type || "application/octet-stream";

  // 1. Ask for a one-shot signed URL scoped to one object path.
  const signRes = await fetch("/api/media/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ contentType, filename: filename || "upload" }),
  });

  /* An older server has no /api/media/sign. Falling back keeps a browser tab
     that is mid-shift working across a deploy instead of failing every upload
     until it is reloaded. */
  if (signRes.status === 404) return legacyUploadMediaBlob(blob, filename);

  const signed = await signRes.json().catch(() => ({}));
  if (!signRes.ok) {
    if (signRes.status === 401) handleSignedOut();
    throw new Error(signed.error || `Could not prepare the upload (${signRes.status}).`);
  }
  if (!signed.uploadUrl || !signed.key) {
    throw new Error("The server did not return an upload address.");
  }

  // 2. Straight to Storage.
  await putWithProgress(signed.uploadUrl, blob, { contentType, onProgress });

  // 3. Only now ask whether it is really there. A URL is recorded on a post
  //    only after this answers yes.
  const confirmRes = await fetch("/api/media/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ key: signed.key }),
  });
  const confirmed = await confirmRes.json().catch(() => ({}));
  if (!confirmRes.ok) {
    if (confirmRes.status === 401) handleSignedOut();
    throw new Error(confirmed.error || `The upload could not be confirmed (${confirmRes.status}).`);
  }
  if (typeof confirmed.url !== "string" || !/^https?:\/\//i.test(confirmed.url)) {
    throw new Error("The upload was not confirmed as stored.");
  }
  return confirmed.url;
}

/* The previous route: browser -> app server -> Storage. Kept only so an
   in-flight tab survives a deploy; nothing should reach for it by choice. */
async function legacyUploadMediaBlob(blob, filename) {
  const form = new FormData();
  form.append("file", blob, filename || "upload");
  const response = await fetch("/api/media", {
    method: "POST",
    credentials: "same-origin",
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) handleSignedOut();
    throw new Error(payload.error || `Upload failed (${response.status}).`);
  }
  /* A 200 is not the same as a URL. The body is parsed with .catch(() => ({})),
     so an empty, truncated or HTML response arrives here as {} and this used to
     return undefined — which the caller then filed as a "stored" clip with no
     address. */
  if (typeof payload.url !== "string" || !/^https?:\/\//i.test(payload.url)) {
    throw new Error("Upload finished but the server returned no file URL.");
  }
  return payload.url;
}

function dataUrlToBlob(dataUrl) {
  const [meta, encoded] = String(dataUrl).split(",");
  const contentType = (meta.match(/^data:([^;]+)/) || [])[1] || "application/octet-stream";
  if (!/;base64$/i.test(meta.split(";").slice(1).join(";")) && !/;base64/i.test(meta)) {
    return new Blob([decodeURIComponent(encoded)], { type: contentType });
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

/* `/api/image?url=X` is how every remote picture is loaded — the proxy is what
   makes it same-origin and therefore drawable onto a canvas. Getting X back out
   matters because the thing worth storing is the picture's real address, not
   our proxy's. */
function unwrapProxiedImageUrl(src) {
  const text = String(src || "");
  if (!/[?&]url=/.test(text)) return text;
  const encoded = (text.match(/[?&]url=([^&]+)/) || [])[1];
  if (!encoded) return text;
  try { return decodeURIComponent(encoded); } catch { return text; }
}

/* A picture we have already uploaded. Re-uploading one of these on every save
   would fill the bucket with identical copies of the same file. */
function isStoredMediaUrl(url) {
  return /\/storage\/v1\/object\/public\//.test(String(url || ""));
}

/**
 * The bytes behind whatever the canvas is currently painting.
 *
 * A data: URL carries its own bytes. Everything else is a remote address, and
 * the ONLY way a writer ever produced a data: URL was by dragging a file in —
 * a suggested image, a stock image, the scraped article image and a pasted
 * link all arrive as URLs. ensureMediaUploaded used to skip those outright, so
 * a slide illustrated by any means except drag-and-drop was saved with no
 * picture at all: the text survived, the image did not, and QA opened the
 * carousel to find empty slides. Fetching through the same proxy that loaded
 * the image keeps this same-origin and reuses its cache.
 */
async function blobForImageSrc(src) {
  const text = String(src || "");
  if (text.startsWith("data:")) return dataUrlToBlob(text);
  if (!text) throw new Error("no image source");
  const raw = unwrapProxiedImageUrl(text);
  const proxied = `/api/image?url=${encodeURIComponent(raw)}`;
  const res = await fetch(proxied, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`source unreachable (${res.status})`);
  const blob = await res.blob();
  if (!blob.size) throw new Error("source returned an empty file");
  return blob;
}

/* One slide's picture, stored and recorded. Returns the URL it settled on, or
   null when there is nothing to store. Shared by the post's own image and by
   every added page so the two can never drift apart again. */
async function storeImageForSlide(src, filename) {
  const text = String(src || "");
  if (!text) return null;
  /* Already ours — record the address rather than uploading a second copy.
     This is also what makes reopening a saved post and saving it again free:
     the image comes back as a proxy around the stored URL. */
  const raw = unwrapProxiedImageUrl(text);
  if (isStoredMediaUrl(raw)) return raw;
  return await uploadMediaBlob(await blobForImageSrc(text), filename);
}

/**
 * Make sure everything the poster shows has a URL, uploading what does not.
 *
 * Each upload is remembered against its exact source, so pressing Save five
 * times uploads once. Returns a message when something could not be stored —
 * the save still goes ahead, minus that URL, because losing the text as well
 * would make a storage outage twice as expensive.
 */
/* Set when the clip could not be stored on THIS save. Read by the caller so
   it can raise a dialog rather than a status line — see runSave. */
let videoStoreFailure = null;
/* Same contract as videoStoreFailure, for a slide picture that could not be
   stored. A carousel handed to QA with a blank slide is the image-shaped
   version of a post handed over with no clip. */
let imageStoreFailure = null;

async function ensureMediaUploaded(onProgress = () => {}) {
  const problems = [];
  videoStoreFailure = null;
  imageStoreFailure = null;

  /* The image to upload is the POST's, not the selected page's — otherwise
     saving while an added page is selected uploaded that page's picture (or,
     far more often, uploaded nothing at all because the new page has none)
     and describeMainImage then found no stored URL for the real one. Only
     this read moves to the view: storedImageFor/storedImageUrl below are not
     page-owned, so they stay on `state` where describeMainImage reads them
     back through the same view. */
  syncActivePageContent();
  if (!basePage.content) basePage.content = {};
  const src = basePageView().mainImage?.src || "";
  /* Every source, not only a dragged-in file. The old test was
     `src.startsWith("data:")`, which quietly meant "only pictures the writer
     dragged in get stored" — a suggested, stock, scraped or pasted image is a
     URL and was skipped, so the post saved with no picture. */
  if (src && basePage.content.storedImageFor !== src) {
    onProgress("Uploading image…");
    try {
      const url = await storeImageForSlide(src, "poster-image");
      /* Onto the base page, and onto `state` only when the base page is the
         one selected. Now that these are page-owned, writing them to `state`
         while an added page is open would file the POST's picture under that
         page and lose the post's own. */
      /* Re-read basePage.content AFTER the await instead of writing through a
         reference taken before it. syncActivePageContent() REPLACES the object
         (`basePage.content = { ...old, ...capture }`), and the 800ms render
         poll calls it — so an upload lasting more than one tick left the
         pre-await reference orphaned and the URL was written onto an object
         nothing would ever read again. The post's picture then saved as null
         while every page's saved fine, because the pages were not selected and
         their objects were never rebuilt. */
      if (!basePage.content) basePage.content = {};
      basePage.content.storedImageFor = src;
      basePage.content.storedImageUrl = url;
      /* Also into `state` when the SELECTED page does not own these fields.

         storedImageFor/storedImageUrl became page-owned, and a Video page is
         the one page type that owns none of the image fields. When one is
         selected, syncActivePageContent() treats every BASE field as
         un-owned and rebuilds basePage.content from `state` — which still
         mirrors the pre-upload values, because the write above deliberately
         skipped state. So the URL just uploaded was overwritten with null
         three times inside the same save, and describeMainImage then recorded
         main_image_url: null for a picture that is sitting in the bucket.

         The test is additive rather than a replacement: when the base page IS
         selected, state must still be written, or the ordinary path loses the
         URL the same way. */
      if (activePage() === basePage
          || !fieldsForPage(activePage()).includes("storedImageUrl")) {
        state.storedImageFor = src;
        state.storedImageUrl = url;
      }
    } catch (err) {
      problems.push(`image not stored (${err.message})`);
    }
  }

  /* Every added page's picture too — this is what makes a carousel survive.

     Only the post's own image was ever uploaded, so a writer could paste a
     picture into slide 2, save, and watch it vanish on reopen; QA then opened
     the post and found the carousel empty, because the pages were rebuilt
     from text and framing with no media to hang it on. The pages themselves
     were saved all along. The images were simply never sent anywhere.

     Written to page.content, not to `state`: the selected page's fields are
     swapped in and out of state as the rail is clicked, so a URL parked there
     would follow the selection instead of the page it belongs to. */
  syncActivePageContent();
  for (const page of extraPages()) {
    const content = page.content || (page.content = {});
    const pageSrc = content.mainImage?.src || "";
    /* Same correction as the post's image above, and this is the one the
       carousel complaint was actually about: a writer illustrating slide 3
       from the suggested-image strip produced a URL, not a data: URL, so the
       slide was skipped here, `imageUrl` was never written by
       serializePages(), and the reviewer opened a slide with words and no
       picture. */
    if (!pageSrc) continue;
    if (content.storedImageFor === pageSrc) continue;
    onProgress(`Uploading page ${cardNumber(page.cards[0]) || ""} image…`);
    try {
      const url = await storeImageForSlide(pageSrc, "page-image");
      // Same hazard as above: re-read rather than trust the pre-await handle.
      const fresh = page.content || (page.content = {});
      fresh.storedImageFor = pageSrc;
      fresh.storedImageUrl = url;
      /* The selected page's values live in `state`, and the next
         syncActivePageContent() rebuilds its content from there — so writing
         only to content would be undone for whichever page is on screen.
         That is precisely why the last slide a writer touched was the one
         that lost its picture. */
      if (activePage() === page) {
        state.storedImageFor = pageSrc;
        state.storedImageUrl = url;
      }
    } catch (err) {
      /* Recorded, not just listed. A slide whose picture never reached Storage
         renders as words on a blank frame, and until now that still went to QA
         with nothing to stop it — the same silent hand-over the missing clip
         used to get. */
      problems.push(`page image not stored (${err.message})`);
      imageStoreFailure = err.message || "a slide picture could not be stored";
    }
  }

  // Video: store the trim range, not the source. A 17-minute upload is far
  // over Supabase's per-file limit and nobody wants those minutes back — the
  // clip between start and end is the thing that gets published.
  await withPrimaryVideo(async () => {
    const clipKey = videoClipKey();

    /* Already stored and unchanged — nothing to do, and nothing to report.

       The URL is part of the test, not just the fingerprint. Testing the
       fingerprint alone is what turned one failed upload into "video never
       works": the moment a clip was stamped as stored without an address,
       every later save took this early return, uploaded nothing, reported
       nothing, and wrote another row with a trim range and no clip. Requiring
       the URL means a poisoned post retries instead of failing silently for
       ever. resolvePublishClipFromState already tests both (app.js:8089). */
    if (clipKey && state.storedVideoFor === clipKey && state.storedVideoUrl) return;

    /* No key, but there IS a video page. This used to `return` alongside the
       line above, which is the quietest failure in the whole save path: the
       clip is not uploaded, nothing is pushed to `problems`, the save reports
       success, and the row is written with a trim range but no storedUrl.
       That is the exact fingerprint of four of the five video posts in the
       library — trim saved, clip absent — and it only becomes visible at
       publish time, by which point an uploaded File is long gone and the
       video cannot be recovered at all.

       videoClipKey() returns null for two reasons and both are worth naming
       rather than swallowing: no source it can identify, or a trim range that
       is not yet a range because the element has not reported its duration. */
    if (!clipKey) {
      const page = primaryVideoPage();
      const hasVideoPage = Boolean(page);
      if (!hasVideoPage) return;      // genuinely no video on this post

      const why = !(state.trimEnd > state.trimStart)
        ? "its trim range is empty — the clip may still be loading"
        : "its source is gone — an uploaded file does not survive a reload";
      console.error("[pix] clip skipped, no key:", {
        why, trimStart: state.trimStart, trimEnd: state.trimEnd,
        hasFile: !!state.videoFile, videoUrl: state.videoUrl, stored: state.storedVideoUrl,
      });
      problems.push(`video not stored (${why})`);
      videoStoreFailure = why;
      return;
    }
    try {
      let blob = state.renderedClip?.key === clipKey ? state.renderedClip.blob : null;
      if (!blob) {
        onProgress("Rendering clip…");
        blob = await renderTrimmedClip({ onStatus: (m) => onProgress(m) });
        state.renderedClip = { blob, key: clipKey };
      }
      /* One retry. The measured failure is a large clip whose bytes reach
         Storage while the client never gets a usable response back — the
         object lands, the reference does not. A second attempt costs one
         upload and recovers the case that produced every orphan in the
         bucket. Two attempts, not a loop: if it fails twice the writer needs
         to be told, not kept waiting. */
      /* Raw, uncompressed, whatever size the writer's clip is. Compression
         belongs at publish, where DailyMattr's own cap applies — squeezing it
         here would degrade the master copy for a limit that is not ours. */
      const mb = (blob.size / 1048576).toFixed(1);
      onProgress(`Uploading video (${mb} MB)…`);
      const track = (pct) => onProgress(`Uploading video (${mb} MB) — ${pct}%`);

      let url;
      try {
        url = await uploadMediaBlob(blob, "slide2.mp4", { onProgress: track });
      } catch (first) {
        console.warn("[pix] clip upload failed, retrying once:", first);
        onProgress("Upload failed — retrying…");
        url = await uploadMediaBlob(blob, "slide2.mp4", { onProgress: track });
      }
      /* Stamp only once the address is real. Setting storedVideoFor next to a
         null URL is what the early return above then treats as "done". */
      if (typeof url !== "string" || !url) {
        throw new Error("the upload returned no URL");
      }
      state.storedVideoFor = clipKey;
      state.storedVideoUrl = url;
    } catch (err) {
      /* Logged in full as well as reported: the message reaching the user is
         one line, but diagnosing an encode failure needs the whole thing. */
      console.error("[pix] clip not stored:", err);
      problems.push(`video not stored (${err.message})`);
      videoStoreFailure = err.message || "the clip could not be prepared";
    }
  });

  return problems;
}

/* Identifies one rendered clip: the source, the range, and everything else
   that changes the pixels. Same key means the stored clip is still correct,
   so Save neither re-encodes nor re-uploads. Null when there is no video. */
function videoClipKey() {
  /* storedVideoUrl is the third source and it used to be missing, which is
     why reopened posts published their images and no video.

     A video added by UPLOAD has no source URL — sourceKind "file", and the
     File object itself does not survive a reload. So on reopening such a post
     videoFile is null and videoUrl is "", both earlier branches fell through,
     and this returned null. resolvePublishClip() bails immediately on a null
     key, so the clip was skipped silently — even though the trimmed copy was
     sitting in our bucket, playing in the preview the whole time. */
  const source = state.videoFile
    ? `file:${state.videoFile.name}:${state.videoFile.size}:${state.videoFile.lastModified}`
    : (state.videoUrl ? `url:${state.videoUrl}`
      : (state.storedVideoUrl ? `stored:${state.storedVideoUrl}` : ""));
  if (!source) return null;
  if (!(state.trimEnd > state.trimStart)) return null;
  return [
    source,
    state.trimStart.toFixed(2),
    state.trimEnd.toFixed(2),
    state.videoMuted ? "muted" : "sound",
    (state.videoFocus?.x ?? 0.5).toFixed(3),
    (state.videoFocus?.y ?? 0.5).toFixed(3),
    state.videoCaption || "",
    state.videoCaptionSize,
    state.aspectRatio,
  ].join("|");
}

/* Put a stored video back on screen when a saved post is reopened. The
   <video> element takes the bucket URL directly — same element, same trim
   controls, same canvas preview as a local file. */
/* The video panel as a reviewer needs it: open and saying what is attached. */
function openVideoPanelForReview() {
  const acc = document.getElementById("video-acc");
  if (acc && acc.dataset.open !== "true") {
    acc.dataset.open = "true";
    acc.querySelector(":scope > .acc-head")?.setAttribute("aria-expanded", "true");
  }

  const name = state.videoFileName || "";
  if (videoFileLabel) {
    videoFileLabel.textContent = name || "Upload a replacement video";
  }

  // Existing URL-backed posts remain playable, but replacement is upload-only.
  const label = name || (state.videoSourceKind === "link" ? "a legacy linked video" : "an uploaded file");
  const length = state.trimEnd > state.trimStart
    ? ` · ${formatTimecode(state.trimEnd - state.trimStart)}`
    : "";
  setVideoStatus(`Video from ${label}${length}. Play it below, re-trim it, or replace it by uploading a file.`, "success");
}

function restoreStoredVideo(video) {
  const url = video?.storedUrl || "";
  if (!url || !videoPreviewEl) return;

  state.videoUrl = video.url || "";
  state.storedVideoUrl = url;
  state.videoFile = null;
  state.videoSourceKind = video.sourceKind || "file";
  state.videoFileName = video.fileName || video.title || "";
  state.videoMuted = Boolean(video.muted);
  state.videoCaption = video.caption || "";
  state.videoCaptionSize = numberOr(video.captionSize, state.videoCaptionSize);
  state.videoFocus = {
    x: numberOr(video.focus?.x, 0.5),
    y: numberOr(video.focus?.y, 0.5),
  };

  videoPreviewEl.poster = "";
  videoPreviewEl.crossOrigin = "anonymous";
  videoPreviewEl.src = url;
  videoPreviewEl.addEventListener("loadedmetadata", () => {
    const duration = videoPreviewEl.duration || 0;
    setupTrimRange(duration);
    // The stored file is the already-cut clip, so its range is the whole
    // thing; the original start/end refer to timestamps it no longer has.
    if (video.storedTrimmed) {
      state.trimStart = 0;
      state.trimEnd = duration;
    } else {
      const start = numberOr(video.trimStart, 0);
      const end = numberOr(video.trimEnd, duration);
      if (end > start) {
        state.trimStart = start;
        state.trimEnd = end;
      }
    }
    // The bucket copy IS the current clip until somebody edits the trim,
    // caption or framing. Stamping its key here lets the publish path reuse
    // those bytes instead of re-encoding from state.videoUrl — which points at
    // the ORIGINAL source (a YouTube link or an expiring signed URL) and is
    // frequently gone, or needs yt-dlp all over again, by the time QA publishes.
    state.storedVideoFor = videoClipKey();
    if (typeof syncTrimUI === "function") syncTrimUI();
    if (videoEditor) videoEditor.hidden = false;

    /* Hand the reviewer a working video panel, not a collapsed one.

       Everything needed to play, scrub, re-trim and replace the clip already
       existed — the <video> carries native controls, the trim sliders and the
       source tabs are right there — but the Video accordion restores CLOSED,
       the source tab always read "Paste Link" regardless of how the video was
       added, and the file row still said "Choose a video file". So a reviewer
       opening a post with a video was shown no player, no indication of what
       the writer had attached, and the wrong tab for replacing it.

       Opened only when the post actually has a clip, so it does not push
       itself in front of every ordinary post. */
    openVideoPanelForReview();

    /* Decode a frame before painting, or the card paints black.

       readyState 4 does NOT mean there is a frame to draw. A <video> that has
       just had its src set, has never played, and sits at currentTime 0 has
       nothing decoded yet — drawImage then draws nothing and the video card
       comes out solid black, while duration, readyState, currentSrc and the
       clip key are all perfectly correct. That is precisely what QA was
       looking at: the clip was stored, fetchable and loaded, and the slide
       showed a black rectangle, so the video appeared not to be there at all.

       A seek forces the decode. It has to be a seek to somewhere the element
       is NOT already sitting, because assigning currentTime the value it
       already holds fires no event and decodes nothing — which is why
       trimStart 0, the normal case for an already-trimmed stored clip, was the
       one that stayed black. `seeked` is the moment there is something to
       draw, so that is when it repaints. */
    videoPreviewEl.addEventListener("seeked", () => renderPoster(), { once: true });
    try {
      const start = numberOr(state.trimStart, 0);
      videoPreviewEl.currentTime = start > 0
        ? start
        : Math.min(0.05, (state.trimEnd || 1) / 2);
    } catch { /* the render below still runs; worst case is the old behaviour */ }

    renderPoster();
  }, { once: true });

  /* The other outcome, which had no listener at all. When the bucket object
     has been pruned, its signature has expired, or CORS blocks it,
     loadedmetadata never fires — so trimEnd stays 0, videoClipKey() stays
     null, and the clip is unavailable to the publish path from the moment the
     post is opened. That used to surface as a story going out without its
     video; it now surfaces as an abort at publish time, which is safe but
     still several minutes of QA's work too late. Say it here, while there is
     still time to re-add the clip. */
  videoPreviewEl.addEventListener("error", () => {
    /* One <video> element is shared by every page, so a listener left over
       from an earlier restore must not report on a clip that has since been
       swapped out — the message would name a problem the writer cannot see. */
    const loaded = videoPreviewEl.currentSrc || videoPreviewEl.getAttribute("src") || "";
    if (loaded !== url) return;
    setVideoStatus(
      "The stored clip could not be loaded — it may have been removed from storage. Re-add the video before publishing.",
      "error",
    );
    setStatus("Opened, but this post's stored video could not be loaded — re-add it before publishing.", "error");
  }, { once: true });
}

/* Session check starts here — last line of the module, so every const/let
   above is initialised before setAuthState can touch it. See the note beside
   the state object for why this is not at the top. */
initAuth();

// Edit Writer Dialog Logic
const editWriterDialog = document.getElementById("edit-writer-dialog");
const editWriterForm = document.getElementById("edit-writer-form");
const editWriterUsername = document.getElementById("edit-writer-username");
const editWriterDisplay = document.getElementById("edit-writer-display");
const editWriterRole = document.getElementById("edit-writer-role");
const editWriterError = document.getElementById("edit-writer-error");
const editWriterCancel = document.getElementById("edit-writer-cancel");

window.openEditWriterDialog = function(user) {
  if (!editWriterDialog) return;
  window.currentEditingWriter = user.username;
  editWriterUsername.value = user.username;
  editWriterDisplay.value = user.displayName || "";
  editWriterRole.value = user.role || "writer";
  editWriterError.hidden = true;
  editWriterDialog.showModal();
};

if (editWriterCancel) {
  editWriterCancel.addEventListener("click", () => editWriterDialog.close());
}

if (editWriterForm) {
  editWriterForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!window.currentEditingWriter) return;
    try {
      await usersRequest("/api/users/update", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          oldUsername: window.currentEditingWriter,
          username: editWriterUsername.value,
          displayName: editWriterDisplay.value,
          role: editWriterRole.value
        }),
      });
      editWriterDialog.close();
      setWritersStatus(`Updated ${editWriterUsername.value}.`, "success");
      loadWriters();
    } catch (err) {
      editWriterError.textContent = err.message;
      editWriterError.hidden = false;
    }
  });
}
