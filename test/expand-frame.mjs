/* ── The geometry behind a generative expand ─────────────────────────────────

   Run: node test/expand-frame.mjs

   Expand is the feature that shipped broken twice, and both times the fault
   was the same shape: the model was ASKED, in prose, to place the photograph
   inside a larger frame, and it answered by drawing the photograph as an
   object — a framed print, hard white border and all — sitting in a scene it
   invented around it. Two posters went out that way.

   The fix is that placement stopped being a request. The browser composites
   the picture onto a frame of exactly the size the server resolved, sends an
   alpha mask that is opaque over the picture, and pastes the source back over
   whatever returns. None of that is negotiable by the model, and none of it
   needs an API key to check — it is arithmetic, which is the whole point.

   So this file holds the guarantees to the wall:

     the picture fits          a placement that runs off the edge of the frame
                               is a crop, and cropping is the opposite of the
                               job expand exists to do
     more pull-back is smaller a "wide" expand that fills more of the frame
                               than a "slight" one has the control backwards
     never blown up            the output is a fixed size, so scaling past
                               contain spends resolution to gain nothing
     people get room BELOW     a subject cut at the chest needs the torso, not
                               empty sky over their head
     the mask covers the photo transparent means "you may paint here". If the
                               opaque rectangle does not sit inside the
                               picture, the model is being invited to repaint
                               the picture, which is exactly the bug
     the source is pasted back layer 4 is the only actual guarantee in the
                               pipeline: hard-edged, pixel-exact, at the rect
                               this file chose                                */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const app = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "public", "app.js"),
  "utf8",
);

function fnSrc(name) {
  const a = app.indexOf("function " + name);
  if (a < 0) throw new Error("missing function " + name);
  let k = app.indexOf(") {", a) + 2, d = 0;
  for (let j = k; j < app.length; j++) {
    if (app[j] === "{") d++;
    else if (app[j] === "}") { d--; if (!d) return app.slice(a, j + 1); }
  }
  throw new Error("unbalanced braces in " + name);
}

const MARGIN_AREA = JSON.parse(
  app.match(/^const EXPAND_MARGIN_AREA = (\{[^}]+\});/m)[1]
    .replace(/(\w+):/g, '"$1":'),
);
const TOP_BIAS = JSON.parse(
  app.match(/^const EXPAND_TOP_BIAS = (\{[^}]+\});/m)[1]
    .replace(/(\w+):/g, '"$1":'),
);

/* A canvas that records instead of drawing. Every call the real code makes is
   logged in order, so the assertions below can read what WOULD have been
   painted without a DOM, a GPU or a headless browser. */
function fakeCanvas() {
  const ops = [];
  const cv = {
    width: 0,
    height: 0,
    ops,
    getContext: () => ({
      ops,
      save() {}, restore() {},
      set filter(v) {}, get filter() { return "none"; },
      set fillStyle(v) { ops.push(["fillStyle", v]); }, get fillStyle() { return "#000"; },
      set globalCompositeOperation(v) { ops.push(["gco", v]); },
      get globalCompositeOperation() { return "source-over"; },
      fillRect: (...a) => ops.push(["fillRect", ...a]),
      drawImage: (...a) => ops.push(["drawImage", ...a]),
      createLinearGradient: () => ({ addColorStop() {} }),
    }),
  };
  return cv;
}

const made = [];
const documentStub = {
  createElement(tag) {
    if (tag !== "canvas") throw new Error("unexpected element " + tag);
    const cv = fakeCanvas();
    made.push(cv);
    return cv;
  },
};

/* The card's own numbers, read from the same place the renderer reads them,
   because the point of the safe-rect assertions below is that two pieces of
   arithmetic in app.js agree with each other. A copy of either here would let
   them drift apart and still pass. */
const HEADROOM = Number(app.match(/^const IMAGE_PAN_HEADROOM = ([\d.]+);/m)[1]);
const PRESETS = Object.fromEntries(
  [...app.matchAll(/^\s{2}"(\d+:\d+)": \{[\s\S]*?W: (\d+),\s*H: (\d+),/gm)]
    .map(([, k, w, h]) => [k, { W: Number(w), H: Number(h) }]),
);

/* posterVisibleRect() reads the live preset through getLayout(); the ratio
   under test is injected by swapping what that returns. */
let activePreset = PRESETS["9:16"];

const api = new Function(
  "document", "EXPAND_MARGIN_AREA", "EXPAND_TOP_BIAS", "IMAGE_PAN_HEADROOM", "getLayout", `
    ${fnSrc("planExpandPlacement")}
    ${fnSrc("fillExpandBleed")}
    ${fnSrc("buildExpandFrame")}
    ${fnSrc("composeExpandResult")}
    ${fnSrc("posterVisibleRect")}
    ${fnSrc("expandOutputScale")}
    const EXPAND_COMMIT_ZOOM = ${app.match(/^const EXPAND_COMMIT_ZOOM = (.+);$/m)[1]};
    const EXPAND_MAX_EDGE = ${app.match(/^const EXPAND_MAX_EDGE = (\d+);$/m)[1]};
    return {
      planExpandPlacement, buildExpandFrame, composeExpandResult,
      posterVisibleRect, expandOutputScale,
      EXPAND_COMMIT_ZOOM, EXPAND_MAX_EDGE,
    };
  `,
)(documentStub, MARGIN_AREA, TOP_BIAS, HEADROOM, () => activePreset);

let pass = 0, fail = 0;
const ck = (n, c, d = "") => {
  if (c) { pass++; console.log("  PASS " + n); }
  else { fail++; console.log("  FAIL " + n + " :: " + d); }
};

// The three shapes gpt-image-1.5 actually sells, and the sources that hurt.
const FRAMES = [["portrait", 1024, 1536], ["landscape", 1536, 1024], ["square", 1024, 1024]];
const SOURCES = [
  ["16:9 press photo", 1536, 864],
  ["4:3 upload", 1200, 900],
  ["square logo", 1000, 1000],
  ["9:16 phone shot", 864, 1536],
  ["panorama", 1536, 320],
  ["tiny crop", 400, 300],
];
const AMOUNTS = ["slight", "moderate", "wide"];
const SUBJECTS = ["people", "scene", "graphic"];

console.log("\nThe picture always lands wholly inside the frame");
for (const [fl, fw, fh] of FRAMES) {
  for (const [sl, sw, sh] of SOURCES) {
    for (const amount of AMOUNTS) {
      for (const subject of SUBJECTS) {
        const p = api.planExpandPlacement(sw, sh, fw, fh, amount, subject);
        const ok = p.x >= 0 && p.y >= 0 &&
                   p.x + p.w <= fw && p.y + p.h <= fh &&
                   p.w >= 1 && p.h >= 1;
        if (!ok) {
          ck(`${sl} in ${fl} (${amount}/${subject})`, false,
             `rect ${p.x},${p.y} ${p.w}x${p.h} in ${fw}x${fh}`);
        } else { pass++; }
      }
    }
  }
}
console.log(`  PASS all ${FRAMES.length * SOURCES.length * AMOUNTS.length * SUBJECTS.length} placements stay inside the frame`);

console.log("\nAspect ratio survives the placement");
for (const [sl, sw, sh] of SOURCES) {
  const p = api.planExpandPlacement(sw, sh, 1024, 1536, "moderate", "scene");
  const want = sw / sh, got = p.w / p.h;
  ck(`${sl} keeps its shape`, Math.abs(want - got) / want < 0.02,
     `${want.toFixed(3)} vs ${got.toFixed(3)}`);
}

console.log("\nPulling back further makes the picture smaller, never larger");
for (const [sl, sw, sh] of SOURCES) {
  const areas = AMOUNTS.map((a) => {
    const p = api.planExpandPlacement(sw, sh, 1024, 1536, a, "scene");
    return p.w * p.h;
  });
  ck(`${sl}: slight >= moderate >= wide`,
     areas[0] >= areas[1] && areas[1] >= areas[2],
     areas.join(" -> "));
}

console.log("\nThe source is never scaled up past contain");
for (const [fl, fw, fh] of FRAMES) {
  for (const [sl, sw, sh] of SOURCES) {
    const contain = Math.min(fw / sw, fh / sh);
    const p = api.planExpandPlacement(sw, sh, fw, fh, "moderate", "scene");
    // +1px of slack for the rounding in planExpandPlacement.
    ck(`${sl} in ${fl}`, p.w <= sw * contain + 1 && p.h <= sh * contain + 1,
       `${p.w}x${p.h} vs contain ${Math.round(sw * contain)}x${Math.round(sh * contain)}`);
  }
}

console.log("\nA person gets the room below them, not above");
{
  const p = api.planExpandPlacement(1200, 900, 1024, 1536, "moderate", "people");
  const above = p.y, below = 1536 - (p.y + p.h);
  ck("more margin below than above", below > above, `${above} above, ${below} below`);

  for (const subject of ["scene", "graphic"]) {
    const q = api.planExpandPlacement(1200, 900, 1024, 1536, "moderate", subject);
    const a = q.y, b = 1536 - (q.y + q.h);
    ck(`${subject} is centred`, Math.abs(a - b) <= 1, `${a} vs ${b}`);
  }
}

console.log("\nThe blend band stays inside its bounds and inside the picture");
for (const [sl, sw, sh] of SOURCES) {
  const p = api.planExpandPlacement(sw, sh, 1024, 1536, "moderate", "scene");
  ck(`${sl} band ${p.band}px`,
     p.band >= 4 && p.band <= 24 && p.band * 2 < Math.min(p.w, p.h),
     `band ${p.band}, rect ${p.w}x${p.h}`);
}

console.log("\nThe frame is opaque before the picture goes on it");
{
  made.length = 0;
  const src = { width: 1536, height: 864 };
  const place = api.planExpandPlacement(1536, 864, 1024, 1536, "moderate", "scene");
  const { frame, mask } = api.buildExpandFrame(src, place);

  ck("frame is exactly the resolved size",
     frame.width === 1024 && frame.height === 1536,
     `${frame.width}x${frame.height}`);

  const draws = frame.ops.filter((o) => o[0] === "drawImage");
  ck("bleed is laid down before the picture", draws.length >= 3,
     `${draws.length} draws (expect cover, blurred cover, then the source)`);

  // The last draw onto the frame is the sharp source at its rect.
  const last = draws[draws.length - 1];
  ck("the source lands at the planned rect",
     last[2] === place.x && last[3] === place.y &&
     last[4] === place.w && last[5] === place.h,
     `drew at ${last[2]},${last[3]} ${last[4]}x${last[5]} — planned ${place.x},${place.y} ${place.w}x${place.h}`);

  console.log("\nThe mask lets the model paint the margin and nothing else");
  ck("mask matches the frame", mask.width === 1024 && mask.height === 1536,
     `${mask.width}x${mask.height}`);

  const rect = mask.ops.find((o) => o[0] === "fillRect");
  ck("mask has an opaque region at all", Boolean(rect), "no fillRect recorded");
  if (rect) {
    const [, mx, my, mw, mh] = rect;
    ck("opaque region is inset by the band, not outset",
       mx === place.x + place.band && my === place.y + place.band &&
       mw === Math.max(1, place.w - place.band * 2) &&
       mh === Math.max(1, place.h - place.band * 2),
       `${mx},${my} ${mw}x${mh}`);
    ck("opaque region sits strictly inside the picture",
       mx >= place.x && my >= place.y &&
       mx + mw <= place.x + place.w && my + mh <= place.y + place.h,
       `mask ${mx},${my} ${mw}x${mh} vs picture ${place.x},${place.y} ${place.w}x${place.h}`);
    ck("the margin is left paintable",
       mx > 0 || my > 0 || mx + mw < mask.width || my + mh < mask.height,
       "the mask covers the whole frame — nothing could be expanded");
  }
}

console.log("\nWhatever the model returns, the source is pasted back over it");
{
  made.length = 0;
  const src = { width: 1536, height: 864 };
  const base = { width: 1024, height: 1536 };
  const place = api.planExpandPlacement(1536, 864, 1024, 1536, "moderate", "scene");
  const result = { width: 1024, height: 1536 };
  const out = api.composeExpandResult(result, src, base, place);

  const draws = out.ops.filter((o) => o[0] === "drawImage");
  const final = draws[draws.length - 1];
  ck("the LAST thing drawn is the source itself", final[1] === src,
     "something else was drawn over the photograph");
  ck("and at exactly the planned rect",
     final[2] === place.x && final[3] === place.y &&
     final[4] === place.w && final[5] === place.h,
     `${final[2]},${final[3]} ${final[4]}x${final[5]}`);
  ck("the base frame goes down first", draws[0][1] === base,
     "the opaque frame is not layer 1 — a hole in the return could reach the canvas");

  // A refused or empty return must still produce a usable picture.
  made.length = 0;
  const out2 = api.composeExpandResult(null, src, base, place);
  const d2 = out2.ops.filter((o) => o[0] === "drawImage");
  ck("a null model return still composites", d2.length >= 2, `${d2.length} draws`);
  ck("and still ends with the source", d2[d2.length - 1][1] === src);
}

/* ── The part the card actually shows ────────────────────────────────────

   Everything above proves the photograph lands whole inside the file the
   model returns. That was never the same claim as landing whole on the
   poster, and the gap between the two is where an expand could come back
   correct and still arrive with a person cut off at the edge.

   gpt-image sells 1024x1536 for a 9:16 card. The card is 920x1700. Cover
   scaling clips the difference — about a fifth of the width, a quarter once
   the pan headroom is in — and the photograph, placed at contain scale, was
   the thing sitting across that boundary. The generated margin, drawn for
   exactly this purpose, was in the middle where nothing was cutting it.

   So the assertions here re-implement drawCoverImage rather than call
   posterVisibleRect() twice. If the placement's idea of the visible area and
   the renderer's ever diverge, that is the bug this section exists to catch,
   and asking one of them to check itself would not catch it. */

// gpt-image's three output shapes, per poster ratio — sizeForExpand() in
// server.mjs, which is the only thing that chooses between them.
const EXPAND_SIZES = {
  "9:16": [1024, 1536],
  "4:5":  [1024, 1536],
  "1:1":  [1024, 1024],
  "16:9": [1536, 1024],
};

/* drawCoverImage(), reduced to the question "what of this image is on the
   card": same base scale, same headroom, same centred focal point, same
   clamp. Returns the visible window in the image's own pixels. */
function shownOnCard(imgW, imgH, preset, zoomPct) {
  const base = Math.max(preset.W / imgW, preset.H / imgH);
  const scale = base * (zoomPct / 100) * HEADROOM;
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  let dx = (preset.W - drawW) / 2;
  let dy = (preset.H - drawH) / 2;
  if (drawW >= preset.W) dx = Math.min(Math.max(dx, preset.W - drawW), 0);
  if (drawH >= preset.H) dy = Math.min(Math.max(dy, preset.H - drawH), 0);
  return {
    x: -dx / scale,
    y: -dy / scale,
    w: preset.W / scale,
    h: preset.H / scale,
    drawW,
    drawH,
  };
}

console.log("\nThe expanded frame still covers the card at its committed zoom");
for (const [ratio, [fw, fh]] of Object.entries(EXPAND_SIZES)) {
  const preset = PRESETS[ratio];
  const seen = shownOnCard(fw, fh, preset, api.EXPAND_COMMIT_ZOOM);
  ck(`${ratio}: no letterbox at ${api.EXPAND_COMMIT_ZOOM}%`,
     seen.drawW >= preset.W - 0.5 && seen.drawH >= preset.H - 0.5,
     `drew ${seen.drawW.toFixed(1)}x${seen.drawH.toFixed(1)} into ${preset.W}x${preset.H}`);
}

console.log("\nThe whole photograph survives the card's crop");
for (const [ratio, [fw, fh]] of Object.entries(EXPAND_SIZES)) {
  activePreset = PRESETS[ratio];
  const seen = shownOnCard(fw, fh, activePreset, api.EXPAND_COMMIT_ZOOM);
  for (const [sl, sw, sh] of SOURCES) {
    for (const amount of AMOUNTS) {
      for (const subject of SUBJECTS) {
        const p = api.planExpandPlacement(
          sw, sh, fw, fh, amount, subject, api.posterVisibleRect(fw, fh),
        );
        // A pixel of slack for the rounding in planExpandPlacement.
        const ok = p.x >= seen.x - 1 && p.y >= seen.y - 1 &&
                   p.x + p.w <= seen.x + seen.w + 1 &&
                   p.y + p.h <= seen.y + seen.h + 1;
        if (!ok) {
          ck(`${sl} on a ${ratio} card (${amount}/${subject})`, false,
             `photo ${p.x},${p.y} ${p.w}x${p.h} — card shows ` +
             `${seen.x.toFixed(0)},${seen.y.toFixed(0)} ` +
             `${seen.w.toFixed(0)}x${seen.h.toFixed(0)}`);
        } else { pass++; }
      }
    }
  }
}
console.log(
  `  PASS all ${Object.keys(EXPAND_SIZES).length * SOURCES.length * AMOUNTS.length * SUBJECTS.length}` +
  " photographs are wholly inside what the card shows",
);

console.log("\nThe margin absorbs the crop, so the picture keeps its width");
{
  /* The regression in one number. A 16:9 press photo of two people, expanded
     for a 9:16 card: before the safe rect it was placed across the full 1024
     of the frame, and the card kept 830 of those — 9% off each side, which on
     this photograph is a shoulder at each end. */
  activePreset = PRESETS["9:16"];
  const seen = shownOnCard(1024, 1536, activePreset, api.EXPAND_COMMIT_ZOOM);
  const p = api.planExpandPlacement(
    1536, 864, 1024, 1536, "moderate", "people", api.posterVisibleRect(1024, 1536),
  );
  const naive = api.planExpandPlacement(1536, 864, 1024, 1536, "moderate", "people");

  ck("the old placement really did overrun the card",
     naive.x < seen.x - 1 || naive.x + naive.w > seen.x + seen.w + 1,
     "nothing to fix — the naive placement already fitted");
  ck("the new one fills the visible width instead of the file's",
     Math.abs(p.w - seen.w) <= 2, `photo ${p.w}px, card shows ${seen.w.toFixed(0)}px`);
  ck("and nothing is cropped off either side",
     p.x >= seen.x - 1 && p.x + p.w <= seen.x + seen.w + 1,
     `photo spans ${p.x}..${p.x + p.w}, card shows ${seen.x.toFixed(0)}..${(seen.x + seen.w).toFixed(0)}`);
}

console.log("\nA person still gets the room below them, inside the visible area");
{
  activePreset = PRESETS["9:16"];
  const safe = api.posterVisibleRect(1024, 1536);
  const p = api.planExpandPlacement(1200, 900, 1024, 1536, "moderate", "people", safe);
  const above = p.y - safe.y;
  const below = (safe.y + safe.h) - (p.y + p.h);
  ck("more margin below than above", below > above,
     `${above.toFixed(0)} above, ${below.toFixed(0)} below`);

  for (const subject of ["scene", "graphic"]) {
    const q = api.planExpandPlacement(1200, 900, 1024, 1536, "moderate", subject, safe);
    const a = q.y - safe.y;
    const b = (safe.y + safe.h) - (q.y + q.h);
    ck(`${subject} is centred in the visible area`, Math.abs(a - b) <= 1,
       `${a.toFixed(0)} vs ${b.toFixed(0)}`);
  }
}

/* ── The photograph comes back at the writer's resolution ────────────────

   The source is downscaled to 1536px because that is the most gpt-image will
   accept as INPUT. Layer 4 pastes it back without consulting the model, so
   there was never a reason for the paste-back to inherit the API's limit —
   and while it did, the card showed an 830px photograph stretched over a
   920px frame and the 4x export invented three quarters of its pixels.

   What has to hold: the scale never invents pixels the original does not
   have, never blows past the memory and upload budget, and never renders the
   composite smaller than the frame the model was given. And at scale 1 every
   rect must round back to exactly the unscaled one, because that is the case
   every assertion above this point is written against. */

console.log("\nThe output scale respects both ceilings and the floor");
{
  const place = api.planExpandPlacement(
    1536, 864, 1024, 1536, "moderate", "people", api.posterVisibleRect(1024, 1536),
  );
  const budget = api.EXPAND_MAX_EDGE / 1536;

  const small = api.expandOutputScale({ naturalWidth: 600 }, place);
  ck("a source smaller than the placement is never blown up", small === 1,
     `scale ${small} from a 600px original into a ${place.w}px slot`);

  const exact = api.expandOutputScale({ naturalWidth: place.w * 2 }, place);
  ck("a source with 2x to give is used at 2x", Math.abs(exact - 2) < 0.01, `scale ${exact}`);

  const huge = api.expandOutputScale({ naturalWidth: 12000 }, place);
  ck("a huge original is capped by EXPAND_MAX_EDGE",
     Math.abs(huge - budget) < 0.01, `scale ${huge}, budget ${budget.toFixed(3)}`);
  ck(`and the composite stays inside ${api.EXPAND_MAX_EDGE}px`,
     Math.round(place.frameH * huge) <= api.EXPAND_MAX_EDGE,
     `${Math.round(place.frameW * huge)}x${Math.round(place.frameH * huge)}`);

  ck("a missing original falls to 1", api.expandOutputScale(null, place) === 1);
  ck("so does a source with no dimensions", api.expandOutputScale({}, place) === 1);
}

console.log("\nScaling up moves every layer together, and the source lands last");
{
  const place = api.planExpandPlacement(
    1536, 864, 1024, 1536, "moderate", "people", api.posterVisibleRect(1024, 1536),
  );
  const src = { width: 1660, height: 934 };
  const base = { width: 1024, height: 1536 };
  const result = { width: 1024, height: 1536 };

  made.length = 0;
  const out = api.composeExpandResult(result, src, base, place, 2);
  ck("the composite is rendered at the scale asked for",
     out.width === place.frameW * 2 && out.height === place.frameH * 2,
     `${out.width}x${out.height}`);

  const draws = out.ops.filter((o) => o[0] === "drawImage");
  ck("the base frame is stretched to the new size, not left at 1x",
     draws[0][1] === base && draws[0][4] === out.width && draws[0][5] === out.height,
     `${draws[0][4]}x${draws[0][5]}`);

  const final = draws[draws.length - 1];
  ck("the source is still the last thing drawn", final[1] === src);
  ck("at the placement scaled by the same factor",
     final[2] === place.x * 2 && final[3] === place.y * 2 &&
     final[4] === place.w * 2 && final[5] === place.h * 2,
     `${final[2]},${final[3]} ${final[4]}x${final[5]} — expected ` +
     `${place.x * 2},${place.y * 2} ${place.w * 2}x${place.h * 2}`);

  /* The ring is layer 3 and has to stay registered against layer 4, or it
     covers the seam in the wrong place and imports the halo it exists to
     hide. It is drawn one band up and left of the picture, at both scales. */
  const ring = draws[draws.length - 2];
  ck("the ring is still centred on the picture",
     ring[2] === place.x * 2 - Math.round(place.band * 2) &&
     ring[3] === place.y * 2 - Math.round(place.band * 2),
     `ring at ${ring[2]},${ring[3]}`);
}

console.log("\nScale 1 is the identity");
{
  const place = api.planExpandPlacement(
    1536, 864, 1024, 1536, "moderate", "people", api.posterVisibleRect(1024, 1536),
  );
  const src = { width: 830, height: 467 };
  const base = { width: 1024, height: 1536 };

  made.length = 0;
  const a = api.composeExpandResult(null, src, base, place, 1);
  made.length = 0;
  const b = api.composeExpandResult(null, src, base, place);
  ck("an explicit 1 and an omitted scale agree",
     a.width === b.width && a.height === b.height &&
     JSON.stringify(a.ops) === JSON.stringify(b.ops));
  ck("and the frame is the model's own size",
     a.width === place.frameW && a.height === place.frameH,
     `${a.width}x${a.height}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
