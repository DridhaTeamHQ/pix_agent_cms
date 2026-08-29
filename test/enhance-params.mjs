/* ── The server half of AI Enhance: cache identity and output shape ─────────

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

   The second half holds down the output shape. `size` is chosen in the plan
   stage, the browser composites its frame at exactly that size, and stage 2
   validates it again on the way back — three places that have to agree. If
   they ever stop agreeing the model rescales the composite, which is the one
   thing compositing exists to prevent, so what is asserted is that every size
   the plan can emit is a size stage 2 will accept.                          */

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
    return { enhanceCacheKey };
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
/* ── The shapes the route asks gpt-image-1.5 for ─────────────────────────

   Three fixed shapes is all this model family sells, so these functions are
   a mapping and not a negotiation. What is worth holding down is that the
   mapping does not drift: `size` is chosen in the plan stage, the browser
   composites its frame at exactly that size, and stage 2 validates it again
   on the way back. If those three ever disagree the model rescales the
   composite, which is the one thing compositing exists to prevent.        */

const RATIO_VALUES = new Function(
  // Evaluated, not JSON.parsed: the source writes these as arithmetic
  // (`"9:16": 9 / 16`), which is readable and is not valid JSON.
  "return " + server.match(/^const RATIO_VALUES = (\{[^}]+\});/m)[1],
)();

const sizes = new Function("ENHANCE_SIZES", "RATIO_VALUES", `
  ${fnSrc("sizeForExpand")}
  ${fnSrc("sizeForRatio")}
  return { sizeForExpand, sizeForRatio };
`)(ENHANCE_SIZES, RATIO_VALUES);

console.log("\nExpand asks for the shape nearest the poster");
for (const [ratio, want] of [
  ["9:16", "1024x1536"], ["4:5", "1024x1536"],
  ["1:1", "1024x1024"], ["16:9", "1536x1024"],
]) {
  const got = sizes.sizeForExpand(ratio, "landscape");
  ck(`${ratio} -> ${want}`, got === want, got);
  ck(`  and ${got} is a shape the model sells`, ENHANCE_SIZES.has(got));
}
ck("no poster ratio falls back to the source's orientation",
   sizes.sizeForExpand("", "landscape") === "1536x1024" &&
   sizes.sizeForExpand("", "portrait") === "1024x1536");

console.log("\nRestore follows the SOURCE, never the poster");
{
  ck("a landscape source", sizes.sizeForRatio("", "landscape", 1536, 864) === "1536x1024");
  ck("a portrait source", sizes.sizeForRatio("", "portrait", 864, 1536) === "1024x1536");
  /* The square guard, and it is not cosmetic: the browser only ever reports
     "landscape" or "portrait" (rawW >= rawH), so without this a square logo
     was billed at 1536x1024 AND asked to grow sideways. */
  ck("a square source takes the square shape, which is also the cheapest",
     sizes.sizeForRatio("", "landscape", 1000, 1000) === "1024x1024");
  ck("and near-square counts as square",
     sizes.sizeForRatio("", "landscape", 1020, 1000) === "1024x1024");
  ck("an unknown source is left to the model rather than guessed from the poster",
     sizes.sizeForRatio("", "", 0, 0) === "auto");
}

console.log("\nEvery size the plan can emit is one stage 2 will accept back");
{
  const emitted = new Set();
  for (const r of ["9:16", "4:5", "1:1", "16:9", ""]) {
    for (const o of ["landscape", "portrait", ""]) {
      emitted.add(sizes.sizeForExpand(r, o));
      emitted.add(sizes.sizeForRatio(r, o, 1536, 864));
      emitted.add(sizes.sizeForRatio(r, o, 1000, 1000));
    }
  }
  for (const size of emitted) {
    ck(`the plan can emit "${size}", and stage 2 keeps it`,
       ENHANCE_SIZES.has(size),
       "stage 2 would coerce this to auto and let the model rescale the composite");
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
