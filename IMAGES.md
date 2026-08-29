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
were removed deliberately (see §2.6).

### 2.1 What the browser sends

Body is the current background as PNG, **capped at 1536px on the long edge**
before upload — gpt-image-1's maximum output, so anything larger is bytes spent
to be thrown away.

That cap is on the **upload only**. An expand pastes the writer's original back
over the result at up to its own resolution — see §2.8.

| Header | Value | Read by |
|---|---|---|
| `Content-Type` | `image/png` (stage 1) / multipart (stage 2) | |
| `X-Enhance-Stage` | `plan` \| `edit` | Which half of the two-stage flow this is (§2.2). Absent ⇒ the legacy single-shot path |
| `X-Image-Orientation` | `landscape` \| `portrait` | Decides output size (§2.3) |
| `X-Source-Size` | `WxH` of the capped upload | The planner — shape alone cannot tell a 400px crop from a 3000px one |
| `X-Headline` | URL-encoded, ≤200 chars | Stage 1 context only. **Never** given to the image model — a quoted string in an image prompt is a string to render, which put headlines inside photographs |
| `X-Enhance-Mode` | `restore` \| `expand` \| `auto` | Unrecognised or absent ⇒ `restore` |
| `X-Poster-Ratio` | e.g. `9:16` | Expand only. The restore path ignores it — see §2.3 |
| `X-Expand-Amount` | `slight` \| `moderate` \| `wide` | Expand only. Anything else ⇒ `moderate` |
| `X-Expand-Capable` | `1` | The caller composites the frame, sends the mask and pastes the source back. Only such a caller may be given an expand on `auto` (§2.6) |
| `X-Enhance-Strength` | `0`–`1` | **Currently unused server-side.** Left over from the deleted self-hosted upscaler; the slider still moves and changes nothing |

### 2.2 Two stages

**Stage 1 — plan and describe.** `gpt-4o-mini`, `temperature 0.2`,
`max_tokens 500`, `response_format: json_object`, image at `detail: "low"`
(a 512px thumbnail — framing survives that downscale, grain does not, and
framing is what is being judged).

Returns `{ mode, amount, subject, description, reason, fit, size, posterRatio }`.
Any failure falls back to `restore`, so a broken planner degrades to the job
that reframes nothing. `fit: true` asks the browser to letterbox the result
instead of leaving it cropped (§2.6). `size` is the exact canvas the caller
must build for an expand — the browser has to match it or the model rescales
the composite and undoes the point of compositing it.

Stage 1 spends no image credits. It is a separate round trip precisely so the
decision and the geometry are settled before anything is billed.

**Stage 2 — edit.** Multipart: the composited frame, the alpha mask for an
expand, and the plan echoed back as fields so the vision stage is not paid for
twice. The description becomes context in the restore prompt, so the model is
told what it must not change.

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

### 2.4 Response

```json
{
  "image":   "data:image/png;base64,…",
  "engine":  "gpt-image-1.5",
  "quality": "high",
  "size":    "1536x1024",
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

### 2.5 Cost and latency

Billed per call, no free path. Prices are gpt-image-1.5 list, at the
portrait/landscape shapes this route asks for (1024x1536 / 1536x1024); a square
source resolves to 1024x1024 and costs less.

| `IMAGE_QUALITY` | Cost per enhance |
|---|---|
| `low` | ~$0.013 (produces clay faces — not recommended) |
| **`medium`** (default) | **~$0.05** |
| `high` | ~$0.20 (4× medium, for detail the poster gradient covers) |

Typically 20–90 seconds. The boot log states the engine and the real cost:
`Restore & Upscale: gpt-image (quality=medium, ~$0.05 each).`

The default was `high` between dbcdb0f and this change, on the same day the
free self-hosted upscaler was deleted. Those two together are what turned a
near-zero bill into a real one, and `medium` is the correction.

**Two guards sit in front of the paid call:**

- **Result cache.** Keyed on the input bytes plus every parameter that changes
  the answer or the price (quality included). A repeat press on the same photo
  is served from memory and reported to the reviewer as `(from cache, no
  charge)`. In-process, 1-hour TTL, evicted by total bytes.
- **Rate limit.** `ENHANCE_RATE_MAX` (default 40) billed enhances per user per
  hour, then a 429. Cache hits do not count against it, because they cost
  nothing. This is a spend cap, not a security control — the reviewer-only
  route gate is that.

### 2.6 Expand, and when `auto` picks it

**`auto` resolves to expand when the planner says so and the caller can
composite.** A landscape photograph on a 9:16 poster is the case this exists
for: the card keeps about a third of its width, so the choice is between
generating the parts that were never photographed and throwing away two thirds
of the ones that were. The plan response carries `mode: "expand"` and the
`size` the browser must build for.

`X-Expand-Capable: 1` is the gate. It says the caller composites the source
onto the resolved frame, sends the mask, and pastes the source back over the
return — the three things that make an expand safe. A caller that does not send
it (the legacy single-shot path, anything posting raw bytes) still gets **Fit**
on an expand verdict: the whole photograph, letterboxed, by arithmetic
(`fitZoomFor` in app.js), with `fit: true` on the response and nothing
generated past the edges. An unresolvable size falls to Fit the same way —
there is no canvas to pin the picture to. See "auto expands when the caller
composites" in server.mjs.

This was off for a period. `auto` never expanded between abe51a8 and this
change, because expand had twice returned the source as a framed print inside
an invented scene, and a verdict is a good enough reason to letterbox a picture
but not a good enough reason to let a model redraw the parts of one that do not
exist. What changed is that the model is no longer trusted with any of it —
`composeExpandResult` pastes the original back without asking — so the verdict
can be acted on rather than noted and discarded.

**The framed-print failure**, for the record. It was switched off in abe51a8 after two
published posters came back with the source photograph rendered as a **physical
print — hard white border and all** — inside a scene the model drew around it.
Measured on the poster, the surround carried *more* edge energy than the inset
(17.8 vs 12.6), so it was generated detail, not a blurred backdrop. Three
structural causes: the prompt asked the model to "place the supplied photograph
smaller within the output frame"; no mask or padded canvas was sent, so nothing
pinned the original pixels; and it requested the poster ratio, the same
condition that caused the overlay bug.

All three are now addressed. The browser composites the source onto a frame of
exactly the resolved size and sends an **alpha mask** that is opaque over the
source, so the model can only paint the margin; the prompt drops the placement
sentence because placement is already a fact; and `runEnhanceEdit` refuses an
expand that arrives without a composited frame, degrading to restore and saying
so. The model output is then laid back over that frame, so a transparent
margin or a refusal cannot leave a hole.

### 2.7 Where the picture is placed, and why not in the middle of the file

gpt-image sells three shapes. A 9:16 poster resolves to **1024x1536**, which is
2:3 — taller than the source but not as tall as the card, which is 920x1700. So
the card covers and clips: about a fifth of the frame's width goes over the
side, a quarter once `IMAGE_PAN_HEADROOM` is applied.

The photograph used to be placed at contain scale — full frame width — which
put *the photograph's own edges* across that boundary while the margin
generated for exactly this purpose sat safely in the middle. On a landscape
press photo of two people, one at each end, that is one person per edge. The
expand ran correctly and the card still arrived with someone cut in half.

Two numbers fix it, and they have to agree:

| | |
|---|---|
| `posterVisibleRect()` | what of the model's frame the card actually shows, in that frame's pixels, from the layout preset and `drawCoverImage`'s own arithmetic. `planExpandPlacement` fits the photograph inside **this**, not inside the frame |
| `EXPAND_COMMIT_ZOOM` | `ceil(100 / IMAGE_PAN_HEADROOM)` = **91%**, the zoom the result is committed at, and the zoom `posterVisibleRect` measures against. Ceiling, not floor: 90% puts the scale a hair under cover and letterboxes the card by 17px |

The generated margin absorbs the crop, which is what margin is for.

An expanded frame also gets its **focal point pinned to the centre**. Otherwise
`ensureImageFocalPoint` runs the face detector over the result and hands
`drawCoverImage` a face to centre the crop on, which pans the composition
sideways and takes the crop straight back off the edge of the photograph.

**Focal point, generally.** It reads the box containing *every* face, not
`faces[0]`. The focal point decides who survives a crop that keeps a third of
the width, and aiming it at whichever face the detector returned first turned a
landscape photograph of two people into a portrait of one of them. A single
face is unchanged — the union of one box is that box.

### 2.8 What resolution an expand comes back at

The 1536px cap in §2.1 is an **upload** limit — gpt-image's maximum input — and
for a while the paste-back inherited it, because the same downscaled canvas was
used for both. So the photograph arrived on the card at the resolution the API
imposed rather than the one the writer supplied: 830px of picture inside a
1024px frame, stretched over a 920px card and quadrupled again on export.

Layer 4 does not consult the model, so it has no reason to. It is now redrawn
from the writer's original at `expandOutputScale()`, and the whole composite is
rendered at that scale — layers 1 and 2 stretched with it, which costs nothing
real, since the bleed is blurred by construction and the margin is scenery.

The scale is the lower of two ceilings: the original's own pixel width, and
`EXPAND_MAX_EDGE` (**3072**), which bounds the PNG that is held in memory and
uploaded on Save.

| Original | Scale | Composite | Photo | 1× card | 2× X export | 4× export |
|---|---|---|---|---|---|---|
| *(before)* | — | 1024×1536 | 830px | 1.11× up | 2.22× up | 4.43× up |
| 1200px | 1.45 | 1480×2221 | 1200px | 0.77× | 1.53× up | 3.07× up |
| 1600px | 1.93 | 1974×2961 | 1600px | 0.57× | 1.15× up | 2.30× up |
| 2400px+ | 2.00 | 2048×3072 | 1660px | 0.55× | 1.11× up | 2.22× up |

The card and the X export are now effectively 1:1 or better. The 4× export is
still upscaled, and that is what `EXPAND_MAX_EDGE` is buying: covering it would
need a 4537×6805 composite — 31M pixels, ~120MB in memory before encoding, on
every enhance and every save. Raise the constant if the trade looks different
in practice; it is the only number involved.

**Two knock-on effects worth knowing.** The composite is now roughly 4× the
pixels it was, so each enhanced image is around 9MB as a PNG rather than ~2MB —
inside Storage's 50MB default object limit, but it is uploaded on Save, once
per image. And `canvasToImage` encodes through `toBlob` rather than
`toDataURL`, because a synchronous encode of 6M pixels froze the editor at the
end of the call. It still produces a `data:` URL: `describeMainImage` reads the
`data:` prefix to tell an enhance from an address, and a `blob:` URL would be
recorded as the picture's permanent address and die with the tab.

### 2.9 The model ladder, and migrating off it

Both rungs are deprecated. `gpt-image-1.5` and its siblings shut down **1 Dec
2026**, and every one of them names **`gpt-image-2`** as the replacement. The
route works today and stops working on a date.

So the ladder is configuration — `IMAGE_MODEL` / `IMAGE_MODEL_FALLBACK` — and
the migration is a Railway variable edit rather than a deploy. The default
stays on what is live and proven on this account; a model it has never called
is not the thing to discover in production.

**A one-line model swap does not work, and fails silently.** Two parameters
are not portable, so `callEdit()` derives them from the model:

| | gpt-image-1 / 1.5 | gpt-image-2 |
|---|---|---|
| `input_fidelity` | `high` — the identity-preservation control | **must be omitted.** The guide: *"omit this parameter; the API doesn't allow changing it because the model processes every image input at high fidelity automatically"* |
| `size` | three fixed shapes only | arbitrary `WxH`: edges multiples of 16, long edge ≤ 3840, aspect ≤ 3:1, 655,360–8,294,400 px |

Send `input_fidelity` to gpt-image-2 and every press 400s, falls through to the
deprecated rung, and keeps working — at which point the migration looks done
and has not started. Send an arbitrary size to the older rung and it 400s, the
mask-drop retry 400s, and a degraded route becomes a hard 502.
`nearestStandardSize()` is what stops that: every rung can answer the request
it is handed.

**What flipping it actually buys.** The three fixed shapes are why a 9:16 card
gets a 2:3 frame and trims a fifth of the width off — the mismatch
`posterVisibleRect()` exists to absorb. Asking for the poster's real shape
removes it:

| | as shipped | `IMAGE_MODEL=gpt-image-2` |
|---|---|---|
| expand, 9:16 | `1024x1536` — 18.5% off | `1088x1920` — **0.7% off** |
| expand, 16:9 | `1536x1024` — 15.6% off | `1920x1088` — 0.7% off |
| restore, 16:9 source | `1536x1024` — must invent ~15% of vertical content on the one job forbidden to invent | `1920x1088` — its own shape, and a real upscale past 1536 |

**Before flipping it in production**, run one masked expand and check the
response's `engine` field says `gpt-image-2` and not the fallback. The 400
branch now does double duty — model-unavailable *and* bad-parameter — so a
silent permanent fallback is the likely failure and `engine` is the only way
to see it. Confirm `quality` and `output_format` are accepted in the same test.

Known residual: on a fallback the client has composited at `1088x1920` while
the model returns `1024x1536`, so the drawn margin arrives at the wrong aspect
and is stretched. Layers 3 and 4 keep the photograph pixel-exact, so it
degrades to a soft margin rather than a broken poster.

Still to do when that gate passes: `public/app.js`'s 1536px upload cap should
rise with it, or gpt-image-2 is inventing detail from a 1536px input rather
than reading real pixels.

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
| `blurAt` / `blurCardWidth` | 16 / 382 | Blur quoted in the design's units and scaled to the canvas |
| `downscale` | 4 | Most of the blur comes free from downsampling; `ctx.filter` supplies the remainder |
| `refract` | 0.022 | How far the glass bends the picture, as a share of width |
| `refractStrips` | 56 | Depth resolution of the bend |
| `reach` | 2.2 | Multiplies the caller's fadeHeight — the dissolve length |

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
| `IMAGE_MODEL` | `gpt-image-1.5` | Primary rung of the model ladder. **Deprecated: shuts down 1 Dec 2026** — see §2.9 |
| `IMAGE_MODEL_FALLBACK` | `gpt-image-1` | Second rung, tried on 400/403/404. Also deprecated |
| `DISABLE_GPT_IMAGE` | unset | `true` switches the route off and returns 503 |
| `PEXELS_API_KEY` | — | Stock images; source skipped silently when unset |
| `FAL_KEY` | — | Flux generation |

---

## 8. Tests

No runner, no dependencies. Each exits non-zero on failure.

```bash
node test/image-fit.mjs   # fit/fill geometry, letterbox centring, pan clamp
node test/glass.mjs       # panel colour, mask sampling, device transform, fade
node test/render.mjs      # render coalescing, and that export stays synchronous
node test/enhance-params.mjs # cache identity, the model ladder, size negotiation
node test/expand-frame.mjs # expand placement, mask, paste-back, and the card crop
```

They execute the real functions pulled out of `public/app.js` rather than
reimplementing them, and read constants from the source — a test that hard-codes
the value it checks only proves the file was edited twice.
