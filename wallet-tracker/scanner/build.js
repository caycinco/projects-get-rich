import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFeed, canonicalFeed, emptyState } from "../lib/feed.js";
import { validateCohort } from "../lib/validate.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relative, fallback) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function loadParts() {
  const source = JSON.parse(fs.readFileSync(path.join(root, "source/fomolens-top30-2026-11-07.json"), "utf8"));
  const cohort = validateCohort(source);
  const state = readJson("data/state.json", emptyState());
  const entries = readJson("data/entries.json", []);
  const holdings = readJson("data/holdings.json", { baseline: {}, latest: {} });
  const pools = readJson("data/pools.json", {});
  const nowMs = state.last_attempt_at ? Date.parse(state.last_attempt_at) : Date.parse("2026-11-07T16:51:18Z");
  return { cohort, state, entries, holdings, pools, nowMs };
}

export function writeFeed(parts = loadParts()) {
  const feed = buildFeed(parts);
  const text = canonicalFeed(feed);
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data/feed.json"), text);
  return { feed, text };
}

function assertPublishable(feed) {
  if (feed.demo) throw new Error("demo feed cannot be published");
  if (feed.cohort.counts.traders !== 30) throw new Error("cohort drifted from 30 traders");
  if (feed.cohort.counts.solana !== 29) throw new Error("expected 29 Solana wallets");
  if (feed.cohort.counts.quarantine !== 0) throw new Error("published cohort has quarantined addresses");
  const quarantined = new Set(feed.cohort.quarantine.map((row) => row.address));
  for (const entry of feed.entries) {
    if (quarantined.has(entry.wallet) || quarantined.has(entry.mint)) throw new Error("quarantined value leaked into entries");
    if (entry.classification !== "confirmed_swap") throw new Error("feed contains a non-swap entry");
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const checking = process.argv.includes("--check");
  const parts = loadParts();
  assertPublishable(buildFeed(parts));
  if (checking) {
    const next = canonicalFeed(buildFeed(parts));
    const current = fs.readFileSync(path.join(root, "data/feed.json"), "utf8");
    if (current !== next) {
      console.error("data/feed.json does not match state, entries, holdings, and pools. Run node scanner/build.js.");
      process.exit(1);
    }
    console.log(`feed ok · ${parts.cohort.counts.solana} solana wallets · coverage ${buildFeed(parts).coverage.status}`);
  } else {
    const { feed } = writeFeed(parts);
    console.log(`wrote data/feed.json · coverage ${feed.coverage.status} · buys ${feed.stats.confirmed_post_baseline_buys}`);
  }
}
