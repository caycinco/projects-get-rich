import { CRITERIA_DEFAULTS } from "./limits.js";
import { holdingStatusFor, qualifyPool } from "./qualify.js";

function earliest(entries) {
  const timed = entries.filter((entry) => entry.block_time && Number.isFinite(Date.parse(entry.block_time)));
  if (!timed.length) return null;
  return timed.reduce((best, entry) => (Date.parse(entry.block_time) < Date.parse(best.block_time) ? entry : best));
}

export function buysByMint(entries) {
  const grouped = new Map();
  for (const entry of entries || []) {
    if (entry?.classification !== "confirmed_swap" || !entry.mint || !entry.wallet) continue;
    const rows = grouped.get(entry.mint) || [];
    rows.push(entry);
    grouped.set(entry.mint, rows);
  }
  return grouped;
}

export function uniqueWalletBuys(rows) {
  const byWallet = new Map();
  for (const row of rows || []) {
    const current = byWallet.get(row.wallet);
    if (!current) {
      byWallet.set(row.wallet, row);
      continue;
    }
    const currentTime = current.block_time ? Date.parse(current.block_time) : NaN;
    const nextTime = row.block_time ? Date.parse(row.block_time) : NaN;
    if (!Number.isFinite(currentTime) && Number.isFinite(nextTime)) byWallet.set(row.wallet, row);
    else if (Number.isFinite(nextTime) && nextTime < currentTime) byWallet.set(row.wallet, row);
  }
  return [...byWallet.values()];
}

export function windowMembership(entry, nowMs, windowMinutes) {
  if (!entry?.block_time) return "time_unknown";
  const at = Date.parse(entry.block_time);
  if (!Number.isFinite(at)) return "time_unknown";
  if (at > nowMs + 120_000) return "time_unknown";
  const age = nowMs - at;
  if (age < 0) return "time_unknown";
  return age <= windowMinutes * 60_000 ? "in_window" : "outside_window";
}

export function buildMintCards({
  entries,
  pools = {},
  holdings = {},
  criteria = CRITERIA_DEFAULTS,
  nowMs = Date.now(),
}) {
  const cards = [];
  for (const [mint, rows] of buysByMint(entries)) {
    const wallets = uniqueWalletBuys(rows);
    const windowBuyers = [];
    const timeUnknown = [];
    const outside = [];
    for (const row of wallets) {
      const where = windowMembership(row, nowMs, criteria.rolling_buy_window_minutes);
      if (where === "in_window") windowBuyers.push(row);
      else if (where === "time_unknown") timeUnknown.push(row);
      else outside.push(row);
    }
    const holderRows = wallets.map((row) => ({
      wallet: row.wallet,
      handle: row.handle,
      rank: row.rank,
      status: holdingStatusFor(holdings?.latest?.[row.wallet], mint),
    }));
    const pool = pools[mint] || null;
    const qualification = qualifyPool(pool, criteria, nowMs);
    cards.push({
      mint,
      distinct_wallets: wallets.length,
      tx_count: rows.length,
      window_buyers: windowBuyers.length,
      outside_window: outside.length,
      time_unknown: timeUnknown.length,
      holding: holderRows.filter((row) => row.status === "holding").length,
      not_holding: holderRows.filter((row) => row.status === "not_holding").length,
      holder_unknown: holderRows.filter((row) => row.status === "unknown").length,
      holders: holderRows,
      buyers: wallets,
      qualification,
      pool,
      earliest: earliest(wallets),
      confluence: wallets.length >= 2,
      highlight: wallets.length >= 2 && qualification.highlight_eligible === true,
    });
  }
  return cards.sort((a, b) => b.distinct_wallets - a.distinct_wallets || String(a.mint).localeCompare(String(b.mint)));
}
