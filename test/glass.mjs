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

// fadeReach still uses the loose FADE_ constants alongside GLASS.
// Injected from the source rather than restated, same rule as the rest.
const fadeConsts = app
  .split(/\r?\n/)
  .filter((l) => l.startsWith("const FADE_"))
  .join("\n");

/* SPEC_STOPS is the profile both ramps follow, and it is a const array
   spanning several lines rather than a function. Injected from the source for
   the same reason as everything else here: a test that restates the shape it
   is checking passes whatever the shape becomes. */
const specSrc = (() => {
  const a = app.indexOf("const SPEC_STOPS = [");
  const tail = "];";
  return app.slice(a, app.indexOf(tail, a) + tail.length);
})();

/* RAMP_ONSET, the lookup width, and the integral built from them. Injected
   out of the source rather than restated, same rule as everything else here. */
const onsetSrc = [
  app.match(/^const RAMP_ONSET = [\d.]+;/m)[0],
  app.match(/^const RAMP_SAMPLES_LUT = \d+;/m)[0],
  (() => {
    const a = app.indexOf("const RAMP_TABLE = (");
    return app.slice(a, app.indexOf("})();", a) + 5);
  })(),
].join("\n");

function makeCtx(log, label) {
  const stops = [];
  return {
    canvas: { __label: label }, stops, label,
    globalAlpha: 1, globalCompositeOperation: "source-over",
    imageSmoothingEnabled: false, imageSmoothingQuality: "",
    fillStyle: null,
    /* filter is a real property on a context, and the strip loop assigns it
       per strip. Recording the assignments is the only way to see the blur
       RADIUS the code actually asks for, which is the thing being checked. */
    _filter: "none",
    get filter() { return this._filter; },
    set filter(v) { this._filter = v; log.filters.push({ ctx: label, value: v, seq: log.seq++ }); },
    getTransform: () => log.transform,
    drawImage(...a) { log.draws.push({ ctx: label, args: a, seq: log.seq++ }); },
    fillRect(...a) { log.fills.push({ ctx: label, args: a }); },
    // Reused scratch canvases must be wiped before reuse, so the stub has to
    // accept the calls that do it.
    clearRect(...a) { log.clears.push({ ctx: label, args: a }); },
    setTransform() {},
    createLinearGradient(x0, y0, x1, y1) {
      log.gradients.push({ ctx: label, line: [y0, y1] });
      return { addColorStop: (p, c) => stops.push({ p, a: Number(c.match(/,([\d.]+)\)$/)[1]) }) };
    },
  };
}

function build({ transform = { a: 1, d: 1, e: 0, f: 0 }, overrides = {} } = {}) {
  const log = { draws: [], fills: [], gradients: [], clears: [], contexts: [], created: [], filters: [], seq: 0, transform };
  let n = 0;
  const doc = {
    createElement: () => {
      const c = { width: 0, height: 0, __i: n++ };
      log.created.push(c);
      // One context object per canvas, as a real canvas gives, so reuse of the
      // canvas is visible as reuse of the context.
      const cx = makeCtx(log, "off" + c.__i);
      c.getContext = () => { log.contexts.push(cx); return cx; };
      return c;
    },
  };
  const api = new Function("document", "window", `
    ${fadeConsts}
    const glassScratchPool = new Map();
    ${fnSrc("glassScratch")}
    ${fnSrc("hsbToRgb")}
    ${fnSrc("glassPanelColour")}
    ${glassSrc}
    ${fnSrc("fadeReach")}
    ${specSrc}
    ${fnSrc("specAlpha")}
    ${onsetSrc}
    ${fnSrc("rampAlpha")}
    ${fnSrc("paintMistGlass")}
    ${fnSrc("paintBottomFade")}
    return { GLASS, glassPanelColour, fadeReach, paintMistGlass, paintBottomFade };
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

console.log("\nThe transition is gentle enough that there is no edge to find");
{
  /* The property, and the one nothing here used to measure.

     What the eye finds is the STEEPEST part of the ramp, expressed against
     the card - not the curve's name, not where it starts, not how many stops
     describe it. Every previous round of tuning argued about those three and
     left this untouched at six times the design's value, which is why each
     round changed the look without answering the complaint.

     Measured off the mask the code actually builds: the largest jump in alpha
     between adjacent stops, over the distance between them in pixels of card.
     The design tool's own gradient is 0.80 across 63% of its region; the bound
     is twice that, so the curve can be retuned but not re-steepened. */
  const { api, log, target } = build();
  api.paintMistGlass(target, { width: W, height: H, copyTop: COPY });
  const read = log.draws.find((d) => d.args.length === 9);
  const bandPx = H - read.args[2];

  const masked = log.contexts.filter((c) => c.stops.length)
    .sort((a, b) => b.stops.length - a.stops.length)[0];
  let peak = 0;
  for (let i = 1; i < masked.stops.length; i++) {
    const dp = masked.stops[i].p - masked.stops[i - 1].p;
    const da = masked.stops[i].a - masked.stops[i - 1].a;
    if (dp > 0) peak = Math.max(peak, Math.abs(da) / (dp * bandPx));
  }
  /* It has to leave from a standstill. A ramp that starts climbing at its
     full rate has a corner at the top of the band, and a corner in the SLOPE
     is what shows as a line even when every value along it is continuous.

     The bound is the other half: easing the onset by multiplying the curve by
     a smoothstep does start it from zero, and pays for it with a patch 1.69x
     steeper than the design a fifth of the way down. Ramping the slope and
     renormalising instead keeps the start at zero AND the peak near the
     design's own. Both properties or neither - checking only the first is how
     the multiply version passed. */
  const first = masked.stops[1].a - masked.stops[0].a;
  const biggest = Math.max(...masked.stops.map((st, i) =>
    i ? st.a - masked.stops[i - 1].a : 0));
  ck("it leaves from a standstill rather than a corner",
    first < biggest / 8, first.toFixed(5) + " vs " + biggest.toFixed(5));

  const REFERENCE = 0.8 / (0.63 * bandPx);   // the design tool's steepest run
  ck("its steepest run is no worse than twice the design's",
    peak <= REFERENCE * 2,
    (peak * 100).toFixed(3) + "% per px vs the design's " + (REFERENCE * 100).toFixed(3) + "%");

  /* The old geometry, kept as the thing that must not come back: a 123px ramp
     starting on the copy line, smoothstepped. It reads as an edge because it
     cannot not - the same alpha change compressed into a fifth of the run. */
  const shortRamp = 1.5 / (LAYOUT_FADE * 0.45 * 0.83);
  ck("and far gentler than the 123px ramp it replaced",
    peak < shortRamp / 3,
    (peak * 100).toFixed(3) + "% per px vs the old " + (shortRamp * 100).toFixed(3) + "%");
}

console.log("The mask is a sampled curve, not a few straight segments");
{
  const { api, log, target } = build();
  api.paintMistGlass(target, {
    width: W, height: H, copyTop: COPY,   });
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
    api.paintMistGlass(target, { width: W, height: H, copyTop: COPY });
  const read = log.draws.find((d) => d.args.length === 9);
  /* The band begins GLASS.runUpAboveCopy above the first line. Computed from
     the rule rather than restated, so tuning the knob does not edit this. */
  const expectedTop =
    (COPY - Math.min(COPY, api.GLASS.runUpAboveCopy * (H / 1700))) * scale;
  ck(`${scale}x: source rect starts at the copy band, not the canvas top`,
    read && Math.abs(read.args[2] - expectedTop) < 1.5,
    read ? `sy=${read.args[2]}, expected ${expectedTop.toFixed(0)}` : "no read-back");
  ck(`${scale}x: source width is device pixels, not design units`,
    read && Math.abs(read.args[3] - W * scale) < 2,
    read ? `sw=${read.args[3]}, expected ${W * scale}` : "");
}
console.log("\nIt reuses its scratch canvases instead of allocating per render");
{
  // renderPoster() runs straight out of every keystroke handler and repaints
  // every page, so this ran three times per keypress. Two fresh canvases each
  // time was ~10MB per render and ~100MB/s of churn under ordinary typing.
  const { api, log, target } = build();
  const arg = { width: W, height: H, copyTop: COPY, };
  api.paintMistGlass(target, arg);
  const afterFirst = log.created.length;
  for (let i = 0; i < 20; i++) api.paintMistGlass(target, arg);
  ck("further renders allocate no new canvases",
    log.created.length === afterFirst, `${afterFirst} then ${log.created.length} after 21 renders`);
  ck("and it wipes what it reuses, so no stale frame shows through",
    log.clears.length >= 2, log.clears.length + " clears");
}


console.log("\nThe blend begins well above the first line");
{
  const { api, log, target } = build();
  api.paintMistGlass(target, {
    width: W, height: H, copyTop: COPY,   });
  const read = log.draws.find((d) => d.args.length === 9);
  const bandTop = read.args[2];

  /* It used to start AT the copy and finish 123px later, so the entire build
     happened across lines one to three with nothing above it at all. The onset
     has to land in empty picture, where there is no type beside it for the eye
     to measure the change against. */
  const runUp = COPY - bandTop;
  ck("there is a real run-up above the copy", runUp > 100, runUp + "px");
  ck("taken from the knob, in the card's own frame",
    Math.abs(runUp - api.GLASS.runUpAboveCopy * (H / 1700)) < 1.5, runUp + "px");
  ck("but it does not start halfway up the card",
    bandTop / H >= 0.4, (bandTop / H * 100).toFixed(0) + "% down the card");

  /* The ramp runs the full band instead of finishing early onto a flat panel.
     That panel was the other half of what forced the ramp to be steep: every
     level it did not use had to be spent in the 123px above it. */
  const masked = log.contexts.filter((c) => c.stops.length)
    .sort((a, b) => b.stops.length - a.stops.length)[0];
  const rising = masked.stops.filter((st, i) => i > 0 && st.a > masked.stops[i - 1].a);
  ck("it is still climbing at the foot, not flat from a third of the way down",
    rising[rising.length - 1].p > 0.9,
    "stops rising at " + (rising[rising.length - 1].p * 100).toFixed(0) + "% of the band");
}


console.log("It declines rather than misbehaving");
{
  let r = build({ overrides: { on: false } });
  r.api.paintMistGlass(r.target, { width: W, height: H, copyTop: COPY });
  ck("GLASS.on = false paints nothing", r.log.draws.length === 0);

  r = build();
  r.api.paintMistGlass(r.target, { width: W, height: H, copyTop: H + 500 });
  ck("copy far past the foot paints nothing", r.log.draws.length === 0);

  r = build();
  r.target.canvas = null;
  r.api.paintMistGlass(r.target, { width: W, height: H, copyTop: COPY });
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
  /* The property is that some photograph is left at the foot, and the old
     form of this check had the arithmetic wrong: it added fillAlpha and
     fadeMax against a bound of 1.06. They do not add. The fade darkens what
     the fill let through, so they MULTIPLY — what survives is
     (1 - fillAlpha) x (1 - fadeMax). Adding them is both too strict in the
     middle of the range and meaningless at the ends, and it blocked a
     deliberate darkening that leaves 9.1% of the picture visible.

     7% is where a photograph stops reading as one and the card becomes a
     black panel with type on it. Measured on a flat 154-grey source, 9.1%
     lands the foot at 27 against 34 before. */
  const surviving = (1 - api.GLASS.fillAlpha) * (1 - api.GLASS.fadeMax);
  ck("some photograph survives at the foot",
    surviving >= 0.07,
    (surviving * 100).toFixed(1) + "% of the picture left");
}

console.log("\nEvery page that shows copy over a photograph gets the treatment");
{
  /* The text page did not, and nobody noticed for a long time: it painted a
     four-stop wash over the whole frame instead, and drew its photograph
     through blur(18px) brightness(62%) on top of that. Both of those make the
     glass invisible — one buries it, the other removes the sharp input it
     needs to be a transition at all — so this checks the source directly.

     Reading the file rather than executing it, because these are three
     separate screen functions with their own DOM and state; what matters is
     that none of them quietly goes back to washing the frame. */
  const screens = ["drawPixTextScreen", "drawStoryScreen", "drawHero"];
  for (const name of screens) {
    const body = (() => {
      const i = app.indexOf("function " + name);
      if (i < 0) return null;
      let k = app.indexOf(") {", i) + 2, d = 0;
      for (let j = k; j < app.length; j++) {
        if (app[j] === "{") d++;
        else if (app[j] === "}") { d--; if (!d) return app.slice(i, j + 1); }
      }
    })();
    if (!body) { console.log("  SKIP " + name + " not found"); continue; }
    ck(name + " paints the glass", /paintMistGlass\(/.test(body));
    ck(name + " paints the fade", /paintBottomFade\(/.test(body));
    ck(name + " anchors both to the copy, not to the frame",
      !/copyTop:\s*0/.test(body));
  }

  // The text page specifically: sharp input, and no full-frame wash left.
  const text = (() => {
    const i = app.indexOf("function drawPixTextScreen");
    let k = app.indexOf(") {", i) + 2, d = 0;
    for (let j = k; j < app.length; j++) {
      if (app[j] === "{") d++;
      else if (app[j] === "}") { d--; if (!d) return app.slice(i, j + 1); }
    }
  })();
  ck("the text page draws its photograph sharp",
    /drawTextPreviewBackgroundImage\([\s\S]*?"none"\)/.test(text),
    "a pre-blurred input has no sharp-to-frosted transition to show");
  ck("and the four-stop full-frame wash is gone",
    !/addColorStop\(0\.34/.test(text) && !/rgba\(0, 0, 0, 0\.98\)/.test(text));
}

console.log("\nThe blur lags the darkening, piling up towards the foot");
{
  const { api, log, target } = build();
  api.paintMistGlass(target, { width: W, height: H, copyTop: COPY });

  /* Radius against DEPTH, not against position in the log.

     The strip loop only assigns ctx.filter when the value changes, so the log
     holds the distinct radii rather than one per strip — and with a lagging
     curve those are sparse at the top and dense at the foot. Reading the array
     as if index meant depth therefore reports the blur as far more front-loaded
     than it is. Each filter is paired with the strip that follows it instead,
     and the strip's destination y is the depth.

     Draws that cover the full height are the edge-extension pass after the
     loop, not strips; they follow the filter reset and would read as a radius
     of zero at the top of the band. */
  /* One context only. paintMistGlass uses three — the small downscale buffer,
     the full-size glass buffer, and the target — and all of them set filters
     and draw. The read-back into the small buffer is a 9-argument draw with a
     short destination too, so it passes for a strip and lands at depth 0. */
  const stripCtx = (() => {
    const n = {};
    for (const d of log.draws) if (d.args.length === 9) n[d.ctx] = (n[d.ctx] || 0) + 1;
    return Object.keys(n).sort((a, b) => n[b] - n[a])[0];
  })();
  const strips = log.draws.filter(
    (d) => d.ctx === stripCtx && d.args.length === 9 && d.args[8] < H * 0.1);
  const samples = [];
  for (const f of log.filters) {
    if (f.ctx !== stripCtx) continue;
    if (!/^blur\(|^none$/.test(f.value)) continue;
    const strip = strips.find((d) => d.seq > f.seq);
    if (strip && strip.args[6] < 0) continue;
    if (!strip) continue;
    samples.push({
      depth: strip.args[6] / strips[strips.length - 1].args[6],
      r: f.value === "none" ? 0 : parseFloat(f.value.slice(5)),
    });
  }
  ck("it set a blur per depth", samples.length > 4, samples.length + " radius changes");

  const maxR = Math.max(...samples.map((s) => s.r));
  ck("radius never goes backwards as it descends",
    samples.every((s, i) => !i || s.r >= samples[i - 1].r - 1e-9),
    samples.slice(0, 8).map((s) => s.r).join(","));

  /* The property that was asked for, and the reason blurAt could be raised
     70% without the top of the band getting harder to look at.

     The bound is 0.40 because that is what discriminates, not because it is a
     round number: the shared curve puts the half-way radius at 0.60 of the
     maximum, and squaring it puts it at 0.37. Anything between the two
     separates a lagging blur from one moving in step with the darkening, and
     this fails the moment blurCurve goes back to 1. */
  const nearest = (d) => samples.reduce((best, s) =>
    Math.abs(s.depth - d) < Math.abs(best.depth - d) ? s : best);
  const halfWay = nearest(0.5).r / maxR;
  ck("half way down it carries well under half its final radius",
    halfWay < 0.4, `${(halfWay * 100).toFixed(0)}% of the maximum`);
  ck("and the config says so rather than it being a coincidence",
    api.GLASS.blurCurve > 1, String(api.GLASS.blurCurve));

  /* Where the radius climbs fastest has to be BELOW the copy line. That is the
     one place a sharpness gradient is cheap: the card is nearly black there,
     so little luminance is left to reveal what focus was lost. Sharing the
     darkening's curve put the fastest climb exactly ON the first line. */
  const copyDepth = (COPY - (COPY - api.GLASS.runUpAboveCopy * (H / 1700))) /
    (H - (COPY - api.GLASS.runUpAboveCopy * (H / 1700)));
  let steepest = 0, steepestAt = 0;
  for (let i = 1; i < samples.length; i++) {
    const rise = (samples[i].r - samples[i - 1].r) /
      Math.max(1e-6, samples[i].depth - samples[i - 1].depth);
    if (rise > steepest) { steepest = rise; steepestAt = samples[i].depth; }
  }
  ck("its fastest climb is below the copy line, not on the type",
    steepestAt > copyDepth, `${(steepestAt * 100).toFixed(0)}% down, copy at ${(copyDepth * 100).toFixed(0)}%`);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
