const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = Object.fromEntries([...BASE58].map((char, index) => [char, index]));

const STALE_HANDLES = new Set(["CivilOpenPig", "TheMilesBron"]);

export function decodeBase58(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return null;
  const bytes = [0];
  for (const char of value) {
    const digit = BASE58_INDEX[char];
    if (digit === undefined) return null;
    let carry = digit;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of value) {
    if (char === "1") bytes.push(0);
    else break;
  }
  return Uint8Array.from(bytes.reverse());
}

export function solanaAddressError(value) {
  if (typeof value !== "string") return "not_a_string";
  if (value !== value.trim()) return "whitespace";
  if (value.length < 32 || value.length > 44) return "length";
  const decoded = decodeBase58(value);
  if (!decoded) return "alphabet";
  if (decoded.length !== 32) return "decoded_length";
  return null;
}

export function evmAddressError(value) {
  if (typeof value !== "string") return "not_a_string";
  if (value !== value.trim()) return "whitespace";
  if (value.length !== 42) return "length";
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return "charset";
  return null;
}

function quarantineRow(trader, wallet, reason) {
  return {
    rank: trader?.rank ?? null,
    handle: trader?.handle ?? null,
    chain: wallet?.chain ?? null,
    address: typeof wallet?.address === "string" ? wallet.address : null,
    reason,
    retrieved_at: trader?.retrieved_at ?? null,
  };
}

export function validateCohort(source) {
  const rows = Array.isArray(source) ? source : [];
  const traders = [];
  const quarantine = [];
  const solana = [];

  rows.forEach((trader, index) => {
    const handle = typeof trader?.handle === "string" ? trader.handle : null;
    const rank = Number.isInteger(trader?.rank) ? trader.rank : null;
    const stale = STALE_HANDLES.has(handle) || rank === 2 || rank === 4;
    const wallets = [];
    const inputWallets = Array.isArray(trader?.wallets) ? trader.wallets : [];

    if (!handle || rank == null) {
      quarantine.push(quarantineRow(trader, null, "trader_identity"));
    }

    for (const wallet of inputWallets) {
      const chain = wallet?.chain;
      if (chain === "Solana") {
        const reason = solanaAddressError(wallet.address);
        if (reason) {
          quarantine.push(quarantineRow(trader, wallet, `solana_${reason}`));
          continue;
        }
        const record = {
          chain: "solana",
          address: wallet.address,
          scanned: true,
        };
        wallets.push(record);
        solana.push({
          rank,
          handle,
          address: wallet.address,
          stale_sample: stale,
          source: trader?.source || null,
          retrieved_at: trader?.retrieved_at || null,
        });
      } else if (chain === "EVM") {
        const reason = evmAddressError(wallet.address);
        if (reason) {
          quarantine.push(quarantineRow(trader, wallet, `evm_${reason}`));
          continue;
        }
        wallets.push({
          chain: "evm",
          address: wallet.address,
          scanned: false,
          reason: "EVM family only. No specific chain was published, so no EVM history is read.",
        });
      } else {
        quarantine.push(quarantineRow(trader, wallet, "unknown_chain"));
      }
    }

    traders.push({
      rank,
      handle,
      profile_name: trader?.profile_name || null,
      stale_sample: stale,
      stale_note: stale
        ? "Stale leaderboard sample in the 7 Nov 2026 24h cohort. Kept because the cohort is fixed. Not treated as a current ranking."
        : null,
      source: trader?.source || null,
      retrieved_at: trader?.retrieved_at || null,
      note: trader?.note || null,
      source_index: index,
      wallets,
      solana_addresses: wallets.filter((wallet) => wallet.chain === "solana").map((wallet) => wallet.address),
      evm_only: wallets.some((wallet) => wallet.chain === "evm") && !wallets.some((wallet) => wallet.chain === "solana"),
    });
  });

  return {
    id: "fomolens-top30-2026-11-07",
    fixed: true,
    ownership_verified: false,
    long_term_quality: false,
    retrieved_window: {
      start: "2026-11-07T16:35:21Z",
      end: "2026-11-07T16:51:18Z",
    },
    caveat:
      "Fixed 24h FOMO leaderboard cohort from ordinary public FomoLens lookups on 7 Nov 2026 UTC. Third-party wallet attribution is unverified. A 24h leaderboard is not a long-term quality set. Rank 2 CivilOpenPig and rank 4 TheMilesBron are stale samples and stay in the fixed cohort.",
    traders,
    quarantine,
    solana,
    counts: {
      traders: traders.length,
      solana: solana.length,
      evm_only: traders.filter((trader) => trader.evm_only).length,
      quarantine: quarantine.length,
    },
  };
}
