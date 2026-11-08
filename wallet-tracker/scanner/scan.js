import { classifyTransaction, entryFromBuy } from "../lib/classify.js";
import { planSignatureWindow } from "../lib/cursor.js";
import { LIMITS, TOKEN_2022, TOKEN_PROGRAM } from "../lib/limits.js";

function blankWallet(trader) {
  return {
    role: "solana",
    handle: trader.handle,
    rank: trader.rank,
    coverage: "unknown",
    cursor: null,
    cursor_slot: null,
    cursor_initialized: false,
    ata_cursors: {},
    ata_capped: false,
    ata_total: null,
    history_gap: false,
    skipped_unparsed: 0,
    unparsed_attempts: {},
    transfers_ignored: 0,
    token_accounts_status: "unknown",
    baseline_at: null,
    last_attempt_at: null,
    last_success_at: null,
    last_error: null,
  };
}

export function parseTokenAccounts(result) {
  if (!result || !Array.isArray(result.value)) {
    const error = new Error("token_accounts_malformed");
    error.permanent = true;
    throw error;
  }
  const accounts = [];
  for (const item of result.value) {
    const parsed = item?.account?.data?.parsed;
    if (!parsed?.info?.mint || parsed.info.tokenAmount?.amount == null) {
      return { ok: false, reason: "unparsed_token_account", accounts: [] };
    }
    if (parsed.info.tokenAmount.amount === "0") continue;
    accounts.push({
      ata: item.pubkey,
      mint: parsed.info.mint,
      amount_raw: String(parsed.info.tokenAmount.amount),
      decimals: parsed.info.tokenAmount.decimals ?? null,
      ui_amount: parsed.info.tokenAmount.uiAmountString ?? null,
      program: item.account?.owner || null,
    });
  }
  return { ok: true, accounts };
}

function rememberHoldings(holdings, wallet, detectedAt, parts) {
  const programs = {};
  const accounts = [];
  let ok = true;
  for (const [name, part] of Object.entries(parts)) {
    programs[name] = part.ok ? "ok" : part.reason || "error";
    if (!part.ok) ok = false;
    else accounts.push(...part.accounts);
  }
  const seen = new Set();
  const unique = [];
  for (const account of accounts) {
    const id = `${account.ata}:${account.mint}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(account);
  }
  const snapshot = {
    status: ok ? "ok" : "unknown",
    at: detectedAt,
    programs,
    accounts: ok ? unique : [],
    confidence: ok ? "estimated" : "unknown",
  };
  holdings.latest[wallet] = snapshot;
  if (ok && !holdings.baseline[wallet]) {
    holdings.baseline[wallet] = { ...snapshot, frozen: true, kind: "baseline" };
  }
  return snapshot;
}

async function readProgram(rpc, wallet, programId) {
  const result = await rpc.call("getTokenAccountsByOwner", [
    wallet,
    { programId },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  return parseTokenAccounts(result);
}

async function fetchSignaturePages(rpc, address, cursor, limits) {
  const pages = [];
  let before;
  let reachedCursor = false;
  const pageLimit = cursor || cursor === null ? limits.maxPages : 1;
  for (let page = 0; page < (cursor === undefined ? 1 : pageLimit); page += 1) {
    const config = { limit: limits.signaturePageSize, commitment: "confirmed" };
    if (cursor) config.until = cursor;
    if (before) config.before = before;
    const batch = await rpc.call("getSignaturesForAddress", [address, config]);
    const rows = (Array.isArray(batch) ? batch : []).map((row) => ({
      signature: row.signature,
      slot: row.slot ?? null,
      err: row.err || null,
      blockTime: row.blockTime ?? null,
    }));
    pages.push(rows);
    const short = rows.length < limits.signaturePageSize;
    if (short || rows.some((row) => row.signature === cursor)) {
      reachedCursor = true;
      break;
    }
    before = rows[rows.length - 1]?.signature;
    if (!before) {
      reachedCursor = true;
      break;
    }
  }
  return { pages, reachedCursor };
}

async function scanCursor(rpc, address, cursorState, wallet, trader, detectedAt, limits, bucket) {
  if (!cursorState.initialized) {
    const { pages } = await fetchSignaturePages(rpc, address, undefined, { ...limits, maxPages: 1, signaturePageSize: 1 });
    const plan = planSignatureWindow({ pages, initialized: false });
    cursorState.initialized = true;
    cursorState.signature = plan.nextCursor;
    cursorState.slot = plan.nextCursorSlot;
    return;
  }

  const { pages, reachedCursor } = await fetchSignaturePages(rpc, address, cursorState.signature, limits);
  const plan = planSignatureWindow({
    pages,
    cursor: cursorState.signature,
    reachedCursor,
    initialized: true,
  });
  if (plan.gap) {
    bucket.gap = true;
    bucket.backlog += plan.backlog;
    return;
  }

  let walked = cursorState.signature;
  let walkedSlot = cursorState.slot;
  for (const row of plan.process) {
    if (row.err) {
      walked = row.signature;
      walkedSlot = row.slot;
      continue;
    }
    const tx = await rpc.call("getTransaction", [
      row.signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]);
    if (!tx || tx.meta == null) {
      const attempts = (bucket.unparsedAttempts[row.signature] || 0) + 1;
      bucket.unparsedAttempts[row.signature] = attempts;
      if (attempts < limits.maxUnparsedAttempts) {
        bucket.gap = true;
        bucket.stalled = row.signature;
        cursorState.signature = walked;
        cursorState.slot = walkedSlot;
        return;
      }
      bucket.skipped += 1;
      walked = row.signature;
      walkedSlot = row.slot;
      continue;
    }
    const classified = classifyTransaction(tx, wallet, { solDustLamports: limits.solDustLamports });
    if (classified.kind === "confirmed_swap") {
      for (const buy of classified.buys) {
        bucket.entries.push(entryFromBuy({ tx, signature: row.signature, wallet, trader, buy, detectedAt }));
      }
    } else if (classified.kind === "transfer_or_airdrop") {
      bucket.transfers += 1;
    } else if (classified.kind === "unparsed") {
      bucket.gap = true;
      cursorState.signature = walked;
      cursorState.slot = walkedSlot;
      return;
    }
    walked = row.signature;
    walkedSlot = row.slot;
  }
  cursorState.signature = plan.nextCursor;
  cursorState.slot = plan.nextCursorSlot;
}

export async function scanWallet({ trader, saved, rpc, holdings, detectedAt, limits = LIMITS }) {
  const wallet = { ...blankWallet(trader), ...saved, last_attempt_at: detectedAt, last_error: null };
  const [spl, token2022] = await Promise.all([
    readProgram(rpc, trader.address, TOKEN_PROGRAM).catch((error) => ({ ok: false, reason: error.message, accounts: [] })),
    readProgram(rpc, trader.address, TOKEN_2022).catch((error) => ({ ok: false, reason: error.message, accounts: [] })),
  ]);
  const snapshot = rememberHoldings(holdings, trader.address, detectedAt, {
    token: spl,
    token2022,
  });
  wallet.token_accounts_status = snapshot.status === "ok" ? "ok" : "unknown";
  if (snapshot.status === "ok" && holdings.baseline[trader.address]?.at === detectedAt) wallet.baseline_at = detectedAt;
  if (!wallet.baseline_at && holdings.baseline[trader.address]?.at) wallet.baseline_at = holdings.baseline[trader.address].at;

  const positive = snapshot.status === "ok" ? snapshot.accounts : [];
  wallet.ata_total = snapshot.status === "ok" ? positive.length : null;
  const selected = positive.slice(0, limits.maxAtaPerWallet);
  wallet.ata_capped = snapshot.status === "ok" && positive.length > selected.length;

  const bucket = {
    entries: [],
    transfers: 0,
    gap: false,
    backlog: 0,
    skipped: wallet.skipped_unparsed || 0,
    stalled: null,
    unparsedAttempts: { ...(wallet.unparsed_attempts || {}) },
  };
  const ownerCursor = {
    initialized: Boolean(wallet.cursor_initialized),
    signature: wallet.cursor,
    slot: wallet.cursor_slot,
  };
  await scanCursor(rpc, trader.address, ownerCursor, trader.address, trader, detectedAt, limits, bucket);
  wallet.cursor_initialized = ownerCursor.initialized;
  wallet.cursor = ownerCursor.signature;
  wallet.cursor_slot = ownerCursor.slot;

  for (const account of selected) {
    const current = wallet.ata_cursors[account.ata] || { initialized: false, signature: null, slot: null };
    await scanCursor(rpc, account.ata, current, trader.address, trader, detectedAt, limits, bucket);
    wallet.ata_cursors[account.ata] = current;
  }

  wallet.history_gap = bucket.gap;
  wallet.skipped_unparsed = bucket.skipped;
  wallet.unparsed_attempts = bucket.unparsedAttempts;
  wallet.transfers_ignored = (wallet.transfers_ignored || 0) + bucket.transfers;
  wallet.last_success_at = detectedAt;
  const accountsUnknown = wallet.token_accounts_status !== "ok";
  wallet.coverage = bucket.gap || accountsUnknown || wallet.ata_capped ? "partial" : wallet.cursor_initialized ? "ok" : "baseline";
  if (!bucket.gap && !accountsUnknown && wallet.cursor_initialized && !wallet.ata_capped) wallet.coverage = "ok";
  return { wallet, entries: bucket.entries, transfers: bucket.transfers };
}

export async function runScan({
  cohort,
  state,
  entries,
  holdings,
  pools,
  rpc,
  dexLookup,
  now = new Date(),
  limits = LIMITS,
  deadlineMs = Date.now() + limits.scanBudgetMs,
  onProgress,
}) {
  const detectedAt = now.toISOString();
  state.last_attempt_at = detectedAt;
  holdings.baseline ||= {};
  holdings.latest ||= {};
  const collected = [...entries];

  for (const trader of cohort.solana) {
    state.wallets[trader.address] = { ...blankWallet(trader), ...(state.wallets[trader.address] || {}) };
  }

  let budgetStopped = false;
  for (const trader of cohort.solana) {
    if (Date.now() > deadlineMs) {
      budgetStopped = true;
      const saved = state.wallets[trader.address];
      if (!saved.last_attempt_at || saved.last_attempt_at !== detectedAt) {
        saved.coverage = saved.last_success_at ? saved.coverage : "not_attempted_this_run";
        saved.last_error = saved.last_error || "scan_budget_exhausted";
      }
      continue;
    }
    try {
      const result = await scanWallet({
        trader,
        saved: state.wallets[trader.address],
        rpc,
        holdings,
        detectedAt,
        limits,
      });
      state.wallets[trader.address] = result.wallet;
      collected.push(...result.entries);
      if (onProgress) await onProgress({ entries: dedupe(collected) });
    } catch (error) {
      const saved = state.wallets[trader.address];
      saved.last_attempt_at = detectedAt;
      saved.last_error = error?.message || "rpc_error";
      saved.coverage = saved.cursor_initialized ? "error_cursor_kept" : "error";
      state.last_error = saved.last_error;
    }
  }

  const deduped = dedupe(collected);
  if (dexLookup) {
    const staleBefore = Date.parse(detectedAt) - limits.poolCacheMs;
    const needed = [...new Set(deduped.map((entry) => entry.mint))].filter((mint) => {
      const pool = pools[mint];
      return !pool?.fetched_at || Date.parse(pool.fetched_at) < staleBefore;
    });
    try {
      if (needed.length) Object.assign(pools, await dexLookup(needed, detectedAt));
      state.pool_error = null;
    } catch (error) {
      state.pool_error = error.message || "dex_error";
      state.last_error = state.last_error || state.pool_error;
      for (const mint of needed) {
        if (!pools[mint]) {
          pools[mint] = {
            mint,
            status: "error",
            fetched_at: detectedAt,
            error: error.message || "dex_error",
            market_cap_usd: null,
            fdv_usd: null,
            earliest_pool_at: null,
            confidence: "unknown",
            fdv_qualifies_low_cap: false,
          };
        }
      }
    }
  }

  const succeededThisRun = cohort.solana.some((trader) => state.wallets[trader.address].last_success_at === detectedAt);
  if (succeededThisRun) state.last_success_at = detectedAt;

  const open = cohort.solana.filter((trader) => state.wallets[trader.address].coverage !== "ok");
  if (!succeededThisRun && !state.last_success_at) state.last_run_status = "error";
  else if (!succeededThisRun) state.last_run_status = "error";
  else if (open.length || budgetStopped || state.pool_error) state.last_run_status = "partial";
  else state.last_run_status = "complete";
  state.rpc_requests = rpc.requests ?? null;
  return { state, entries: deduped, holdings, pools };
}

function dedupe(entries) {
  const seen = new Map();
  for (const entry of entries) {
    if (!entry?.id || seen.has(entry.id)) continue;
    seen.set(entry.id, entry);
  }
  return [...seen.values()];
}
