import { CRITERIA_DEFAULTS } from "./lib/limits.js";
import { formatLondon } from "./lib/time.js";
import { cardsFor, displayCount, emptyCopy, escapeHtml, filterCards, normalizeCriteria, renderCards, renderEntries, renderRoster, sortCards } from "./lib/view.js";

const $ = (id) => document.getElementById(id);
const STORAGE = "fomoCohortCriteria";
let feed = null;

function readCriteria() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(STORAGE) || "{}"); } catch { stored = {}; }
  return normalizeCriteria({
    new_pool_max_age_hours: $("hours").value || stored.new_pool_max_age_hours,
    low_cap_max_market_cap_usd: $("cap").value || stored.low_cap_max_market_cap_usd,
    rolling_buy_window_minutes: $("window").value || stored.rolling_buy_window_minutes,
  });
}

function saveCriteria() {
  localStorage.setItem(STORAGE, JSON.stringify(readCriteria()));
}

function paintClock() {
  $("london").textContent = formatLondon(new Date().toISOString()) || "London clock unavailable";
}

function metric(label, value, note) {
  return `<article class="metric"><span>${escapeHtml(label)}</span><b>${escapeHtml(displayCount(value))}</b><span class="fine">${escapeHtml(note)}</span></article>`;
}

function renderBaseline() {
  const rows = feed.baseline_holdings || [];
  if (!feed.coverage.counts_known) {
    $("baseline").innerHTML = `<p class="empty">Baseline inventory is unknown. The first successful token-account read freezes it. Nothing here is a buy.</p>`;
    return;
  }
  const known = rows.filter((row) => row.status === "ok");
  const unknown = rows.filter((row) => row.status !== "ok");
  const accounts = known.flatMap((row) => (row.accounts || []).map((account) => ({ ...account, wallet: row.wallet, at: row.at })));
  const preview = accounts.slice(0, 12).map((account) => `<li><code>${escapeHtml(account.mint)}</code> <span class="muted">${escapeHtml(account.ui_amount || "amount unknown")} · ${escapeHtml(account.wallet)}</span></li>`).join("");
  $("baseline").innerHTML = `<p class="fine">${known.length} wallets snapshotted · ${unknown.length} unknown · ${accounts.length} non-zero accounts. These were already there at the baseline and are not fresh entries.</p>
    ${accounts.length ? `<ul class="buyers">${preview}</ul>${accounts.length > 12 ? `<p class="fine">Showing 12 of ${accounts.length}. The published file has the full list.</p>` : ""}` : `<p class="empty">No non-zero baseline accounts were returned for the wallets that scanned successfully.</p>`}`;
}

function render() {
  if (!feed) return;
  if (feed.demo) {
    $("banner").className = "banner bad";
    $("banner").innerHTML = "<h2>FIXTURE REFUSED</h2><p>This page will not present demo fixtures as a scan.</p>";
    return;
  }
  const criteria = readCriteria();
  const controls = { query: $("q").value, mode: $("mode").value, sort: $("sort").value };
  const allCards = cardsFor(feed, criteria, Date.now());
  const cards = sortCards(filterCards(allCards, controls), controls.sort);
  const coverage = feed.coverage;
  $("banner").className = `banner ${feed.banner?.tone || "idle"}`;
  $("banner").innerHTML = `<h2>${escapeHtml(feed.banner?.title || coverage.label)}</h2><p>${escapeHtml(feed.banner?.detail || "")}</p>`;
  $("cadence").textContent = "HOURLY · NOT LIVE";
  $("cadence-note").textContent = feed.cadence?.label || "";
  const buys = feed.stats?.confirmed_post_baseline_buys;
  const buyNote = !coverage.counts_known
    ? "No scan has counted swaps"
    : coverage.observed_counts_are_complete
      ? "Counted after the baseline cursor"
      : "Counted after the baseline cursor. Not exhaustive while coverage is partial.";
  $("metrics").innerHTML = [
    metric("Post-baseline buys", buys, buyNote),
    metric("Last success", coverage.last_success_at ? formatLondon(coverage.last_success_at) : null, coverage.stale ? "Older than the stale window" : "Europe/London"),
    metric("Wallets read", coverage.counts_known ? `${coverage.wallets_ok}/${coverage.wallets_targeted}` : null, "Solana cohort only"),
    metric("Coverage", coverage.label, (coverage.reasons || []).join(" · ") || "Fixed cohort, not a live book"),
  ].join("");
  $("cards").innerHTML = cards.length ? renderCards(cards) : `<p class="empty">${escapeHtml(emptyCopy(coverage, "confluence"))}</p>`;
  const highlightMints = new Set(allCards.filter((card) => (controls.mode === "highlight" ? card.highlight : controls.mode === "confluence" ? card.confluence : true)).map((card) => card.mint));
  const needle = controls.query.trim().toLowerCase();
  const entries = (feed.entries || []).filter((entry) => {
    if (controls.mode === "highlight" || controls.mode === "confluence") {
      if (!highlightMints.has(entry.mint)) return false;
    }
    if (!needle) return true;
    return `${entry.handle} ${entry.mint} ${entry.wallet}`.toLowerCase().includes(needle);
  }).sort((a, b) => Date.parse(b.block_time || 0) - Date.parse(a.block_time || 0));
  $("entries").innerHTML = entries.length ? renderEntries(entries, feed.pools || {}) : `<p class="empty">${escapeHtml(emptyCopy(coverage, "feed"))}</p>`;
  $("roster").innerHTML = renderRoster(feed.wallet_status || [], controls.query);
  renderBaseline();
  $("method").textContent = `${feed.sources?.swaps || ""} Pools: ${feed.sources?.pools || ""}. ${feed.criteria_note || ""}`;
}

async function load() {
  const response = await fetch(`data/feed.json?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`feed_${response.status}`);
  const body = await response.json();
  if (body.demo === true) {
    feed = { demo: true, banner: { tone: "bad", title: "FIXTURE REFUSED", detail: "Demo fixtures are not shown as real activity." }, coverage: { counts_known: false } };
    render();
    return;
  }
  feed = body;
  render();
}

function bootControls() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(STORAGE) || "{}"); } catch { stored = {}; }
  const criteria = normalizeCriteria({ ...CRITERIA_DEFAULTS, ...stored });
  $("hours").value = criteria.new_pool_max_age_hours;
  $("cap").value = criteria.low_cap_max_market_cap_usd;
  $("window").value = criteria.rolling_buy_window_minutes;
  $("controls").addEventListener("submit", (event) => event.preventDefault());
  for (const id of ["q", "hours", "cap", "window", "sort", "mode"]) $(id).addEventListener("input", () => { saveCriteria(); render(); });
  $("reset").addEventListener("click", () => {
    localStorage.removeItem(STORAGE);
    $("hours").value = CRITERIA_DEFAULTS.new_pool_max_age_hours;
    $("cap").value = CRITERIA_DEFAULTS.low_cap_max_market_cap_usd;
    $("window").value = CRITERIA_DEFAULTS.rolling_buy_window_minutes;
    $("q").value = "";
    $("mode").value = "highlight";
    $("sort").value = "wallets";
    render();
  });
}

bootControls();
paintClock();
setInterval(paintClock, 30000);
load().catch((error) => {
  $("banner").className = "banner bad";
  $("banner").innerHTML = `<h2>PUBLISHED FILE UNREADABLE</h2><p>${escapeHtml(error.message)}. Counts stay blank rather than zero.</p>`;
  $("metrics").innerHTML = metric("Post-baseline buys", null, "File missing") + metric("Last success", null, "Unknown") + metric("Wallets read", null, "Unknown") + metric("Coverage", null, "Unknown");
});
setInterval(() => load().catch(() => {}), 5 * 60 * 1000);
