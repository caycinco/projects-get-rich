import { QUOTE_LABEL, QUOTE_MINTS, TOKEN_2022, TOKEN_PROGRAM } from "./limits.js";
import { formatRawAmount, unixSecondsToUtc } from "./time.js";

function asBigInt(value) {
  if (value == null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function accountKeys(tx) {
  const keys = tx?.transaction?.message?.accountKeys;
  if (!Array.isArray(keys)) return [];
  return keys.map((key) => {
    if (typeof key === "string") return { pubkey: key, signer: false };
    return { pubkey: key?.pubkey || null, signer: Boolean(key?.signer) };
  });
}

function eachInstruction(tx, visit) {
  const outer = tx?.transaction?.message?.instructions || [];
  outer.forEach((instruction, index) => visit(instruction, `outer:${index}`));
  (tx?.meta?.innerInstructions || []).forEach((group, groupIndex) => {
    (group?.instructions || []).forEach((instruction, index) => visit(instruction, `inner:${groupIndex}:${index}`));
  });
}

export function rentLamportsPaidBy(tx, wallet) {
  const seen = new Set();
  let rent = 0n;
  eachInstruction(tx, (instruction) => {
    const type = instruction?.parsed?.type;
    const info = instruction?.parsed?.info;
    if (!info || (type !== "createAccount" && type !== "createAccountWithSeed")) return;
    if (info.source !== wallet || info.lamports == null) return;
    const identity = `${info.newAccount || info.base || ""}:${info.lamports}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const lamports = asBigInt(info.lamports);
    if (lamports != null && lamports > 0n) rent += lamports;
  });
  return rent;
}

export function nativeSolMovement(tx, wallet) {
  const keys = accountKeys(tx);
  const index = keys.findIndex((key) => key.pubkey === wallet);
  if (index < 0) {
    return { known: false, isSigner: false, isFeePayer: false, quoteSpend: 0n, fee: 0n, rent: 0n };
  }
  const pre = tx?.meta?.preBalances?.[index];
  const post = tx?.meta?.postBalances?.[index];
  const fee = asBigInt(tx?.meta?.fee) ?? 0n;
  const isFeePayer = index === 0;
  if (pre == null || post == null) {
    return { known: false, isSigner: keys[index].signer, isFeePayer, quoteSpend: 0n, fee, rent: 0n };
  }
  let drop = BigInt(pre) - BigInt(post);
  if (isFeePayer) drop -= fee;
  const rent = rentLamportsPaidBy(tx, wallet);
  const quoteSpend = drop - rent;
  return {
    known: true,
    isSigner: keys[index].signer,
    isFeePayer,
    quoteSpend: quoteSpend > 0n ? quoteSpend : 0n,
    fee,
    rent,
  };
}

function tokenRows(tx, wallet) {
  const rows = new Map();
  const absorb = (list, side) => {
    for (const row of list || []) {
      if (row?.owner !== wallet || !row.mint) continue;
      const amount = asBigInt(row.uiTokenAmount?.amount);
      if (amount == null) continue;
      const id = `${row.accountIndex}:${row.mint}`;
      const current = rows.get(id) || {
        mint: row.mint,
        accountIndex: row.accountIndex,
        programId: row.programId || null,
        decimals: row.uiTokenAmount?.decimals ?? null,
        pre: 0n,
        post: 0n,
        sawPre: false,
        sawPost: false,
      };
      current[side] = amount;
      current[`saw${side === "pre" ? "Pre" : "Post"}`] = true;
      if (row.programId) current.programId = row.programId;
      if (row.uiTokenAmount?.decimals != null) current.decimals = row.uiTokenAmount.decimals;
      rows.set(id, current);
    }
  };
  absorb(tx?.meta?.preTokenBalances, "pre");
  absorb(tx?.meta?.postTokenBalances, "post");
  return [...rows.values()];
}

function byMint(rows) {
  const mints = new Map();
  for (const row of rows) {
    const current = mints.get(row.mint) || {
      mint: row.mint,
      delta: 0n,
      decimals: row.decimals,
      programId: row.programId,
      accounts: 0,
    };
    current.delta += row.post - row.pre;
    current.accounts += 1;
    if (row.decimals != null) current.decimals = row.decimals;
    if (row.programId) current.programId = row.programId;
    mints.set(row.mint, current);
  }
  return [...mints.values()];
}

function quoteSymbol(mint) {
  return QUOTE_LABEL[mint] || "QUOTE";
}

export function classifyTransaction(tx, wallet, { solDustLamports = 10_000 } = {}) {
  if (!tx || tx.meta == null) {
    return { kind: "unparsed", reason: "missing_meta", buys: [] };
  }
  if (tx.meta.err) {
    return { kind: "failed", reason: "transaction_error", buys: [] };
  }

  const sol = nativeSolMovement(tx, wallet);
  const mints = byMint(tokenRows(tx, wallet));
  const dust = BigInt(solDustLamports);
  const quotes = [];
  const receipts = [];
  let flatHops = 0;

  if (sol.known && sol.quoteSpend > dust) {
    quotes.push({
      mint: "SOL",
      symbol: "SOL",
      spent_raw: sol.quoteSpend.toString(),
      decimals: 9,
      programId: null,
    });
  }

  for (const row of mints) {
    if (row.delta === 0n) {
      flatHops += 1;
      continue;
    }
    if (QUOTE_MINTS.has(row.mint)) {
      if (row.delta < 0n) {
        quotes.push({
          mint: row.mint,
          symbol: quoteSymbol(row.mint),
          spent_raw: (-row.delta).toString(),
          decimals: row.decimals,
          programId: row.programId,
        });
      }
      continue;
    }
    if (row.delta > 0n) receipts.push(row);
  }

  const knownProgram = receipts.some((row) => row.programId === TOKEN_PROGRAM || row.programId === TOKEN_2022);
  if (!receipts.length) {
    return { kind: "no_receipt", reason: "no_non_quote_token_increase", buys: [], flat_hops: flatHops, is_signer: sol.isSigner };
  }
  if (!quotes.length || !sol.isSigner) {
    return {
      kind: "transfer_or_airdrop",
      reason: !sol.isSigner ? "wallet_not_signer" : "token_in_without_quote_spend",
      buys: [],
      ignored_mints: receipts.map((row) => row.mint),
      flat_hops: flatHops,
      is_signer: sol.isSigner,
      token_program_known: knownProgram,
    };
  }

  return {
    kind: "confirmed_swap",
    confidence: "confirmed",
    reason: "quote_spend_and_token_receipt",
    flat_hops: flatHops,
    is_signer: true,
    buys: receipts.map((row) => ({
      mint: row.mint,
      received_raw: row.delta.toString(),
      decimals: row.decimals,
      programId: row.programId,
      quotes,
    })),
  };
}

export function entryFromBuy({ tx, signature, wallet, trader, buy, detectedAt }) {
  return {
    id: `${signature}:${wallet}:${buy.mint}`,
    signature,
    slot: Number.isInteger(tx?.slot) ? tx.slot : null,
    wallet,
    handle: trader?.handle || null,
    rank: trader?.rank ?? null,
    stale_sample: Boolean(trader?.stale_sample),
    mint: buy.mint,
    received_raw: buy.received_raw,
    decimals: buy.decimals ?? null,
    received_ui: formatRawAmount(buy.received_raw, buy.decimals ?? null),
    token_program: buy.programId || null,
    quote_legs: (buy.quotes || []).map((quote) => ({
      ...quote,
      spent_ui: formatRawAmount(quote.spent_raw, quote.decimals ?? null),
    })),
    block_time: unixSecondsToUtc(tx?.blockTime),
    block_time_confidence: tx?.blockTime == null ? "unknown" : "confirmed",
    classification: "confirmed_swap",
    confidence: "confirmed",
    commitment: "confirmed",
    detected_at: detectedAt,
    links: {
      tx_solscan: `https://solscan.io/tx/${signature}`,
      tx_explorer: `https://explorer.solana.com/tx/${signature}`,
      wallet_solscan: `https://solscan.io/account/${wallet}`,
      mint_solscan: `https://solscan.io/token/${buy.mint}`,
    },
  };
}

export function dedupeEntries(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    if (!entry?.signature || !entry?.wallet || !entry?.mint) continue;
    const id = `${entry.signature}:${entry.wallet}:${entry.mint}`;
    if (!map.has(id)) map.set(id, { ...entry, id });
  }
  return [...map.values()];
}
