import { CRITERIA_DEFAULTS } from "./limits.js";

export function reduceDexPairs(pairs, mint, fetchedAt) {
  const list = Array.isArray(pairs) ? pairs.filter((pair) => pair && typeof pair === "object") : [];
  const base = {
    mint,
    status: list.length ? "ok" : "not_found",
    confidence: "estimated",
    source: "dexscreener",
    fetched_at: fetchedAt,
    earliest_pool_at: null,
    earliest_pool_note:
      "Earliest pairCreatedAt among pairs DexScreener returned for this mint. This is a pool-age proxy, not the mint age, and it is not proof that an older pool is absent.",
    market_cap_usd: null,
    market_cap_pair: null,
    fdv_usd: null,
    fdv_qualifies_low_cap: false,
    price_usd: null,
    liquidity_usd: null,
    chart_url: null,
    dex_id: null,
    pair_address: null,
    symbol_label: null,
    name_label: null,
    pair_count: list.length,
  };
  if (!list.length) return base;

  let earliest = null;
  let capChoice = null;
  let fdvChoice = null;
  let liquid = null;

  for (const pair of list) {
    if (typeof pair.pairCreatedAt === "number" && Number.isFinite(pair.pairCreatedAt)) {
      if (earliest == null || pair.pairCreatedAt < earliest) earliest = pair.pairCreatedAt;
    }
    const liquidity = typeof pair.liquidity?.usd === "number" ? pair.liquidity.usd : -1;
    const baseAddress = pair.baseToken?.address || null;
    if (baseAddress === mint && typeof pair.marketCap === "number" && Number.isFinite(pair.marketCap)) {
      if (!capChoice || liquidity > capChoice.liquidity) capChoice = { liquidity, pair };
    }
    if (baseAddress === mint && typeof pair.fdv === "number" && Number.isFinite(pair.fdv)) {
      if (!fdvChoice || liquidity > fdvChoice.liquidity) fdvChoice = { liquidity, pair };
    }
    if (typeof pair.liquidity?.usd === "number" && (!liquid || pair.liquidity.usd > liquid.liquidity.usd)) {
      liquid = pair;
    }
  }

  const display = capChoice?.pair || fdvChoice?.pair || liquid || list[0];
  const displayIsBase = display?.baseToken?.address === mint;
  return {
    ...base,
    earliest_pool_at: earliest == null ? null : new Date(earliest).toISOString(),
    market_cap_usd: capChoice ? capChoice.pair.marketCap : null,
    market_cap_pair: capChoice?.pair?.pairAddress || null,
    fdv_usd: fdvChoice ? fdvChoice.pair.fdv : null,
    price_usd: displayIsBase ? display.priceUsd ?? null : null,
    liquidity_usd: typeof display?.liquidity?.usd === "number" ? display.liquidity.usd : null,
    chart_url: typeof display?.url === "string" ? display.url : null,
    dex_id: display?.dexId || null,
    pair_address: display?.pairAddress || null,
    symbol_label: displayIsBase ? display.baseToken?.symbol || null : null,
    name_label: displayIsBase ? display.baseToken?.name || null : null,
  };
}

export function qualifyPool(pool, criteria = CRITERIA_DEFAULTS, nowMs = Date.now()) {
  const maxAge = Number(criteria.new_pool_max_age_hours);
  const maxCap = Number(criteria.low_cap_max_market_cap_usd);
  const created = pool?.earliest_pool_at ? Date.parse(pool.earliest_pool_at) : NaN;
  const ageKnown = Number.isFinite(created);
  const ageHours = ageKnown ? (nowMs - created) / 3_600_000 : null;
  const isNew = ageKnown ? ageHours <= maxAge : null;
  const marketCap = pool?.market_cap_usd;
  const capKnown = typeof marketCap === "number" && Number.isFinite(marketCap);
  const isLowCap = capKnown ? marketCap <= maxCap : null;
  const unknown = [];
  if (!ageKnown) unknown.push("pool_age_unknown");
  if (!capKnown) unknown.push("market_cap_unknown");
  return {
    is_new: isNew,
    pool_age_hours: ageHours,
    is_low_cap: isLowCap,
    market_cap_usd: capKnown ? marketCap : null,
    fdv_usd: typeof pool?.fdv_usd === "number" ? pool.fdv_usd : null,
    fdv_qualifies_low_cap: false,
    highlight_eligible: isNew === true && isLowCap === true,
    unknown_reasons: unknown,
  };
}

export function holderFacts(buyerWallets, snapshot) {
  const facts = [];
  for (const wallet of buyerWallets) {
    if (!snapshot || snapshot.status !== "ok") {
      facts.push({ wallet, status: "unknown" });
      continue;
    }
    const row = (snapshot.accounts || []).find((account) => account.mint === snapshot.mint || account.mint === snapshot.forMint);
    facts.push({ wallet, status: row && row.amount_raw !== "0" ? "holding" : "not_holding" });
  }
  return facts;
}

export function holdingStatusFor(walletSnapshot, mint) {
  if (!walletSnapshot || walletSnapshot.status !== "ok") return "unknown";
  const rows = walletSnapshot.accounts || [];
  const match = rows.find((account) => account.mint === mint && account.amount_raw !== "0");
  return match ? "holding" : "not_holding";
}
