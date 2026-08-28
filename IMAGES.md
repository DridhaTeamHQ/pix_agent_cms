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
| `brightness` | 0.09 | From the picker. Fixed |
| `fillAlpha` | 0.85 | The 85% beside the hex. Fixed |
| `fadeMax` | 0.20 | Cap on the gradient. The fill does the darkening now; both at full strength leave no photograph |
| `blurAt` / `blurCardWidth` | 26 / 382 | Blur in the design's units, scaled to the canvas — 63px on a 920 card |
| `downscale` | 4 | Most of the blur comes free from downsampling; `ctx.filter` supplies the remainder |
| `refract` | 0.022 | How far the glass bends the picture, as a share of width |
| `refractStrips` | 56 | Depth resolution of the bend |
| `reach` | 1.2 | Length of the dissolve, as a multiple of the caller's fadeHeight. Peak steepness is the curve's peak slope divided by this — 1.2 ≈ 178px ramp, 0.0084 alpha/px |
| `startBelowCopy` | 0 | Where the ramp BEGINS, measured down from the top of the first line. The band runs downward from there, so nothing above the copy is frosted. 0 puts the visible onset at the line's midpoint, since smoothstep needs about a sixth of its ramp before softening shows |

**The fade's shape comes from the design's gradient**, not from a formula:
three stops — transparent, 80% at 63% of the way down, full at the first line
— interpolated linearly, which is what the design tool does. It runs over
2.0 × the layout's fadeHeight (about 660px on a 9:16 card, matching the mock's
40% of the frame) and is anchored so it completes at the copy.

It is then scaled by `GLASS.fadeMax` (0.20), because the glass fill does the
darkening. So the fade contributes the *shape* at a fifth of full strength;
measured, every stop lands within 0.005 of 0.20 × the spec.

**Two rules worth knowing before touching either:**

- **Sample curves densely.** `addColorStop` interpolates *linearly*, so a curve
  described by a few stops is a few straight segments with a slope change at
  each join. The eye resolves a change in slope far more readily than a change
  in value — that is Mach banding, and it appears as a hard line where the
  frost begins. The fade samples 48 times, the glass mask 64.
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
