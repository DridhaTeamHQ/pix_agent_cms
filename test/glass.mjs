/* ── Glass and fade, checked against the real source ─────────────────────────

   Run: node test/glass.mjs        (no dependencies, no runner, exit code 1 on
                                    failure so CI can use it as-is)

   It pulls the actual functions out of public/app.js and executes them against
   a stub canvas, rather than reimplementing them — so it cannot drift into
   testing a copy. Constants are read from the source too: nothing here
   restates a number the file owns, because a test that hard-codes the value it
   is checking only proves the file was edited twice.

   What it guards, and why each one is here rather than being obvious:

     the panel is neutral        hue 33 at saturation 35 reads as brown on a
                                 photograph with nothing warm in it
     the mask is densely sampled addColorStop interpolates LINEARLY, so a curve
                                 described by a few stops is a few straight
                                 segments with a slope change at each join —
                                 Mach banding, seen as an edge where the frost
                                 begins
     the source rect is scaled   drawImage's SOURCE rectangle is not affected
                                 by the context transform, so a design-space
                                 rect against a 4x export canvas reads the
                                 top-left corner: preview right, published card
                                 wrong
     fill + fade cannot stack    the glass fill does the darkening the fade
                                 used to; both at full strength would leave no
                                 photograph at all

   Verified by mutation: reintroducing the brown, undersampling the mask,
   dropping the transform and unpinning fadeMax each make it fail. */

// Executes the REAL glass + fade out of public/app.js against stubs.
// Nothing here restates a constant the source owns: values are read from it,
// so a test cannot pass merely because the file was edited twice.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved against this file, so it runs from anywhere: `node test/glass.mjs`
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
}
// The GLASS config is one const expression spanning many lines.
const glassSrc = (() => {
  const a = app.indexOf("const GLASS = (window.GLASS");
  const tail = "}, window.GLASS));";
  return app.slice(a, app.indexOf(tail, a) + tail.length);
})();

// fadeReach/blurReach still use loose FADE_* constants alongside GLASS.
// Injected from the source rather than restated, same rule as the rest.
const fadeConsts = app
  .split(/\r?\n/)
  .filter((l) => l.startsWith("const FADE_"))
  .join("\n");

function makeCtx(log, label) {
  const stops = [];
  return {
    canvas: { __label: label }, stops, label,
    globalAlpha: 1, globalCompositeOperation: "source-over",
    imageSmoothingEnabled: false, imageSmoothingQuality: "",
    fillStyle: null, filter: "none",
    getTransform: () => log.transform,
    drawImage(...a) { log.draws.push({ ctx: label, args: a }); },
    fillRect(...a) { log.fills.push({ ctx: label, args: a }); },
    createLinearGradient(x0, y0, x1, y1) {
      log.gradients.push({ ctx: label, line: [y0, y1] });
      return { addColorStop: (p, c) => stops.push({ p, a: Number(c.match(/,([\d.]+)\)$/)[1]) }) };
    },
  };
}

function build({ transform = { a: 1, d: 1, e: 0, f: 0 }, overrides = {} } = {}) {
  const log = { draws: [], fills: [], gradients: [], contexts: [], transform };
  let n = 0;
  const doc = {
    createElement: () => {
      const c = { width: 0, height: 0, __i: n++ };
      c.getContext = () => { const cx = makeCtx(log, "off" + c.__i); log.contexts.push(cx); return cx; };
      return c;
    },
  };
  const api = new Function("document", "window", `
    ${fadeConsts}
    ${fnSrc("hsbToRgb")}
    ${fnSrc("glassPanelColour")}
    ${glassSrc}
    ${fnSrc("fadeReach")}
    ${fnSrc("blurReach")}
    ${fnSrc("paintMistGlass")}
    ${fnSrc("paintBottomFade")}
    return { GLASS, glassPanelColour, fadeReach, blurReach, paintMistGlass, paintBottomFade };
  `)(doc, { GLASS: overrides });
  return { api, log, target: makeCtx(log, "target") };
}

let pass = 0, fail = 0;
const ck = (n, c, d = "") => {
  if (c) { pass++; console.log("  PASS " + n); }
  else { fail++; console.log("  FAIL " + n + " :: " + d); }
};
const W = 920, H = 1700, COPY = 1209, LAYOUT_FADE = 330;

console.log("\nThe panel is neutral, not a colour wash");
{
  const { api } = build();
  const c = api.glassPanelColour();
  ck("saturation is 0 in the config", api.GLASS.saturation === 0, String(api.GLASS.saturation));
  ck("so it renders a true grey (R === G === B)", c.r === c.g && c.g === c.b, JSON.stringify(c));
  ck("at the picker's brightness",
    Math.abs(Math.max(c.r, c.g, c.b) / 255 - api.GLASS.brightness) < 0.01, JSON.stringify(c));
  // The reported bug was hue 33 at saturation 35 reading as brown.
  const brown = build({ overrides: { saturation: 0.35 } }).api.glassPanelColour();
  ck("the hue knob still works, so neutral is a CHOICE not an accident",
    brown.r !== brown.b, JSON.stringify(brown));
}

console.log("\nThe glass dissolves in rather than arriving at an edge");
{
  const { api } = build();
  const callerReach = api.blurReach(LAYOUT_FADE);
  const glassReach = callerReach * api.GLASS.reach;
  ck("it lengthens the caller's reach", api.GLASS.reach > 1, String(api.GLASS.reach));
  ck("long enough to hide its own start",
    glassReach / H >= 0.15, (glassReach / H * 100).toFixed(0) + "% of the card");
}

console.log("\nThe mask is a sampled curve, not a few straight segments");
{
  const { api, log, target } = build();
  api.paintMistGlass(target, {
    width: W, height: H, copyTop: COPY, fadeHeight: api.blurReach(LAYOUT_FADE),
  });
  const masked = log.contexts.filter((c) => c.stops.length)
    .sort((a, b) => b.stops.length - a.stops.length)[0];
  ck("a mask was built", !!masked && masked.stops.length > 0);
  if (masked) {
    const a = masked.stops.map((s) => s.a);
    // addColorStop interpolates linearly, so few stops == few straight
    // segments with a slope change at each join. That is Mach banding, and it
    // is what a "findable edge where the frost begins" actually is.
    ck("sampled densely, not a dozen segments", a.length >= 60, a.length + " stops");
    const steps = a.map((v, i) => (i ? v - a[i - 1] : 0)).slice(1);
    const biggest = Math.max(...steps);
    ck("eases in — first step far smaller than the steepest",
      steps[0] < biggest / 4, steps[0].toFixed(4) + " vs " + biggest.toFixed(4));
    ck("never goes backwards", a.every((v, i) => !i || v >= a[i - 1] - 1e-9));
    ck("starts fully transparent", a[0] === 0, String(a[0]));
    ck("reaches full strength and HOLDS, so every line sits on the same glass",
      a[a.length - 1] === 1 && a[a.length - 2] === 1, a.slice(-3).join(","));
  }
}

console.log("\nIt reads the right part of the photograph when the context is scaled");
// The bug this guards: drawImage's SOURCE rect is not transformed, so a design
// -space rect against a 4x export canvas reads the top-left corner instead of
// the copy band — preview right, published card wrong.
for (const scale of [1, 2, 4]) {
  const { api, log, target } = build({ transform: { a: scale, d: scale, e: 0, f: 0 } });
  const reach = api.blurReach(LAYOUT_FADE);
  api.paintMistGlass(target, { width: W, height: H, copyTop: COPY, fadeHeight: reach });
  const read = log.draws.find((d) => d.args.length === 9);
  const expectedTop = Math.max(0, COPY - reach * api.GLASS.reach) * scale;
  ck(`${scale}x: source rect starts at the copy band, not the canvas top`,
    read && Math.abs(read.args[2] - expectedTop) < 1.5,
    read ? `sy=${read.args[2]}, expected ${expectedTop.toFixed(0)}` : "no read-back");
  ck(`${scale}x: source width is device pixels, not design units`,
    read && Math.abs(read.args[3] - W * scale) < 2,
    read ? `sw=${read.args[3]}, expected ${W * scale}` : "");
}

console.log("\nIt declines rather than misbehaving");
{
  let r = build({ overrides: { on: false } });
  r.api.paintMistGlass(r.target, { width: W, height: H, copyTop: COPY, fadeHeight: 100 });
  ck("GLASS.on = false paints nothing", r.log.draws.length === 0);

  r = build();
  r.api.paintMistGlass(r.target, { width: W, height: H, copyTop: H + 500, fadeHeight: 10 });
  ck("copy far past the foot paints nothing", r.log.draws.length === 0);

  r = build();
  r.target.canvas = null;
  r.api.paintMistGlass(r.target, { width: W, height: H, copyTop: COPY, fadeHeight: 100 });
  ck("no canvas to read paints nothing", r.log.draws.length === 0);
}

console.log("\nThe bottom fade is still black, anchored, and capped");
{
  const { api, log, target } = build();
  api.paintBottomFade(target, { width: W, height: H, copyTop: COPY, fadeHeight: LAYOUT_FADE });
  const grad = log.gradients.find((g) => g.ctx === "target");
  ck("anchored a fixed distance above the copy",
    grad && Math.abs(grad.line[0] - (COPY - api.fadeReach(LAYOUT_FADE))) < 1.5,
    grad ? String(grad.line[0]) : "none");
  const a = target.stops.map((s) => s.a);
  ck("it painted a gradient", a.length > 0);
  ck("alpha never decreases", a.every((v, i) => !i || v >= a[i - 1] - 1e-9));
  ck("foot lands on GLASS.fadeMax",
    Math.abs(a[a.length - 1] - api.GLASS.fadeMax) < 1e-6,
    a[a.length - 1] + " vs " + api.GLASS.fadeMax);
  // The fill is 85% of a near-black and does the darkening the fade used to.
  // Left at its old 0.85 the two would stack to opaque and the photograph
  // would be gone entirely.
  ck("fill and fade cannot stack to an opaque card",
    api.GLASS.fadeMax + api.GLASS.fillAlpha <= 1.06,
    `${api.GLASS.fadeMax} + ${api.GLASS.fillAlpha}`);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
