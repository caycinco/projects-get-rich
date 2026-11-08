import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildFeed, emptyState } from "../lib/feed.js";
import { validateCohort } from "../lib/validate.js";
import { renderRoster } from "../lib/view.js";

test("the page shell loads the published feed and keeps motion optional", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const workflow = fs.readFileSync(new URL("../../.github/workflows/wallet-tracker.yml", import.meta.url), "utf8");
  assert.match(app, /data\/feed\.json/);
  assert.match(app, /demo === true/);
  assert.doesNotMatch(html, /fixture/i);
  assert.doesNotMatch(app, /fixtures\//);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(workflow, /cron: "17 \* \* \* \*"/);
  assert.match(workflow, /timeout-minutes: 12/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /secrets\./);
});

test("the initial roster renders every handle without inventing buys", () => {
  const source = JSON.parse(fs.readFileSync(new URL("../source/fomolens-top30-2026-11-07.json", import.meta.url), "utf8"));
  const feed = buildFeed({ cohort: validateCohort(source), state: emptyState(), nowMs: Date.parse("2026-11-07T16:51:18Z") });
  const html = renderRoster(feed.wallet_status);
  for (const trader of feed.cohort.traders) assert.match(html, new RegExp(trader.handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /no Solana address/);
  assert.equal(feed.stats.confirmed_post_baseline_buys, null);
  assert.equal(feed.demo, false);
});
