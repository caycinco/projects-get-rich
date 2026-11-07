import { formatLondon, formatRawAmount } from "./time.js";
import { buildMintCards } from "./confluence.js";
import { CRITERIA_DEFAULTS } from "./limits.js";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

const ALLOWED_HOSTS = new Set(["solscan.io", "explorer.solana.com", "dexscreener.com"]);

export function safeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function shortId(value) {
  const text = String(value || "");
  if (text.length <= 12) return text;
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

export function displayCount(value) {
  return value == null || Number.isNaN(value) ? "unknown" : String(value);
}

export function windowLabel(card) {
  if (!card || card.time_unknown === card.distinct_wallets) return "unknown";
  if (card.time_unknown > 0) return `${card.window_buyers} timed · ${card.time_unknown} time unknown`;
  return String(card.window_buyers);
}

export function holderLabel(card) {
  if (!card) return "unknown";
  if (card.holder_unknown === card.distinct_wallets && card.holding === 0 && card.not_holding === 0) return "unknown";
  return `${card.holding} holding · ${card.not_holding} not holding · ${card.holder_unknown} unknown`;
}

export function normalizeCriteria(input = {}) {
  const hours = Number(input.new_pool_max_age_hours);
  const cap = Number(input.low_cap_max_market_cap_usd);
  const windowMinutes = Number(input.rolling_buy_window_minutes);
  return {
    new_pool_max_age_hours: Number.isFinite(hours) ? Math.min(24 * 30, Math.max(1, hours)) : CRITERIA_DEFAULTS.new_pool_max_age_hours,
    low_cap_max_market_cap_usd: Number.isFinite(cap) ? Math.max(0, cap) : CRITERIA_DEFAULTS.low_cap_max_market_cap_usd,
    rolling_buy_window_minutes: Number.isFinite(windowMinutes) ? Math.min(24 * 60, Math.max(1, windowMinutes)) : CRITERIA_DEFAULTS.rolling_buy_window_minutes,
  };
}

export function cardsFor(feed, criteria, nowMs) {
  if (!feed?.coverage?.counts_known) return [];
  return buildMintCards({
    entries: feed.entries || [],
    pools: feed.pools || {},
    holdings: {
      latest: Object.fromEntries((feed.latest_holdings || []).map((row) => [row.wallet, row])),
    },
    criteria: normalizeCriteria(criteria),
    nowMs,
  });
}

export function filterCards(cards, { query = "", mode = "all" } = {}) {
  const needle = query.trim().toLowerCase();
  return cards.filter((card) => {
    if (mode === "highlight" && !card.highlight) return false;
    if (mode === "confluence" && !card.confluence) return false;
    if (mode === "unknown" && !(card.qualification?.unknown_reasons || []).length) return false;
    if (!needle) return true;
    const buyers = (card.buyers || []).map((buyer) => `${buyer.handle || ""} ${buyer.wallet || ""}`).join(" ");
    const hay = `${card.mint} ${card.pool?.symbol_label || ""} ${card.pool?.name_label || ""} ${buyers}`.toLowerCase();
    return hay.includes(needle);
  });
}

export function sortCards(cards, sort = "wallets") {
  const copy = cards.slice();
  const timeOf = (card) => {
    const raw = card.earliest?.block_time;
    const parsed = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  copy.sort((a, b) => {
    if (sort === "newest" || sort === "oldest") {
      const at = timeOf(a);
      const bt = timeOf(b);
      if (at == null && bt == null) return a.mint.localeCompare(b.mint);
      if (at == null) return 1;
      if (bt == null) return -1;
      return sort === "newest" ? bt - at : at - bt;
    }
    if (sort === "cap") {
      const ac = a.qualification?.market_cap_usd;
      const bc = b.qualification?.market_cap_usd;
      if (ac == null && bc == null) return b.distinct_wallets - a.distinct_wallets;
      if (ac == null) return 1;
      if (bc == null) return -1;
      return ac - bc;
    }
    if (sort === "pool") {
      const ac = a.qualification?.pool_age_hours;
      const bc = b.qualification?.pool_age_hours;
      if (ac == null && bc == null) return b.distinct_wallets - a.distinct_wallets;
      if (ac == null) return 1;
      if (bc == null) return -1;
      return ac - bc;
    }
    return b.distinct_wallets - a.distinct_wallets || a.mint.localeCompare(b.mint);
  });
  return copy;
}

function money(value) {
  if (value == null || !Number.isFinite(Number(value))) return "unknown";
  return `$${Number(value).toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;
}

function ageLabel(hours) {
  if (hours == null || !Number.isFinite(hours)) return "unknown";
  if (hours < 0) return "unknown";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return `${hours.toFixed(1)}h`;
}

function link(url, label) {
  const safe = safeUrl(url);
  if (!safe) return "";
  return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function qualificationPills(card) {
  const q = card.qualification || {};
  const pills = [];
  pills.push(q.is_new === true ? '<span class="pill ok">NEW POOL</span>' : q.is_new === false ? '<span class="pill">POOL OLDER</span>' : '<span class="pill warn">POOL AGE UNKNOWN</span>');
  if (q.is_low_cap === true) pills.push('<span class="pill ok">LOW CAP</span>');
  else if (q.is_low_cap === false) pills.push('<span class="pill">ABOVE CAP</span>');
  else pills.push('<span class="pill warn">MARKET CAP UNKNOWN</span>');
  if (q.fdv_usd != null) pills.push('<span class="pill amber">FDV ONLY · DOES NOT QUALIFY</span>');
  if (card.highlight) pills.push('<span class="pill hot">HIGHLIGHT</span>');
  else if (card.confluence) pills.push('<span class="pill amber">2+ WALLETS</span>');
  return pills.join("");
}

export function renderCards(cards) {
  if (!cards.length) return "";
  return cards.map((card) => {
    const symbol = card.pool?.symbol_label ? escapeHtml(card.pool.symbol_label) : "symbol unknown";
    const buyers = (card.buyers || []).map((buyer) => {
      const when = buyer.block_time ? formatLondon(buyer.block_time) : "time unknown";
      const quotes = (buyer.quote_legs || []).map((quote) => `${quote.spent_ui || formatRawAmount(quote.spent_raw, quote.decimals) || "amount unknown"} ${quote.symbol || "QUOTE"}`).join(" + ") || "quote unknown";
      return `<li>
        <b>${escapeHtml(buyer.handle || "handle unknown")}</b>
        <span class="muted">rank ${buyer.rank ?? "unknown"} · ${escapeHtml(shortId(buyer.wallet))}</span>
        <span>${escapeHtml(when || "time unknown")}</span>
        <span>${escapeHtml(quotes)} → ${escapeHtml(buyer.received_ui || "amount unknown")}</span>
        <span class="links">${link(buyer.links?.tx_solscan, "Tx")}${link(buyer.links?.tx_explorer, "Explorer")}</span>
      </li>`;
    }).join("");
    const chart = link(card.pool?.chart_url, "Chart");
    const mintLink = link(`https://solscan.io/token/${card.mint}`, "Mint");
    const dex = link(`https://dexscreener.com/solana/${card.mint}`, "DexScreener");
    return `<article class="card ${card.highlight ? "hot" : card.confluence ? "multi" : ""}">
      <header>
        <div>
          <p class="eyebrow">${symbol} · label only</p>
          <h3 title="${escapeHtml(card.mint)}">${escapeHtml(shortId(card.mint))}</h3>
        </div>
        <p class="count" aria-label="Distinct wallets">${card.distinct_wallets}<small>wallets</small></p>
      </header>
      <div class="pills">${qualificationPills(card)}</div>
      <dl>
        <div><dt>Window buyers</dt><dd>${escapeHtml(windowLabel(card))}</dd></div>
        <div><dt>Transactions</dt><dd>${card.tx_count}</dd></div>
        <div><dt>Holders</dt><dd>${escapeHtml(holderLabel(card))}</dd></div>
        <div><dt>Pool age</dt><dd>${escapeHtml(ageLabel(card.qualification?.pool_age_hours))}</dd></div>
        <div><dt>Market cap</dt><dd>${escapeHtml(money(card.qualification?.market_cap_usd))}</dd></div>
        <div><dt>FDV</dt><dd>${escapeHtml(money(card.qualification?.fdv_usd))}</dd></div>
      </dl>
      <p class="fine">Market cap and FDV are DexScreener estimates. FDV never qualifies a coin as low cap. Pool age is the earliest returned pair, not mint age.</p>
      <ul class="buyers">${buyers}</ul>
      <p class="links">${mintLink}${chart}${dex}</p>
    </article>`;
  }).join("");
}

export function renderEntries(entries, pools = {}) {
  if (!entries.length) return "";
  return entries.map((entry) => {
    const pool = pools[entry.mint] || {};
    const when = entry.block_time_confidence === "confirmed" && entry.block_time ? formatLondon(entry.block_time) : "time unknown";
    const quotes = (entry.quote_legs || []).map((quote) => `${quote.spent_ui || "unknown"} ${quote.symbol || ""}`).join(" + ");
    return `<article class="row">
      <time>${escapeHtml(when || "time unknown")}</time>
      <div>
        <b>${escapeHtml(entry.handle || "unknown")}</b>
        <span class="muted">rank ${entry.rank ?? "unknown"}${entry.stale_sample ? " · stale sample" : ""}</span>
        <code title="${escapeHtml(entry.mint)}">${escapeHtml(entry.mint)}</code>
        <span class="muted">${escapeHtml(pool.symbol_label || "symbol unknown")} · label, not identity</span>
      </div>
      <div>
        <span>Spent ${escapeHtml(quotes || "unknown")}</span>
        <span>Received ${escapeHtml(entry.received_ui || "unknown")}</span>
        <span class="pill">${escapeHtml(entry.confidence || "unknown")}</span>
      </div>
      <p class="links">${link(entry.links?.tx_solscan, "Tx")}${link(entry.links?.tx_explorer, "Explorer")}${link(entry.links?.wallet_solscan, "Wallet")}${link(pool.chart_url, "Chart")}</p>
    </article>`;
  }).join("");
}

export function renderRoster(rows, query = "") {
  const needle = query.trim().toLowerCase();
  const visible = (rows || []).filter((row) => {
    if (!needle) return true;
    return `${row.handle} ${row.solana || ""} ${row.rank}`.toLowerCase().includes(needle);
  });
  if (!visible.length) return '<p class="empty">No roster rows match this search.</p>';
  return visible.map((row) => {
    const status = row.status === "ok" ? "ok" : row.status === "not_scanned" ? "idle" : row.status === "unknown" ? "idle" : "warn";
    return `<article class="roster-row">
      <span class="rank">${escapeHtml(row.rank ?? "–")}</span>
      <div>
        <b>${escapeHtml(row.handle || "unknown")}</b>
        ${row.stale_sample ? '<span class="pill amber">STALE SAMPLE</span>' : ""}
        <code>${escapeHtml(row.solana || "no Solana address")}</code>
        ${row.reason ? `<p class="muted">${escapeHtml(row.reason)}</p>` : ""}
      </div>
      <span class="pill ${status}">${escapeHtml((row.status || "unknown").replaceAll("_", " "))}</span>
    </article>`;
  }).join("");
}

export function emptyCopy(coverage, kind) {
  if (!coverage?.counts_known) {
    return kind === "confluence"
      ? "Confluence is unknown. No scan has counted wallets entering a mint."
      : "The buy feed is unknown. No scan has confirmed a post-baseline swap.";
  }
  if (!coverage.observed_counts_are_complete) {
    return kind === "confluence"
      ? "No recorded mint currently has 2 or more distinct tracked wallets under this view. Coverage is incomplete, so this is not an exhaustive zero."
      : "No post-baseline swap is recorded in this view. Coverage is incomplete, so unseen buys stay unknown.";
  }
  return kind === "confluence"
    ? "No recorded mint has 2 or more distinct tracked wallets under this view."
    : "No post-baseline swap is recorded. Baseline inventory is separate and is not counted here.";
}
