import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildMintCards } from "../lib/confluence.js";
import { bannerCopy, buildFeed, coverageFromState, emptyState } from "../lib/feed.js";
import { qualifyPool, reduceDexPairs } from "../lib/qualify.js";
import { validateCohort } from "../lib/validate.js";
import { displayCount, emptyCopy, escapeHtml, filterCards, holderLabel, sortCards, windowLabel } from "../lib/view.js";

const NOW = Date.parse("2026-11-07T18:00:00Z");

function entry(partial) {
  return {
    classification: "confirmed_swap",
    confidence: "confirmed",
    signature: partial.signature,
    wallet: partial.wallet,
    handle: partial.handle,
    rank: partial.rank,
    mint: partial.mint,
    block_time: partial.block_time,
    block_time_confidence: partial.block_time ? "confirmed" : "unknown",
    quote_legs: [{ symbol: "SOL", spent_ui: "0.2", spent_raw: "200000000", decimals: 9 }],
    received_ui: "1000",
    links: {
      tx_solscan: `https://solscan.io/tx/${partial.signature}`,
      tx_explorer: `https://explorer.solana.com/tx/${partial.signature}`,
    },
    ...partial,
  };
}

test("the fixed cohort keeps 29 solana wallets, emptybags as evm-only, and no padded addresses", () => {
  const source = JSON.parse(fs.readFileSync(new URL("../source/fomolens-top30-2026-11-07.json", import.meta.url), "utf8"));
  const cohort = validateCohort(source);
  assert.equal(cohort.counts.traders, 30);
  assert.equal(cohort.counts.solana, 29);
  assert.equal(cohort.counts.evm_only, 1);
  assert.equal(cohort.counts.quarantine, 0);
  assert.equal(cohort.ownership_verified, false);
  const stale = cohort.traders.filter((trader) => trader.stale_sample).map((trader) => trader.handle);
  assert.deepEqual(stale, ["CivilOpenPig", "TheMilesBron"]);
  const spicy = cohort.solana.find((row) => row.handle === "Spicy_Rich");
  assert.equal(spicy.address.length, 43);
  const emptybags = cohort.traders.find((trader) => trader.handle === "emptybags");
  assert.equal(emptybags.evm_only, true);
  assert.equal(emptybags.solana_addresses.length, 0);
});

test("invalid addresses are quarantined and never padded into the scan set", () => {
  const cohort = validateCohort([{
    rank: 99,
    handle: "bad",
    wallets: [
      { chain: "Solana", address: "short" },
      { chain: "Solana", address: `0OIl${"1".repeat(40)}` },
      { chain: "EVM", address: "0x1234" },
      { chain: "EVM", address: "0x91ee110b3f336f6e095e3df00ab1f155640db7fd" },
    ],
  }]);
  assert.equal(cohort.solana.length, 0);
  assert.equal(cohort.quarantine.length, 3);
  assert.equal(cohort.traders[0].wallets.length, 1);
  assert.equal(cohort.traders[0].wallets[0].chain, "evm");
  assert.ok(cohort.quarantine.every((row) => row.address !== "short".padEnd(32, "1")));
});

test("confluence counts distinct wallets and ignores repeated transactions", () => {
  const mint = "Mint111111111111111111111111111111111111111";
  const cards = buildMintCards({
    nowMs: NOW,
    entries: [
      entry({ signature: "a", wallet: "W1", handle: "one", rank: 1, mint, block_time: "2026-11-07T17:50:00Z" }),
      entry({ signature: "b", wallet: "W1", handle: "one", rank: 1, mint, block_time: "2026-11-07T17:40:00Z" }),
      entry({ signature: "c", wallet: "W1", handle: "one", rank: 1, mint, block_time: "2026-11-07T17:20:00Z" }),
    ],
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].distinct_wallets, 1);
  assert.equal(cards[0].tx_count, 3);
  assert.equal(cards[0].confluence, false);
  assert.equal(cards[0].highlight, false);
});

test("two wallets highlight only when pool age and verified market cap both qualify", () => {
  const mint = "Mint111111111111111111111111111111111111111";
  const entries = [
    entry({ signature: "a", wallet: "W1", handle: "one", rank: 1, mint, block_time: "2026-11-07T17:50:00Z" }),
    entry({ signature: "b", wallet: "W2", handle: "two", rank: 3, mint, block_time: "2026-11-07T16:00:00Z" }),
  ];
  const fresh = {
    earliest_pool_at: "2026-11-07T12:00:00Z",
    market_cap_usd: 250_000,
    fdv_usd: 9_000_000,
  };
  const cards = buildMintCards({
    nowMs: NOW,
    entries,
    pools: { [mint]: fresh },
    holdings: { latest: { W1: { status: "ok", accounts: [{ mint, amount_raw: "5" }] } } },
  });
  assert.equal(cards[0].distinct_wallets, 2);
  assert.equal(cards[0].window_buyers, 1);
  assert.equal(cards[0].outside_window, 1);
  assert.equal(cards[0].holding, 1);
  assert.equal(cards[0].holder_unknown, 1);
  assert.equal(cards[0].highlight, true);
  assert.equal(cards[0].qualification.fdv_qualifies_low_cap, false);

  const fdvOnly = buildMintCards({
    nowMs: NOW,
    entries,
    pools: { [mint]: { earliest_pool_at: fresh.earliest_pool_at, market_cap_usd: null, fdv_usd: 10_000 } },
  });
  assert.equal(fdvOnly[0].qualification.is_low_cap, null);
  assert.equal(fdvOnly[0].highlight, false);
  assert.equal(windowLabel(fdvOnly[0]), "1");
  assert.equal(holderLabel(fdvOnly[0]), "unknown");
});

test("unknown buy times are excluded from the rolling window instead of counted as zero evidence", () => {
  const mint = "Mint111111111111111111111111111111111111111";
  const cards = buildMintCards({
    nowMs: NOW,
    entries: [
      entry({ signature: "a", wallet: "W1", handle: "one", mint, block_time: null }),
      entry({ signature: "b", wallet: "W2", handle: "two", mint, block_time: null }),
    ],
  });
  assert.equal(cards[0].distinct_wallets, 2);
  assert.equal(cards[0].window_buyers, 0);
  assert.equal(windowLabel(cards[0]), "unknown");
  assert.equal(holderLabel(cards[0]), "unknown");
});

test("market cap is not taken from FDV or from the other side of a pair", () => {
  const mint = "Mint111111111111111111111111111111111111111";
  const reduced = reduceDexPairs([
    {
      baseToken: { address: "Other11111111111111111111111111111111111111", symbol: "OTHER" },
      quoteToken: { address: mint },
      marketCap: 100,
      fdv: 100,
      pairCreatedAt: NOW - 60_000,
      liquidity: { usd: 50_000 },
      url: "https://dexscreener.com/solana/pair",
    },
  ], mint, "2026-11-07T18:00:00Z");
  assert.equal(reduced.market_cap_usd, null);
  assert.equal(reduced.fdv_usd, null);
  assert.equal(reduced.symbol_label, null);
  assert.ok(reduced.earliest_pool_at);
  const qualified = qualifyPool(reduced, undefined, NOW);
  assert.equal(qualified.is_low_cap, null);
  assert.equal(qualified.highlight_eligible, false);

  const direct = reduceDexPairs([{
    baseToken: { address: mint, symbol: "REAL" },
    marketCap: 2_500_000,
    fdv: 100,
    pairCreatedAt: NOW - 2 * 3_600_000,
    liquidity: { usd: 10 },
    url: "https://dexscreener.com/solana/real",
  }], mint, "2026-11-07T18:00:00Z");
  const above = qualifyPool(direct, undefined, NOW);
  assert.equal(above.is_low_cap, false);
  assert.equal(above.is_new, true);
  assert.equal(direct.symbol_label, "REAL");
});

test("never-scanned and stale states do not pretend the book is live or zero", () => {
  const fresh = coverageFromState(emptyState(), NOW);
  assert.equal(fresh.status, "never_scanned");
  assert.equal(fresh.counts_known, false);
  assert.equal(fresh.stale, false);
  const cohort = validateCohort([]);
  const feed = buildFeed({ cohort, state: emptyState(), nowMs: NOW });
  assert.equal(feed.demo, false);
  assert.equal(feed.stats.confirmed_post_baseline_buys, null);
  assert.equal(displayCount(feed.stats.confirmed_post_baseline_buys), "unknown");
  assert.match(bannerCopy(fresh).detail, /unknown/);
  assert.match(emptyCopy(fresh, "confluence"), /unknown/);

  const state = {
    ...emptyState(),
    last_attempt_at: "2026-11-07T12:00:00Z",
    last_success_at: "2026-11-07T12:00:00Z",
    wallets: {
      W1: { role: "solana", coverage: "ok", token_accounts_status: "ok", last_success_at: "2026-11-07T12:00:00Z", history_gap: false },
    },
  };
  const stale = coverageFromState(state, NOW, 180);
  assert.equal(stale.status, "stale");
  const capped = coverageFromState({
    ...emptyState(),
    last_attempt_at: "2026-11-07T18:00:00Z",
    last_success_at: "2026-11-07T18:00:00Z",
    wallets: {
      W1: { role: "solana", coverage: "partial", ata_capped: true, token_accounts_status: "ok", last_success_at: "2026-11-07T18:00:00Z", history_gap: false },
    },
  }, Date.parse("2026-11-07T18:10:00Z"));
  assert.equal(capped.status, "partial");
  assert.deepEqual(capped.reasons, ["associated-token scan capped"]);
  assert.match(bannerCopy(capped).detail, /associated-token scan capped/);
  assert.doesNotMatch(bannerCopy(capped).detail, /did not finish/);
  assert.equal(stale.counts_known, true);
  assert.equal(stale.observed_counts_are_complete, false);
  assert.match(bannerCopy(stale).title, /STALE/);
});

test("filters keep highlight rules and sorting leaves unknown caps at the bottom", () => {
  const cards = [
    { mint: "b", distinct_wallets: 2, confluence: true, highlight: false, qualification: { unknown_reasons: ["market_cap_unknown"], market_cap_usd: null, pool_age_hours: null }, buyers: [{ handle: "Ada" }], earliest: null, pool: null },
    { mint: "a", distinct_wallets: 3, confluence: true, highlight: true, qualification: { unknown_reasons: [], market_cap_usd: 100, pool_age_hours: 2 }, buyers: [{ handle: "Bea" }], earliest: { block_time: "2026-11-07T17:00:00Z" }, pool: { symbol_label: "AAA" } },
  ];
  assert.equal(filterCards(cards, { mode: "highlight" }).length, 1);
  assert.equal(filterCards(cards, { query: "<ada>" }).length, 0);
  assert.equal(filterCards(cards, { query: "ada" })[0].mint, "b");
  assert.deepEqual(sortCards(cards, "cap").map((card) => card.mint), ["a", "b"]);
  assert.equal(escapeHtml(`<script>"'`), "&lt;script&gt;&quot;&#39;");
});
