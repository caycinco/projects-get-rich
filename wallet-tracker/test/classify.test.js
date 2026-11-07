import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { classifyTransaction, dedupeEntries } from "../lib/classify.js";
import { planSignatureWindow } from "../lib/cursor.js";
import { TOKEN_2022, TOKEN_PROGRAM, USDC_MINT } from "../lib/limits.js";

const WALLET = "Wallet1111111111111111111111111111111111111";
const MINT = "Mint111111111111111111111111111111111111111";
const HOP = "Hop1111111111111111111111111111111111111111";
const OTHER = "Other11111111111111111111111111111111111111";

function key(pubkey, signer = false) {
  return { pubkey, signer };
}

function transaction(overrides = {}) {
  return {
    slot: 10,
    blockTime: 1_762_531_200,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1_000_000_000],
      postBalances: [500_000_000],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
      ...(overrides.meta || {}),
    },
    transaction: {
      signatures: ["sig"],
      message: { accountKeys: [key(WALLET, true)] },
      ...(overrides.transaction || {}),
    },
  };
}

function tokenBalance({ mint, amount, owner = WALLET, accountIndex = 1, programId = TOKEN_PROGRAM, decimals = 6 }) {
  return {
    accountIndex,
    mint,
    owner,
    programId,
    uiTokenAmount: { amount: String(amount), decimals, uiAmountString: String(amount) },
  };
}

test("confirmed swap requires quote spend and token receipt from a signer", () => {
  const tx = transaction({
    meta: {
      postTokenBalances: [tokenBalance({ mint: MINT, amount: 1_000_000 })],
    },
  });
  const result = classifyTransaction(tx, WALLET);
  assert.equal(result.kind, "confirmed_swap");
  assert.equal(result.confidence, "confirmed");
  assert.equal(result.buys.length, 1);
  assert.equal(result.buys[0].mint, MINT);
  assert.equal(result.buys[0].quotes[0].symbol, "SOL");
  assert.equal(result.buys[0].programId, TOKEN_PROGRAM);
});

test("token-2022 receipt is classified the same way", () => {
  const tx = transaction({
    meta: {
      postTokenBalances: [tokenBalance({ mint: MINT, amount: 5, programId: TOKEN_2022 })],
    },
  });
  const result = classifyTransaction(tx, WALLET);
  assert.equal(result.kind, "confirmed_swap");
  assert.equal(result.buys[0].programId, TOKEN_2022);
});

test("fee-only movement with a token in is a transfer, not a swap", () => {
  const tx = transaction({
    meta: {
      preBalances: [100_000],
      postBalances: [95_000],
      fee: 5000,
      postTokenBalances: [tokenBalance({ mint: MINT, amount: 9 })],
    },
  });
  const result = classifyTransaction(tx, WALLET);
  assert.equal(result.kind, "transfer_or_airdrop");
  assert.equal(result.reason, "token_in_without_quote_spend");
  assert.deepEqual(result.buys, []);
});

test("rent for a new token account is not quote spend", () => {
  const tx = transaction({
    meta: {
      preBalances: [2_044_280],
      postBalances: [0],
      fee: 5000,
      postTokenBalances: [tokenBalance({ mint: MINT, amount: 42 })],
      innerInstructions: [{
        instructions: [{
          parsed: { type: "createAccount", info: { source: WALLET, newAccount: "Ata", lamports: 2_039_280 } },
        }],
      }],
    },
  });
  assert.equal(classifyTransaction(tx, WALLET).kind, "transfer_or_airdrop");
});

test("a swap that also creates an account still counts the sol spent above rent", () => {
  const tx = transaction({
    meta: {
      preBalances: [102_044_280],
      postBalances: [0],
      fee: 5000,
      postTokenBalances: [tokenBalance({ mint: MINT, amount: 42 })],
      innerInstructions: [{
        instructions: [{
          parsed: { type: "createAccount", info: { source: WALLET, newAccount: "Ata", lamports: 2_039_280 } },
        }],
      }],
    },
  });
  const result = classifyTransaction(tx, WALLET);
  assert.equal(result.kind, "confirmed_swap");
  assert.equal(result.buys[0].quotes[0].spent_raw, "100000000");
});

test("unsigned token receipt is an airdrop even if balances moved", () => {
  const tx = transaction({
    meta: {
      postTokenBalances: [tokenBalance({ mint: MINT, amount: 5 })],
    },
    transaction: { message: { accountKeys: [key(WALLET, false)] } },
  });
  const result = classifyTransaction(tx, WALLET);
  assert.equal(result.kind, "transfer_or_airdrop");
  assert.equal(result.reason, "wallet_not_signer");
});

test("route hops with a flat intermediate mint emit one buy", () => {
  const tx = transaction({
    meta: {
      preBalances: [10_000],
      postBalances: [5_000],
      fee: 5000,
      preTokenBalances: [
        tokenBalance({ mint: USDC_MINT, amount: 1_000_000, accountIndex: 2, decimals: 6 }),
        tokenBalance({ mint: HOP, amount: 5, accountIndex: 3 }),
      ],
      postTokenBalances: [
        tokenBalance({ mint: USDC_MINT, amount: 400_000, accountIndex: 2, decimals: 6 }),
        tokenBalance({ mint: HOP, amount: 5, accountIndex: 3 }),
        tokenBalance({ mint: MINT, amount: 77, accountIndex: 4 }),
      ],
    },
  });
  const result = classifyTransaction(tx, WALLET);
  assert.equal(result.kind, "confirmed_swap");
  assert.equal(result.buys.length, 1);
  assert.equal(result.buys[0].mint, MINT);
  assert.equal(result.flat_hops, 1);
  assert.equal(result.buys[0].quotes.some((quote) => quote.symbol === "USDC"), true);
});

test("failed and unparsed transactions are not buys", () => {
  assert.equal(classifyTransaction(transaction({ meta: { err: { InstructionError: [] } } }), WALLET).kind, "failed");
  assert.equal(classifyTransaction({ transaction: {} }, WALLET).kind, "unparsed");
});

test("dedupe is signature plus wallet plus mint, including owner and ata repeats", () => {
  const first = { signature: "sig", wallet: WALLET, mint: MINT, received_raw: "1" };
  const repeat = { signature: "sig", wallet: WALLET, mint: MINT, received_raw: "1" };
  const otherMint = { signature: "sig", wallet: WALLET, mint: OTHER, received_raw: "2" };
  const otherWallet = { signature: "sig", wallet: OTHER, mint: MINT, received_raw: "3" };
  const rows = dedupeEntries([first, repeat, otherMint, otherWallet]);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.id)).size, 3);
});

test("cursor baseline does not process history, and a gap does not skip ahead", () => {
  const baseline = planSignatureWindow({
    pages: [[{ signature: "newest", slot: 9 }, { signature: "older", slot: 8 }]],
    initialized: false,
  });
  assert.equal(baseline.mode, "baseline");
  assert.deepEqual(baseline.process, []);
  assert.equal(baseline.nextCursor, "newest");

  const forward = planSignatureWindow({
    pages: [[{ signature: "newest", slot: 9 }, { signature: "mid", slot: 8 }]],
    cursor: "old",
    initialized: true,
    reachedCursor: true,
  });
  assert.deepEqual(forward.process.map((row) => row.signature), ["mid", "newest"]);
  assert.equal(forward.nextCursor, "newest");

  const gap = planSignatureWindow({
    pages: [[{ signature: "newest", slot: 20 }]],
    cursor: "old",
    initialized: true,
    reachedCursor: false,
  });
  assert.equal(gap.mode, "gap");
  assert.deepEqual(gap.process, []);
  assert.equal(gap.nextCursor, "old");
  assert.equal(gap.gap, true);
});

test("classifier source stays free of execution and secret endpoints", () => {
  const source = fs.readFileSync(new URL("../lib/classify.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /signTransaction|private.?key|jupiter|helius|birdeye/i);
});
