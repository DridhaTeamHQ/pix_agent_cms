# Images in PIXIE

Every parameter that decides what a picture looks like on a card: where images
come from, what Restore & Upscale sends to OpenAI, and what the renderer does
with the result.

Values here are read from the code, not remembered. Where a number matters the
file and reason are named, so a change can be checked against the intent rather
than guessed at.

---

## 1. Where a picture comes from

Four sources, all reaching the same place — `state.mainImage`, the background of
the current page.

| Source | Endpoint | Notes |
|---|---|---|
| Scraped from the article | `/api/scrape-article` | The usual path. Whatever the page's own lead image is |
| Stock search | `/api/stock-images` | Needs `PEXELS_API_KEY`; the source is skipped silently without it |
| Web image search | `/api/google-images` | |
| Generated | `/api/flux-image` | Needs `FAL_KEY`. Last resort, paid |

Everything else on this page happens *after* one of those has produced a
picture. Remote images are fetched through `/api/image` as a same-origin proxy
so the canvas is not tainted and can be exported.

---

## 2. Restore & Upscale

`POST /api/upscale-image` — QA and admin only. One engine: OpenAI's
`images/edits`. There is no self-hosted upscaler and no local resampler; both
were removed deliberately (see §2.7).

### 2.1 What the browser sends

Body is the current background as PNG, **capped at 1536px on the long edge**
before upload — gpt-image-1's maximum output, so anything larger is bytes spent
to be thrown away.

| Header | Value | Read by |
|---|---|---|
| `Content-Type` | `image/png` | |
| `X-Image-Orientation` | `landscape` \| `portrait` | Decides output size (§2.3) |
| `X-Source-Size` | `WxH` of the capped upload | The planner — shape alone cannot tell a 400px crop from a 3000px one |
| `X-Headline` | URL-encoded, ≤200 chars | Stage 1 context only. **Never** given to the image model — a quoted string in an image prompt is a string to render, which put headlines inside photographs |
| `X-Enhance-Mode` | `restore` \| `expand` \| `auto` | Unrecognised or absent ⇒ `restore` |
| `X-Poster-Ratio` | e.g. `9:16` | Expand only. The restore path ignores it — see §2.3 |
| `X-Expand-Amount` | `subtle` \| `moderate` \| `strong` | Expand only |
| `X-Enhance-Strength` | `0`–`1` | **Currently unused server-side.** Left over from the deleted self-hosted upscaler; the slider still moves and changes nothing |

### 2.2 Two stages

**Stage 1 — plan and describe.** `gpt-4o-mini`, `temperature 0.2`,
`max_tokens 500`, `response_format: json_object`, image at `detail: "low"`
(a 512px thumbnail — framing survives that downscale, grain does not, and
framing is what is being judged).

Returns `{ mode, amount, subject, description, reason }`. Any failure falls back
to `restore`, so a broken planner degrades to the job that reframes nothing.

**Stage 2 — edit.** The description becomes context in the restore prompt, so
the model is told what it must not change.

### 2.3 Parameters sent to `images/edits`

| Parameter | Value | Why |
|---|---|---|
| `model` | `gpt-image-1.5`, falling back to `gpt-image-1` on 400/403/404 | The fallback is for accounts without the newer model |
| `size` | `1536x1024` landscape · `1024x1536` portrait · `auto` if orientation unknown | **Follows the SOURCE, not the poster** |
| `quality` | `IMAGE_QUALITY`, default `high` | This is the clay-face setting. `low` starves the model of rendering compute and skin comes back waxy — no prompt can undo it. A boot warning fires if it is set to `low` |
| `input_fidelity` | `high` | OpenAI's identity-preservation control |
| `image` | the PNG | |

> **`size` follows the source deliberately.** It used to ask for the *poster's*
> ratio, so a landscape photo on a 9:16 poster was requested as portrait and the
> model invented the difference — the doubled-subject "overlay" bug. Asking for
> the source's own shape is what fixed it. To fit a landscape photo into a
> portrait frame, use **Fit** (§4.2), which is arithmetic and involves no model.

### 2.4 The enlargement

gpt-image caps its output at **1536px on the long edge**, and the browser caps
the upload to match. That means the model alone cannot upscale anything: a
3000×2000 press photo goes up as 1536×1024 and comes back 1536×1024 — restored,
and *smaller than it started*. A 4000×3000 source loses 62% of its pixels.

So after the model returns, the image is enlarged with ffmpeg — lanczos plus a
light CAS sharpen — to `UPSCALE_TARGET_LONG_EDGE` (default **3400**, the
poster's long edge doubled). That covers a 920×1700 card comfortably at 1× and
holds up at 2× export.

| | before | after |
|---|---|---|
| 3000×2000 source | returned 1536×1024 | returned **3400×2266** |
| scale needed to cover a 9:16 poster | 1.83× (stretched) | 0.55× (downsampled) |

Not 4×: that would want ~11k pixels for a picture the model only ever knew 1536
of, and inventing that much is precisely what it was told not to do.

This is **not** the local resampler that was removed. That one stood *in place
of* the model, so one button gave three different kinds of picture depending on
what was reachable. This runs *after* the model, always — one path, one result.
It falls through unchanged when ffmpeg is missing or the picture is already big
enough, so its worst case is the previous behaviour.

`size` in the response is what actually came back; `modelSize` is what was asked
of the model. They differ whenever the enlargement ran.

### 2.5 Response

```json
{
  "image":   "data:image/png;base64,…",
  "engine":  "gpt-image-1.5",
  "quality": "high",
  "size":      "3400x2266",
  "modelSize": "1536x1024",
  "mode":    "restore",
  "amount":  null,
  "context": "…what stage 1 saw…",
  "subject": "people",
  "reason":  "…why this job ran…"
}
```

`mode` matters to the caller: the two jobs differ in **framing**, not just
sharpness, so the client has to know which it got before deciding whether the
writer's existing zoom and pan still apply.

### 2.6 Cost and latency

Billed per call, no free path.

| `IMAGE_QUALITY` | Cost per enhance |
|---|---|
| `low` | ~$0.011 (produces clay faces — not recommended) |
| `medium` | ~$0.042 |
| **`high`** (default) | **~$0.25** |

Typically 20–90 seconds. The boot log states the engine and the real cost:
`Restore & Upscale: gpt-image (quality=high, ~$0.25 each).`

### 2.7 What is switched off, and why

**Expand (generative zoom-out) is suppressed.** The route accepts the request,
runs the planner, then resolves every job to `restore`. The response says so
(`reason: "kept the framing — zoom-out is switched off while it is rebuilt"`)
rather than reporting restore as a decision made on the merits.

It was disabled after two published posters came back with the source
photograph rendered as a **physical print — hard white border and all** —
inside a scene the model drew around it. Measured on the poster, the surround
carried *more* edge energy than the inset (17.8 vs 12.6), so it was generated
detail, not a blurred backdrop. Three structural causes: the prompt asked the
model to "place the supplied photograph smaller within the output frame"; no
mask or padded canvas was sent, so nothing pinned the original's pixels; and it
requested the poster's ratio, the same condition that caused the overlay bug.

The real fix is outpainting **with a mask** — pad the source onto a transparent
canvas at the target size in the browser and send image + mask, so the model can
only paint the margin. That needs verifying against real gpt-image calls first.

**Also removed:** the self-hosted Real-ESRGAN/SwinIR service (`upscaler/`), a
local lanczos resampler, and the per-image colour tint. One button returning
three different kinds of picture depending on what was reachable was the fault
being fixed.

`DISABLE_GPT_IMAGE=true` switches the route off entirely and returns 503. It no
longer diverts to anything, because there is nothing left to divert to.

---

## 3. Frame sizes

`LAYOUTS` in `public/app.js`. The canvas is set to `L.W × L.H`, so design
coordinates and canvas pixels are the same thing at 1×.

| Ratio | Canvas | Headline pad | Fade height |
|---|---|---|---|
| `9:16` Story/Reel | 920 × 1700 | 305 | 330 |
| `4:5` Feed portrait | 1080 × 1350 | 110 | 300 |
| `1:1` Square | 1080 × 1080 | 90 | 280 |
| `16:9` Wide | 1920 × 1080 | 100 | 300 |

**Export** re-renders at a scale (`renderToHighResCanvas`, up to 4×); X exports
at 2×. Anything that *reads* the canvas must convert through the live transform
— `drawImage`'s source rectangle is not transformed, and a design-space rect
against a 4× canvas reads the top-left corner instead.

---

## 4. Placing the picture

### 4.1 Fill (default)

`drawCoverImage` scales to **cover**: `max(frameW/imgW, frameH/imgH)`, times the
zoom, times `IMAGE_PAN_HEADROOM` (1.1). Overflow is cropped. A 16:9 photo on a
9:16 poster loses about 68% of itself this way — right for most poster images.

### 4.2 Fit — the whole photo, letterboxed

Click the **zoom percentage** to fit; click again to fill.

`fitZoomFor()` returns the zoom at which the entire picture sits inside the
frame, with the backdrop showing around it. Expressed as a zoom so it travels
through the existing control, the page snapshot and the saved design with no new
field, and can be nudged afterwards.

| Photo | Fit zoom | Result on a 9:16 poster |
|---|---|---|
| 16:9 landscape | 27% | 598px black top and bottom |
| 4:3 landscape | 36% | 513px |
| 1:1 square | 49% | 392px |
| 9:16 portrait | 87% | 37px |
| 3000×600 panorama | 9% | fits |

Two rules that are easy to break:

- **Floored, never rounded.** The control carries whole percentages, and 27.7
  rounding to 28 puts the picture 11px back over the edge it was just fitted
  inside.
- **The pan clamp only applies while the picture is bigger than the frame.**
  Below that its minimum runs past its maximum and `clamp()` returns the
  maximum, which pinned a fitted photo into the top-left corner.

### 4.3 Controls

| Control | Range | Notes |
|---|---|---|
| Zoom | 5–300% | Stepper ±5%. Floor is 5 so a panorama can be fitted |
| Pan X / Y | −900…900 px | |
| Brightness / Contrast / Saturation | 0–200% | Applied to the image layer only |
| Blur | 0–20px | |

Filters never touch the gradient, headline or logo — `drawCoverImage` sets
`ctx.filter` and resets it immediately after the draw.

---

## 5. The glass and the fade

Two effects under the copy, both anchored to the first line of text so they move
with it. Tunable live via `window.GLASS`.

| Key | Default | What it does |
|---|---|---|
| `on` | `true` | Master switch |
| `hue` | 33 | Only meaningful when `saturation > 0` |
| `saturation` | **0** | 0 = neutral black. 0.35 was the brown wash |
| `brightness` | 0.07 | The picker's was 0.09; darkened on request |
| `fillAlpha` | 0.88 | The 85% beside the hex, taken up on request |
| `fadeMax` | 0.24 | Cap on the gradient. The fill does most of the darkening; what must stay bounded is the *product* — see below |
| `blurAt` / `blurCardWidth` | 44 / 382 | Blur in the design's units, scaled to the canvas. Now a real destination radius — it used to be divided by `downscale` and set on the full-size context, which threw three quarters of it away |
| `blurCurve` | 1 | How far the blur LAGS the darkening, as an exponent on the shared ramp |
| `blurLevels` | 12 | Pre-blurred copies of the downscaled band. The blur is applied there, where the upscale multiplies it and the pixels are a sixteenth |
| `frostReach` | 1 | Where the blurred picture is fully present, as a MULTIPLE of where the copy line falls in the band. 1 = full exactly at the first line, whatever the run-up is |
| `gradientSamples` | 256 | Stops per ramp. Two gradients over one span means their joins add |
| `downscale` | 4 | Most of the blur comes free from downsampling; `ctx.filter` supplies the remainder |
| `refract` | 0.022 | How far the glass bends the picture, as a share of width |
| `refractStrips` | 56 | Depth resolution of the bend, and of the blur ramp — each strip carries its own radius |
| `runUpAboveCopy` | 65 | How far above the first line the glass begins, in the 1700px reference frame. The ramp then runs the whole band, so this sets both where the onset lands and how gentle the build is. Replaced `reach` and `startBelowCopy` — see below |

**All three pages that put copy over a photograph use it** — the poster, the
story page and the text page. The text page did not until recently, and the
reason it looked untreated is worth keeping: it painted a four-stop wash over
the whole frame (0.68 / 0.52 / 0.68 / 0.98, plus a flat 0.22) *and* drew its
photograph through `blur(18px) brightness(62%)`. Between 75% and 98% black
everywhere, over an input that was already uniformly soft. A treatment that
goes from sharp to frosted has nothing to show when its input starts frosted:
there was no transition on that page, only a flat blur that resembled one.

It draws the picture sharp now and anchors the same glass and fade to its copy.
`GLASS.textPageVeil` (0.42) is the one thing the wash left behind, and it earns
its place: the other two pages put their copy near the foot so the ramp always
has run-up above it, while the text page's copy grows upward and is clamped a
tenth of the way down the card, where the ramp has barely begun. Measured on a
bright photograph, white body copy at that worst-case first line is 5.28:1 with
the veil and 1.97:1 without it.

### Where the band starts

`runUpAboveCopy` is 65 — about one line-height — because that is where the
treatment was asked to begin, marked on a card just above the first row of
copy. It was 272, roughly two lines further up.

The shorter run-up is a real trade and it goes the wrong way on the thing this
treatment exists to avoid: the darkening now has 556px to build across instead
of 763, so its steepest run goes from 0.30 to 0.35 levels/px and lands just
below the first line rather than above it. It is still five times gentler than
the 2.0 cliff this started from, and measured on a smooth source no row departs
from its local slope by more than 0.96 of 255 with none stepping at all — so
there is no edge to find. But `window.GLASS.runUpAboveCopy = 272` is the way
back if one ever appears.

Two knobs moved with it. `frostReach` is now a multiple of where the copy line
falls rather than a fraction of the band, so the blurred layer is fully present
exactly at the first line whatever the run-up is — a fixed fraction silently
pushes the frost *below* the copy when the run-up shortens, which puts the
sharp original back under the very lines the split was made to clear. And
`blurCurve` goes 2 → 1: the lag existed to keep the radius climbing below the
type, and with the copy line now a tenth of the way into the band, nearly all
of the ramp is below it already. The lag had nothing left to protect and was
starving the first lines — σ 1.6 at line one with it, 10.1 without.

### Two ramps, and why the blur was invisible

The frost and the darkening used to share one mask: the blurred picture and the
dark fill were stacked into one canvas and a single ramp faded the whole stack
in. That is why the card read as sharp near the copy however large the radius
got — **at half mask alpha you are not looking at a half-blurred picture, you
are looking at a blurred one at half strength over the sharp original at half
strength, and the eye takes its reading of focus from the sharp component.**
Measured: the strip loop asked for σ 52 at line three and the composite showed
a 1px edge, because presence there was 60%.

So the blurred layer has its own faster ramp (`frostReach`, 0.35 — about the
first line) and the dark fill keeps the long gentle one. Below that point there
is no sharp copy left anywhere, and the radius can grow under a solid layer.

There was a second bug underneath it. `stripBlur` was computed as
`blurTarget / downscale` and then set on the **full-size** context, so the
division landed in the wrong coordinate space and was simply lost — the card
received about a quarter of the radius the code asked for. The comment
defending it ("most of the blur comes free from the downsample") had the
premise wrong too: downsampling by four discards detail finer than four pixels,
it does not multiply a later blur by four.

Applying the radius honestly on the full-size context is correct and
unaffordable — **140ms a paint against 3ms**. The band is already held at
1/`downscale` for the read-back, and a blur applied *there* is multiplied by
the upscale on the way out: σ 15 on the quarter-size copy lands as σ 60 on the
card over a sixteenth of the pixels. So `blurLevels` pre-blurred copies are
built once and each strip draws from the one matching its depth.

Delivered σ on a 920 card, measured off the 10–90% width of a hard edge
(= 2.563 σ):

| | at the line | line 1 | line 2 | line 3 | line 5 | foot |
|---|---|---|---|---|---|---|
| originally delivered | 0.4 | 0.4 | — | 3.9 | 5.9 | 16.4 |
| now | **0.4** | 10.1 | 29.3 | 39.8 | 67.5 | **99.1** |

The picture above the band stays sharp, the darkening is untouched (peak slope
0.30 levels/px, still above the first line), and the worst row departs from its
local slope by 0.94 of 255 with none stepping at all. About 3ms a page.

**Both ramps follow one profile.** `specAlpha` is the design's gradient — three
stops, transparent, 80% at 63% of the way down, full at the foot — interpolated
linearly, which is what the design tool does. `rampAlpha` is that profile with
its onset eased, and it is what the glass mask, the blur radius and the bottom
fade all sample.

The fade is then scaled by `GLASS.fadeMax` (0.24), because the glass fill does
most of the darkening: it contributes the *shape* at a quarter of full strength.

**The fill and the fade multiply, they do not add.** The fade darkens what the
fill let through, so what has to stay bounded is `(1 - fillAlpha) x (1 - fadeMax)`
— the fraction of the photograph still visible at the foot. At 0.88 and 0.24
that is 9.1%; below about 7% the picture stops reading as one and the card is a
black panel with type on it. `test/glass.mjs` used to check `fillAlpha + fadeMax
<= 1.06`, which is the wrong arithmetic in both directions.

Darkening also bought back legibility that had quietly gone thin. White headline
type on a bright photograph measured **3.28:1** at the first line before this —
passing AA for large text by a hair, failing AA body. It is **3.70:1** now, and
lines two and below clear 4.5:1.

### Why the transition used to be findable, and what fixed it

Reported repeatedly as a visible edge above the first line, and survived about
ten rounds of tuning the *curve* — smoothstep vs smootherstep, 13 stops vs 64,
per-strip radii. None of it helped, because the curve was never the problem.

Measured off the rendered card, the old geometry put **92 of the 95 available
levels of darkening inside 120px**, from line one to line three, against three
levels across the whole run-up above it. The glass band started *at* `copyTop`
and reached full strength 123px later, a quarter of the way into a 491px band,
then sat flat. Peak slope **1.22% of the total per pixel against the design's
0.21%** — six times steeper, and landing exactly where the type is.

Three changes, in order of how much each was worth:

1. **A run-up.** The band starts `runUpAboveCopy` (272px) above the first line
   instead of on it, so the onset lands in open picture with no type beside it
   to measure the change against. 48% of the build now happens above line one;
   it was 3%.
2. **The ramp runs the whole band** rather than finishing in its first quarter
   onto a flat panel. Every level not spent over the full height had to be
   spent in that 123px.
3. **Half the blur.** The transition is carried by the darkening, which the eye
   cannot check, rather than by sharpness, which it can.

Measured after: peak slope **0.25 levels/px against 2.0**, eight times gentler,
and it now falls 160px *above* the first line. Against a source with no
horizontal structure, no row anywhere departs from its local slope by more than
1.04 of 255 levels — the 8-bit quantisation floor. Render cost went *down*,
3.7ms from 9.2ms, because the smaller radius lets more strips share a filter.

**Easing the onset is not free, and the obvious way is wrong.** The design's
profile is piecewise linear: it goes from not climbing to climbing at full rate
over no distance, and a step in *slope* is what the eye is good at — it is why a
gradient built from a few stops shows a line at every join though its values are
continuous. Multiplying the curve by a smoothstep does start it from zero and
pays for it with a patch **1.69× steeper** a fifth of the way down (measured:
0.28 levels/px against an average of 0.13). So `rampAlpha` applies the window to
the *slope* and renormalises — it accelerates from a standstill, never climbs
faster than it must, and still lands at 1. Peak comes down to 1.43× average.
`test/glass.mjs` asserts both halves, because checking only the onset is how the
multiply version passed.

**Two rules worth knowing before touching either:**

- **Sample curves densely.** `addColorStop` interpolates *linearly*, so a curve
  described by a few stops is a few straight segments with a slope change at
  each join. The eye resolves a change in slope far more readily than a change
  in value — that is Mach banding, and it appears as a hard line where the
  frost begins. The fade samples 48 times, the glass mask 64.
- **The blur ramps its radius, not its opacity.** Fading one fully-blurred
  layer in leaves a sharp copy of the picture superimposed mid-transition,
  which the eye finds however smooth the alpha curve is. Each refraction strip
  carries its own radius instead, so every depth is a single genuinely blurred
  image.
- **Blur needs padding.** A blur samples outward, and past the canvas edge there
  is nothing; those samples return transparent and the sharp original shows
  through as an unblurred strip at the foot. The frame is padded and edge-
  extended before blurring, then cropped back.

---

## 6. Performance

`renderPoster()` repaints every page and the X preview. Two things keep that
affordable, and both are load-bearing:

- **The glass reuses its scratch canvases.** It allocated two per call, once per
  page — about 10MB per render, ~100MB/s while typing, which froze the editor.
- **Continuous input coalesces into one paint per frame.** Typing, sliders and
  drags schedule a repaint rather than forcing one. 60 keystrokes → 1 paint.

`renderPoster()` itself is **never** deferred. The export path, the X preview
and the screen-preview modal paint and then read the canvas back in the same
tick; deferring them would publish a card missing its last edit.

Current cost: ~5ms median per render, 0 dropped frames while typing.

---

## 7. Environment

| Variable | Default | Effect |
|---|---|---|
| `OPENAI_API_KEY` | — | Required for Restore & Upscale. Without it the route returns 503 |
| `IMAGE_QUALITY` | `high` | `low` \| `medium` \| `high` — see §2.5 |
| `DISABLE_GPT_IMAGE` | unset | `true` switches the route off and returns 503 |
| `UPSCALE_TARGET_LONG_EDGE` | `3400` | Long edge the restored image is enlarged to (§2.4) |
| `UPSCALE_SHARPEN` | `0.35` | CAS strength applied after the enlargement |
| `PEXELS_API_KEY` | — | Stock images; source skipped silently when unset |
| `FAL_KEY` | — | Flux generation |

---

## 8. Tests

No runner, no dependencies. Each exits non-zero on failure.

```bash
node test/image-fit.mjs   # fit/fill geometry, letterbox centring, pan clamp
node test/glass.mjs       # panel colour, mask sampling, device transform, fade
node test/render.mjs      # render coalescing, and that export stays synchronous
node test/upscale.mjs     # the enlargement after the model (needs ffmpeg)
```

They execute the real functions pulled out of `public/app.js` rather than
reimplementing them, and read constants from the source — a test that hard-codes
the value it checks only proves the file was edited twice.
