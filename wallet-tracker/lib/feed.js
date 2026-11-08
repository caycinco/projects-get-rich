import { CADENCE, CRITERIA_DEFAULTS, DEFAULT_RPC } from "./limits.js";
import { buildMintCards } from "./confluence.js";

export function emptyState() {
  return {
    version: 1,
    last_attempt_at: null,
    last_success_at: null,
    last_run_status: "never_scanned",
    last_error: null,
    rpc_url_host: null,
    requests: 0,
    wallets: {},
  };
}

export function coverageFromState(state, nowMs = Date.now(), staleAfterMinutes = CRITERIA_DEFAULTS.stale_after_minutes) {
  const wallets = Object.values(state?.wallets || {});
  const targeted = wallets.filter((wallet) => wallet.role === "solana");
  const ok = targeted.filter((wallet) => wallet.last_success_at);
  const failed = targeted.filter((wallet) => wallet.last_error && !wallet.skipped);
  const gaps = targeted.filter((wallet) => wallet.history_gap);
  const unparsed = targeted.reduce((sum, wallet) => sum + (wallet.skipped_unparsed || 0), 0);
  const capped = targeted.filter((wallet) => wallet.ata_capped);
  const lastSuccess = state?.last_success_at ? Date.parse(state.last_success_at) : NaN;
  const attempted = Boolean(state?.last_attempt_at);
  const succeeded = Number.isFinite(lastSuccess);
  const reasons = [];
  if (failed.some((wallet) => wallet.last_error)) reasons.push("wallet RPC error");
  if (gaps.length) reasons.push("signature history gap");
  if (unparsed) reasons.push("unparsed signatures");
  if (capped.length) reasons.push("associated-token scan capped");
  if (targeted.some((wallet) => wallet.token_accounts_status !== "ok")) reasons.push("token-account snapshot incomplete");
  if (state?.pool_error) reasons.push("pool metadata request failed");
  const unexplained = targeted.some((wallet) => wallet.coverage && wallet.coverage !== "ok");
  if (unexplained && reasons.length === 0) reasons.push("wallet coverage incomplete");
  const blocked = reasons.length > 0;
  let status = "never_scanned";
  if (attempted && !succeeded) status = "error";
  else if (succeeded) {
    const stale = nowMs - lastSuccess > staleAfterMinutes * 60_000;
    if (blocked || targeted.length === 0) status = stale ? "partial_stale" : "partial";
    else status = stale ? "stale" : "current";
  }
  const complete = status === "current" || status === "stale";
  return {
    status,
    complete,
    observed_counts_are_complete: complete && status !== "stale" ? true : false,
    counts_known: succeeded,
    stale: status === "stale" || status === "partial_stale",
    last_attempt_at: state?.last_attempt_at || null,
    last_success_at: state?.last_success_at || null,
    last_error: state?.last_error || null,
    wallets_targeted: targeted.length,
    wallets_ok: ok.length,
    wallets_failed: failed.filter((wallet) => wallet.last_error).length,
    history_gaps: gaps.length,
    skipped_unparsed: unparsed,
    ata_capped: capped.length,
    reasons,
    label: labelFor(status),
  };
}

function labelFor(status) {
  switch (status) {
    case "never_scanned":
      return "NO SUCCESSFUL SCAN";
    case "error":
      return "LAST SCAN FAILED";
    case "partial":
      return "PARTIAL COVERAGE";
    case "partial_stale":
      return "PARTIAL AND STALE";
    case "stale":
      return "STALE";
    case "current":
      return "SCAN CURRENT";
    default:
      return "UNKNOWN";
  }
}

export function bannerCopy(coverage) {
  if (!coverage || coverage.status === "never_scanned") {
    return {
      tone: "idle",
      title: "NO SUCCESSFUL SCAN",
      detail: "No Solana history has been read yet. Activity counts stay unknown instead of zero. The roster below is the fixed cohort, not evidence of trades.",
    };
  }
  if (coverage.status === "error") {
    return {
      tone: "bad",
      title: "LAST SCAN FAILED",
      detail: coverage.last_error || "The scanner stopped before a successful read. Nothing new was invented to fill the feed.",
    };
  }
  if (coverage.status === "partial" || coverage.status === "partial_stale") {
    return {
      tone: "warn",
      title: coverage.status === "partial_stale" ? "PARTIAL AND STALE" : "PARTIAL COVERAGE",
      detail: `Coverage is partial${coverage.reasons?.length ? ` (${coverage.reasons.join("; ")})` : ""}. Observed buys are only the swaps the scan read. Anything not read stays unknown.`,
    };
  }
  if (coverage.status === "stale") {
    return {
      tone: "warn",
      title: "STALE",
      detail: "The last complete read is older than the stale window. The rows below are that read, not a live book.",
    };
  }
  return {
    tone: "ok",
    title: "SCHEDULED SCAN CURRENT",
    detail: "The last read finished inside the stale window. Hourly cadence still means the newest swap can be up to an hour old, plus any GitHub schedule delay.",
  };
}

export function buildFeed({
  cohort,
  state = emptyState(),
  entries = [],
  holdings = { baseline: {}, latest: {} },
  pools = {},
  nowMs = Date.now(),
}) {
  const coverage = coverageFromState(state, nowMs);
  const cards = coverage.counts_known
    ? buildMintCards({ entries, pools, holdings, criteria: CRITERIA_DEFAULTS, nowMs })
    : [];
  const observed = coverage.counts_known ? entries.filter((entry) => entry.classification === "confirmed_swap").length : null;
  return {
    schema: "fomo-wallet-tracker/1",
    demo: false,
    generated_at: state.last_attempt_at || null,
    timestamps: "UTC",
    display_timezone: "Europe/London",
    cadence: CADENCE,
    criteria_defaults: CRITERIA_DEFAULTS,
    criteria_note:
      "Pool age, market cap, and the rolling window are display criteria. They do not size trades, send transactions, or prove that a coin is safe.",
    coverage,
    banner: bannerCopy(coverage),
    sources: {
      cohort: "Public FomoLens ordinary lookup pages, retrieved 2026-11-07 UTC. Fixed copy in source/fomolens-top30-2026-11-07.json.",
      swaps: "Solana JSON-RPC getSignaturesForAddress, getTransaction (jsonParsed), getTokenAccountsByOwner for Token and Token-2022.",
      rpc_default: DEFAULT_RPC,
      rpc_host: state?.rpc_url_host || null,
      pools: "https://api.dexscreener.com/tokens/v1/solana/{mints}",
      pool_docs: "https://docs.dexscreener.com/api/reference",
      rpc_docs: "https://solana.com/docs/rpc",
      not_used: [
        "private FomoLens APIs",
        "wallet signing",
        "trading or swap execution",
        "browser-only endpoints",
        "paid data vendors",
      ],
    },
    cohort: {
      id: cohort.id,
      fixed: true,
      ownership_verified: false,
      caveat: cohort.caveat,
      counts: cohort.counts,
      quarantine: cohort.quarantine,
      traders: cohort.traders,
    },
    wallet_status: walletRows(cohort, state),
    entries,
    pools,
    baseline_holdings: serializeHoldings(holdings.baseline, "baseline"),
    latest_holdings: serializeHoldings(holdings.latest, "latest"),
    default_confluence: cards.filter((card) => card.confluence),
    stats: {
      confirmed_post_baseline_buys: observed,
      distinct_mints: coverage.counts_known ? new Set(entries.map((entry) => entry.mint)).size : null,
      confluence_mints_default_criteria: coverage.counts_known ? cards.filter((card) => card.highlight).length : null,
      wallets_with_two_or_more_default: coverage.counts_known ? cards.filter((card) => card.confluence).length : null,
      note: coverage.counts_known
        ? "Post-baseline buys only. Baseline inventory is not a buy. A zero means none were observed after the cursor, and only a current complete scan makes that zero exhaustive."
        : "Unknown. No successful scan has counted buys.",
    },
  };
}

function walletRows(cohort, state) {
  return cohort.traders.map((trader) => {
    const solana = trader.solana_addresses[0] || null;
    const saved = solana ? state.wallets?.[solana] : null;
    if (trader.evm_only) {
      return {
        rank: trader.rank,
        handle: trader.handle,
        stale_sample: trader.stale_sample,
        solana: null,
        status: "not_scanned",
        reason: "EVM family only. No Solana address was published, and no EVM chain was specified.",
        last_success_at: null,
        last_error: null,
      };
    }
    return {
      rank: trader.rank,
      handle: trader.handle,
      stale_sample: trader.stale_sample,
      solana,
      status: saved?.coverage || "unknown",
      reason: saved?.last_error || null,
      history_gap: Boolean(saved?.history_gap),
      token_accounts_status: saved?.token_accounts_status || "unknown",
      baseline_at: saved?.baseline_at || null,
      last_success_at: saved?.last_success_at || null,
      last_attempt_at: saved?.last_attempt_at || null,
      cursor_set: Boolean(saved?.cursor),
      transfers_ignored: saved?.transfers_ignored ?? null,
      ata_capped: Boolean(saved?.ata_capped),
    };
  });
}

function serializeHoldings(bucket, kind) {
  const rows = [];
  for (const [wallet, snapshot] of Object.entries(bucket || {})) {
    rows.push({
      wallet,
      kind,
      status: snapshot.status || "unknown",
      at: snapshot.at || null,
      confidence: snapshot.status === "ok" ? "estimated" : "unknown",
      programs: snapshot.programs || {},
      accounts: snapshot.status === "ok" ? snapshot.accounts || [] : [],
      account_count: snapshot.status === "ok" ? (snapshot.accounts || []).length : null,
    });
  }
  return rows;
}

export function canonicalFeed(feed) {
  return `${JSON.stringify(feed, null, 2)}\n`;
}
