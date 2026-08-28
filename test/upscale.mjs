/* ── The upscale half of Restore & Upscale ───────────────────────────────────

   Run: node test/upscale.mjs      (needs ffmpeg on PATH, as the server does)

   gpt-image caps its output at 1536px on the long edge, and the browser caps
   the upload to match, so a 3000x2000 press photograph comes back 1536x1024 —
   restored, and smaller than it started. The enlargement afterwards is the
   only thing that makes the button's name true, which is why it is tested
   rather than trusted.

   Executes the real function out of server.mjs against real ffmpeg. */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "server.mjs"), "utf8");
function fnSrc(name) {
  const a = src.indexOf("async function " + name);
  let k = src.indexOf(") {", a) + 2, d = 0;
  for (let j = k; j < src.length; j++) {
    if (src[j] === "{") d++;
    else if (src[j] === "}") { d--; if (!d) return src.slice(a, j + 1); }
  }
}
const runSrc = (() => {
  const a = src.indexOf("function run(bin, args, timeoutMs)");
  let k = src.indexOf(") {", a) + 2, d = 0;
  for (let j = k; j < src.length; j++) {
    if (src[j] === "{") d++;
    else if (src[j] === "}") { d--; if (!d) return src.slice(a, j + 1); }
  }
})();
const consts = src.split("\n").filter(l => l.startsWith("const UPSCALE_")).join("\n");

function build(ffmpegAvailable = true) {
  return new Function(
    "readFileSync","writeFileSync","mkdirSync","existsSync","rmSync","join","tmpdir",
    "randomUUID","spawn","console","ffmpegAvailable","env",
    `${consts}\n${runSrc}\n${fnSrc("enlargeRestoredImage")}\nreturn enlargeRestoredImage;`
  )(readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, join, tmpdir,
    randomUUID, spawn, { log(){}, warn(){} }, ffmpegAvailable, () => "");
}

// Scratch space of our own, removed at the end.
const dir = join(tmpdir(), "pix-upscale-test-" + randomUUID().slice(0, 8));
mkdirSync(dir, { recursive: true });
const sh = (cmd, args) => new Promise(r => { const p = spawn(cmd, args); p.on("close", r); });
const dims = async (f) => new Promise(r => {
  const p = spawn("ffprobe", ["-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","csv=p=0:s=x", f]);
  let o = ""; p.stdout.on("data", d => o += d); p.on("close", () => r(o.trim()));
});

let pass = 0, fail = 0;
const ck = (n,c,d="") => { if(c){pass++;console.log("  PASS "+n);} else {fail++;console.log("  FAIL "+n+" :: "+d);} };

// A 1536x1024 PNG, which is exactly what gpt-image returns for a landscape.
const modelOut = join(dir, "model.png");
await sh("ffmpeg", ["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","testsrc2=size=1536x1024","-frames:v","1", modelOut]);

console.log("\nThe model's output is actually enlarged");
{
  const enlarge = build(true);
  const r = await enlarge(readFileSync(modelOut));
  ck("it returned an enlarged image", !!r, "got null");
  if (r) {
    ck("long edge reaches the target", Math.max(r.width, r.height) >= 3300,
      `${r.width}x${r.height}`);
    ck("aspect ratio is preserved",
      Math.abs((r.width / r.height) - (1536 / 1024)) < 0.01,
      (r.width / r.height).toFixed(3) + " vs " + (1536/1024).toFixed(3));
    ck("more pixels than the model gave", r.width * r.height > 1536 * 1024,
      `${(r.width*r.height/1e6).toFixed(1)}MP vs 1.6MP`);
    ck("dimensions are even", r.width % 2 === 0 && r.height % 2 === 0);
    writeFileSync(join(dir, "out.png"), r.buffer);
    ck("the bytes really are that size", (await dims(join(dir,"out.png"))) === `${r.width}x${r.height}`);
  }
}

console.log("\nIt declines when enlarging would buy nothing");
{
  const big = join(dir, "big.png");
  await sh("ffmpeg", ["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","testsrc2=size=3400x2200","-frames:v","1", big]);
  const enlarge = build(true);
  ck("already at target -> untouched", (await enlarge(readFileSync(big))) === null);
}

console.log("\nIt fails soft, never throws");
{
  ck("no ffmpeg -> null", (await build(false)(readFileSync(modelOut))) === null);
  ck("garbage input -> null", (await build(true)(Buffer.from("not a png"))) === null);
}

try { rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
