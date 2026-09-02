import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load } from "cheerio";

const $ = load(readFileSync(new URL("../public/index.html", import.meta.url), "utf8"));
const card = $('.preview-card[data-preview-mode="x"]');
const link = card.find("a.preview-card-x-link");
let passed = 0;
let failed = 0;

function check(name, test) {
  try {
    test();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

check("one redirect, only inside the X preview", () => {
  assert.equal(link.length, 1);
  assert.equal($(".preview-card-x-link").length, 1);
});
check("redirect follows the X download beneath the canvas", () => {
  const download = link.prev();
  assert.equal(download.attr("data-download"), "x");
  assert.equal(download.prev().find("#x-canvas").length, 1);
});
check("redirect opens the X composer", () => {
  assert.equal(link.attr("href"), "https://x.com/intent/tweet");
});
check("new tab is isolated from Pix", () => {
  assert.equal(link.attr("target"), "_blank");
  const rel = link.attr("rel").split(/\s+/);
  assert.ok(rel.includes("noopener"));
  assert.ok(rel.includes("noreferrer"));
});
check("accessible label describes the new tab", () => {
  assert.equal(link.text().trim(), "Open X");
  assert.match(link.attr("aria-label"), /X composer.*new tab/);
  assert.match(link.attr("title"), /attach the downloaded Pix/);
});
check("download remains separate from redirect", () => {
  assert.equal(card.find('button[data-download="x"]').length, 1);
  assert.equal(link.attr("data-download"), undefined);
  assert.equal(link.attr("download"), undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
