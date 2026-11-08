import assert from "node:assert/strict";
import test from "node:test";
import { TOKEN_PROGRAM } from "../lib/limits.js";
import { emptyState } from "../lib/feed.js";
import { runScan } from "../scanner/scan.js";

const OWNER = "Owner1111111111111111111111111111111111111";
const OTHER = "Other1111111111111111111111111111111111111";
const ATA = "Ata11111111111111111111111111111111111111111";
const MINT = "Mint111111111111111111111111111111111111111";

function cohortOf(addresses) {
  return {
    solana: addresses.map((address, index) => ({
      address,
      handle: `h${index}`,
      rank: index + 1,
      stale_sample: false,
    })),
  };
}

function tokenAccount(mint = MINT) {
  return {
    value: [{
      pubkey: ATA,
      account: {
        owner: TOKEN_PROGRAM,
        data: { parsed: { info: { mint, tokenAmount: { amount: "1000", decimals: 6, uiAmountString: "0.001" } } } },
      },
    }],
  };
}

function swapTx(signature) {
  return {
    slot: 20,
    blockTime: Date.parse("2026-11-07T17:40:00Z") / 1000,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1_000_000_000],
      postBalances: [400_000_000],
      preTokenBalances: [],
      postTokenBalances: [{
        accountIndex: 1,
        mint: MINT,
        owner: OWNER,
        programId: TOKEN_PROGRAM,
        uiTokenAmount: { amount: "250000", decimals: 6, uiAmountString: "0.25" },
      }],
      innerInstructions: [],
    },
    transaction: {
      signatures: [signature],
      message: { accountKeys: [{ pubkey: OWNER, signer: true }] },
    },
  };
}

function transferTx(signature) {
  const tx = swapTx(signature);
  tx.meta.preBalances = [100_000];
  tx.meta.postBalances = [95_000];
  return tx;
}

function installRpc(script) {
  const calls = [];
  return {
    requests: 0,
    calls,
    async call(method, params) {
      this.requests += 1;
      calls.push({ method, params });
      return script(method, params);
    },
  };
}

test("baseline holdings never become buys, and a later swap is one entry after dedupe", async () => {
  const state = emptyState();
  const holdings = { baseline: {}, latest: {} };
  let phase = "baseline";
  const rpc = installRpc((method, params) => {
    const [address, config] = params;
    if (method === "getTokenAccountsByOwner") {
      const program = params[1].programId;
      return program === TOKEN_PROGRAM ? tokenAccount() : { value: [] };
    }
    if (method === "getSignaturesForAddress") {
      if (config.limit === 1) return [{ signature: "baseSig", slot: 1 }];
      if (phase === "transfer") return [{ signature: "transferSig", slot: 3 }];
      if (phase === "swap") return [{ signature: "buySig", slot: 2 }];
      return [];
    }
    if (method === "getTransaction") {
      return params[0] === "transferSig" ? transferTx("transferSig") : swapTx("buySig");
    }
    throw new Error(method);
  });

  const first = await runScan({
    cohort: cohortOf([OWNER]),
    state,
    entries: [],
    holdings,
    pools: {},
    rpc,
    now: new Date("2026-11-07T18:00:00Z"),
    deadlineMs: Date.now() + 60_000,
  });
  assert.equal(first.entries.length, 0);
  assert.equal(state.wallets[OWNER].cursor, "baseSig");
  assert.equal(holdings.baseline[OWNER].status, "ok");
  assert.equal(holdings.baseline[OWNER].accounts[0].mint, MINT);
  assert.equal(rpc.calls.some((call) => call.method === "getTransaction"), false);

  phase = "transfer";
  const second = await runScan({
    cohort: cohortOf([OWNER]),
    state,
    entries: first.entries,
    holdings,
    pools: {},
    rpc,
    now: new Date("2026-11-07T18:05:00Z"),
    deadlineMs: Date.now() + 60_000,
  });
  assert.equal(second.entries.length, 0);
  assert.ok(state.wallets[OWNER].transfers_ignored >= 1);
  assert.equal(holdings.baseline[OWNER].at, "2026-11-07T18:00:00.000Z");

  phase = "swap";
  const third = await runScan({
    cohort: cohortOf([OWNER]),
    state,
    entries: second.entries,
    holdings,
    pools: {},
    rpc,
    dexLookup: async () => ({
      [MINT]: { mint: MINT, market_cap_usd: 1000, earliest_pool_at: "2026-11-07T17:00:00Z", fdv_usd: null, status: "ok" },
    }),
    now: new Date("2026-11-07T18:10:00Z"),
    deadlineMs: Date.now() + 60_000,
  });
  assert.equal(third.entries.length, 1);
  assert.equal(third.entries[0].mint, MINT);
  assert.equal(third.entries[0].confidence, "confirmed");
  assert.equal(third.entries[0].block_time, "2026-11-07T17:40:00.000Z");
  const txCalls = rpc.calls.filter((call) => call.method === "getTransaction" && call.params[0] === "buySig");
  assert.ok(txCalls.length >= 2);

  phase = "idle";
  const fourth = await runScan({
    cohort: cohortOf([OWNER]),
    state,
    entries: third.entries,
    holdings,
    pools: third.pools,
    rpc,
    now: new Date("2026-11-07T18:20:00Z"),
    deadlineMs: Date.now() + 60_000,
  });
  assert.equal(fourth.entries.length, 1);
});

test("a signature gap and a failed wallet stay partial and do not invent buys", async () => {
  const state = emptyState();
  const holdings = { baseline: {}, latest: {} };
  const rpc = installRpc((method, params) => {
    const address = params[0];
    if (method === "getTokenAccountsByOwner") return { value: [] };
    if (method === "getSignaturesForAddress") {
      if (address === OTHER) throw new Error("rpc_429");
      if (!params[1].until) return [{ signature: "cursor", slot: 4 }];
      return [{ signature: "newer", slot: 5 }];
    }
    throw new Error(`unexpected ${method}`);
  });
  const limits = { signaturePageSize: 1, maxPages: 1, maxAtaPerWallet: 8, maxUnparsedAttempts: 5, solDustLamports: 10_000, poolCacheMs: 1 };
  await runScan({
    cohort: cohortOf([OWNER]),
    state,
    entries: [],
    holdings,
    pools: {},
    rpc,
    now: new Date("2026-11-07T18:00:00Z"),
    limits,
    deadlineMs: Date.now() + 60_000,
  });
  const next = await runScan({
    cohort: cohortOf([OWNER, OTHER]),
    state,
    entries: [],
    holdings,
    pools: {},
    rpc,
    now: new Date("2026-11-07T19:00:00Z"),
    limits,
    deadlineMs: Date.now() + 60_000,
  });
  assert.equal(next.entries.length, 0);
  assert.equal(state.wallets[OWNER].cursor, "cursor");
  assert.equal(state.wallets[OWNER].history_gap, true);
  assert.equal(state.wallets[OTHER].cursor_initialized, false);
  assert.match(state.wallets[OTHER].last_error, /rpc_429/);
  assert.equal(state.last_run_status, "partial");
});
