/* ── The server half of AI Enhance: cache identity and the model ladder ─────

   Run: node test/enhance-params.mjs

   Every other test in this directory drives client geometry. Nothing covered
   the server, and the gap had a cost: `enhanceCacheKey` was handed the
   `{ buffer, mime }` wrapper that `readEnhanceEdit` resolves, passed it
   straight to `hash.update()`, and threw

       ERR_INVALID_ARG_TYPE — The "data" argument must be of type string or an
       instance of Buffer, TypedArray, or DataView. Received an instance of
       Object

   before OpenAI was ever called. Every masked expand 500d. The feature could
   not have worked on any deploy, and the first assertion below is three lines
   long.

   The second half guards the migration off the deprecated ladder.
   `gpt-image-1.5` and its siblings shut down on 1 Dec 2026, all naming
   `gpt-image-2` as the replacement, and that model differs in two ways that
   are silent when you get them wrong:

     input_fidelity   gpt-image-2 REJECTS it ("omit this parameter; the API
                      doesn't allow changing it because the model processes
                      every image input at high fidelity automatically"), so a
                      one-line model swap 400s on every press and falls back to
                      the deprecated rung forever, looking migrated
     size             gpt-image-2 takes arbitrary WxH; the older rungs take
                      three fixed shapes. A size chosen for one and sent to the
                      other is a 400, and the retry ladder turns that into a
                      hard 502

   So the parameters must be derived from the model, and every rung must be
   able to answer the request it is handed. That is what is asserted here.   */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const server = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs"),
  "utf8",
);

function fnSrc(name) {
  const a = server.indexOf("function " + name);
  if (a < 0) throw new Error("missing function " + name);
  let k = server.indexOf(") {", a) + 2, d = 0;
  for (let j = k; j < server.length; j++) {
    if (server[j] === "{") d++;
    else if (server[j] === "}") { d--; if (!d) return server.slice(a, j + 1); }
  }
  throw new Error("unbalanced braces in " + name);
}

/* Read from the source rather than restated here — a test that hard-codes the
   value it checks only proves the file was edited twice. */
const ENHANCE_SIZES = new Set(
  JSON.parse(
    server.match(/^const ENHANCE_SIZES = new Set\((\[[^\]]+\])\);/m)[1].replace(/'/g, '"'),
  ),
);

const api = new Function(
  "createHash", "ENHANCE_SIZES", `
    ${fnSrc("enhanceCacheKey")}
    ${fnSrc("gptImage2Size")}
    ${fnSrc("nearestStandardSize")}
    ${fnSrc("validEnhanceSize")}
    const isGptImage2 = ${server.match(/^const isGptImage2 = (.+);$/m)[1]};
    return { enhanceCacheKey, gptImage2Size, nearestStandardSize, validEnhanceSize, isGptImage2 };
  `,
)(createHash, ENHANCE_SIZES);

let pass = 0, fail = 0;
const ck = (n, c, d = "") => {
  if (c) { pass++; console.log("  PASS " + n); }
  else { fail++; console.log("  FAIL " + n + " :: " + d); }
};

const IMAGE = Buffer.from("pretend png bytes, long enough to be an image");
const MASK = Buffer.from("pretend mask bytes");
const PARTS = { job: "expand", amount: "moderate", subject: "people", size: "1024x1536" };

console.log("\nThe cache key survives a mask — the crash that made expand unreachable");
{
  // Exactly what readEnhanceEdit() resolves: bytes in a wrapper, not bytes.
  const wrapper = { buffer: MASK, mime: "image/png" };
  let threw = null, key = null;
  try { key = api.enhanceCacheKey(IMAGE, wrapper, PARTS); } catch (e) { threw = e; }
  ck("a { buffer, mime } wrapper does not throw",
     !threw, threw ? `${threw.code}: ${String(threw.message).split("\n")[0]}` : "");
  ck("and returns a sha256 hex digest",
     typeof key === "string" && /^[0-9a-f]{64}$/.test(key), String(key));

  const raw = api.enhanceCacheKey(IMAGE, MASK, PARTS);
  ck("a wrapper and its raw buffer are the same request",
     raw === key, `${String(raw).slice(0, 16)} vs ${String(key).slice(0, 16)}`);

  const none = api.enhanceCacheKey(IMAGE, null, PARTS);
  ck("masked and unmasked are NOT the same request",
     none !== key, "the mask is in the key precisely so these differ");

  const other = api.enhanceCacheKey(IMAGE, Buffer.from("a different mask"), PARTS);
  ck("two different masks are two different requests", other !== key);

  /* The tempting one-liner, held to the wall. `mask.buffer || mask` reads as
     "unwrap if wrapped" and is wrong twice over: a real Buffer's .buffer is
     the 64KB pooled ArrayBuffer it was allocated from, which hash.update()
     rejects outright — so it reintroduces the crash by another route. */
  let poolThrew = null;
  try { createHash("sha256").update(MASK.buffer); } catch (e) { poolThrew = e; }
  ck("hash.update() really does reject a raw ArrayBuffer",
     Boolean(poolThrew), "if this ever passes, the `mask.buffer || mask` trap is gone");
}

console.log("\nEvery rung can answer the request it is handed");
{
  ck("gpt-image-2 is recognised", api.isGptImage2("gpt-image-2") &&
     api.isGptImage2("gpt-image-2-2026-04-21"));
  ck("the deprecated rungs are not",
     !api.isGptImage2("gpt-image-1.5") && !api.isGptImage2("gpt-image-1"));

  // An arbitrary size chosen for gpt-image-2 must degrade to something the
  // older rungs accept, or the fallback 400s and the retry ladder 502s.
  for (const [size, want] of [
    ["1088x1920", "1024x1536"],
    ["1920x1088", "1536x1024"],
    ["1024x1024", "1024x1024"],
    ["2048x2048", "1024x1024"],
    ["auto", "auto"],
  ]) {
    const got = api.nearestStandardSize(size);
    ck(`${size} degrades to ${want}`, got === want, `got ${got}`);
    ck(`  and ${got} is legal for gpt-image-1.5`, ENHANCE_SIZES.has(got));
  }
}

console.log("\nThe gpt-image-2 size builder honours the documented constraints");
{
  const nine16 = api.gptImage2Size(1080, 1920);
  ck("a real 9:16 is expressible at all", Boolean(nine16), String(nine16));
  if (nine16) {
    const [w, h] = nine16.split("x").map(Number);
    ck("both edges are multiples of 16", w % 16 === 0 && h % 16 === 0, nine16);
    ck("the long edge is within 3840", Math.max(w, h) <= 3840, nine16);
    ck("the pixel count is in range",
       w * h >= 655_360 && w * h <= 8_294_400, `${w * h} px`);
    ck("and it is much closer to 9:16 than the 2:3 the old rungs force",
       Math.abs(w / h - 9 / 16) < Math.abs(1024 / 1536 - 9 / 16),
       `${(w / h).toFixed(4)} vs 2:3 ${(1024 / 1536).toFixed(4)}, target ${(9 / 16).toFixed(4)}`);
  }

  ck("a 4:1 panorama is refused (3:1 is the cap)",
     api.gptImage2Size(4000, 1000) === null, String(api.gptImage2Size(4000, 1000)));
  ck("something tiny is refused (655,360 px floor)",
     api.gptImage2Size(320, 320) === null, String(api.gptImage2Size(320, 320)));
  const huge = api.gptImage2Size(8000, 4500);
  ck("something enormous is scaled under 3840, not refused outright",
     huge !== null && Math.max(...huge.split("x").map(Number)) <= 3840, String(huge));
}

console.log("\nStage 2 accepts a size the client can actually have composited to");
{
  for (const s of ["1024x1536", "1536x1024", "1024x1024", "auto"]) {
    ck(`${s} survives validation`, api.validEnhanceSize(s) === s);
  }
  const legal = api.gptImage2Size(1088, 1920);
  ck(`a legal gpt-image-2 size (${legal}) survives validation`,
     api.validEnhanceSize(legal) === legal, api.validEnhanceSize(legal));

  /* Coercion to "auto" is not harmless: the browser has already built its
     frame at the size the plan named, and "auto" lets the model rescale that
     composite — which is the whole thing compositing exists to prevent. */
  for (const junk of ["999x999", "1000x1000", "banana", "", "1024 x 1536", "99999x99999"]) {
    ck(`"${junk}" is refused rather than passed through`,
       api.validEnhanceSize(junk) === "auto", api.validEnhanceSize(junk));
  }
}

/* ── The migration has to be worth flipping ──────────────────────────────

   Making the ladder configurable is only half of it. If IMAGE_MODEL=gpt-image-2
   changes which model runs and nothing else, the migration is done and the
   product gained nothing — the frame is still the 2:3 that a 9:16 card trims a
   fifth of the width off.

   So the size functions read the rung too, and both directions are asserted:
   TODAY's default must be byte-identical to what shipped (this is a live
   route; a config-only change must not move the picture), and the flipped
   default must actually deliver the shape the poster asked for.            */

/* Evaluated, not JSON.parsed: the source writes these as arithmetic
   (`"9:16": 9 / 16`), which is the readable form and not valid JSON. Still
   read from the source rather than restated — the point is that the test
   cannot disagree with the file about what 9:16 means. */
const RATIO_VALUES = new Function(
  "return " + server.match(/^const RATIO_VALUES = (\{[^}]+\});/m)[1],
)();

function sizeApiFor(model) {
  return new Function("ENHANCE_SIZES", "IMAGE_MODEL_PRIMARY", "RATIO_VALUES", `
    const isGptImage2 = ${server.match(/^const isGptImage2 = (.+);$/m)[1]};
    ${fnSrc("gptImage2Size")}
    ${fnSrc("nearestStandardSize")}
    ${fnSrc("sizeForExpand")}
    ${fnSrc("sizeForRatio")}
    return { sizeForExpand, sizeForRatio, nearestStandardSize };
  `)(ENHANCE_SIZES, model, RATIO_VALUES);
}

const legacy = sizeApiFor("gpt-image-1.5");
const next = sizeApiFor("gpt-image-2");

console.log("\nAs shipped, nothing moves — the default rung is unchanged");
{
  for (const [ratio, want] of [
    ["9:16", "1024x1536"], ["4:5", "1024x1536"],
    ["1:1", "1024x1024"], ["16:9", "1536x1024"],
  ]) {
    ck(`expand ${ratio} still asks for ${want}`,
       legacy.sizeForExpand(ratio, "landscape") === want,
       legacy.sizeForExpand(ratio, "landscape"));
  }
  ck("restore of a 16:9 source still asks for 1536x1024",
     legacy.sizeForRatio("", "landscape", 1536, 864) === "1536x1024",
     legacy.sizeForRatio("", "landscape", 1536, 864));
  ck("a square source is still billed at the cheap square shape",
     legacy.sizeForRatio("", "landscape", 1000, 1000) === "1024x1024");
  ck("an unknown source is still left to the model",
     legacy.sizeForRatio("", "", 0, 0) === "auto");
}

console.log("\nFlipped to gpt-image-2, the frame becomes the shape the poster is");
{
  for (const ratio of Object.keys(RATIO_VALUES)) {
    const got = next.sizeForExpand(ratio, "landscape");
    const [w, h] = got.split("x").map(Number);
    const err = Math.abs(w / h - RATIO_VALUES[ratio]) / RATIO_VALUES[ratio];
    const wasErr = (() => {
      const [lw, lh] = legacy.sizeForExpand(ratio, "landscape").split("x").map(Number);
      return Math.abs(lw / lh - RATIO_VALUES[ratio]) / RATIO_VALUES[ratio];
    })();
    ck(`expand ${ratio} -> ${got}, within 2% of the real ratio`, err < 0.02,
       `${(err * 100).toFixed(1)}% off`);
    ck(`  and no worse than the ${legacy.sizeForExpand(ratio, "landscape")} it replaces`,
       err <= wasErr, `${(err * 100).toFixed(1)}% vs ${(wasErr * 100).toFixed(1)}%`);
    ck(`  and the fallback rung can still answer it`,
       ENHANCE_SIZES.has(next.nearestStandardSize(got)),
       next.nearestStandardSize(got));
  }

  /* The restore defect this closes: a 16:9 source asked back at 3:2 has to
     grow ~15% of vertical content on the one job whose whole prompt forbids
     inventing anything. */
  const r = next.sizeForRatio("", "landscape", 1536, 864);
  const [rw, rh] = r.split("x").map(Number);
  ck(`restore of a 16:9 source -> ${r}, matching its own shape`,
     Math.abs(rw / rh - 1536 / 864) / (1536 / 864) < 0.02,
     `${(rw / rh).toFixed(3)} vs ${(1536 / 864).toFixed(3)}`);
  ck("  and it is a real upscale, not a reshape at the same size",
     Math.max(rw, rh) > 1536, `long edge ${Math.max(rw, rh)}`);

  ck("a square source still takes the cheap square shape on either rung",
     next.sizeForRatio("", "landscape", 1000, 1000) === "1024x1024",
     next.sizeForRatio("", "landscape", 1000, 1000));
  ck("an unknown source is still left to the model",
     next.sizeForRatio("", "", 0, 0) === "auto");

  // A shape too extreme for gpt-image-2's 3:1 cap must fall through to the
  // standard shapes rather than return null and poison the request.
  const pano = next.sizeForRatio("", "landscape", 3000, 600);
  ck(`a 5:1 panorama falls back to a legal standard shape (${pano})`,
     ENHANCE_SIZES.has(pano), pano);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
