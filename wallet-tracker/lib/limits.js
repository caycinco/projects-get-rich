export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

export const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

export const QUOTE_LABEL = {
  [WSOL_MINT]: "WSOL",
  [USDC_MINT]: "USDC",
  [USDT_MINT]: "USDT",
};

export const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
export const DEX_TOKENS_URL = "https://api.dexscreener.com/tokens/v1/solana";

export const CRITERIA_DEFAULTS = Object.freeze({
  new_pool_max_age_hours: 24,
  low_cap_max_market_cap_usd: 1_000_000,
  rolling_buy_window_minutes: 30,
  stale_after_minutes: 180,
});

export const LIMITS = Object.freeze({
  signaturePageSize: 25,
  maxPages: 8,
  maxAtaPerWallet: 8,
  maxUnparsedAttempts: 5,
  solDustLamports: 10_000,
  rpcMinIntervalMs: 150,
  rpcConcurrency: 2,
  requestTimeoutMs: 20_000,
  maxRetries: 4,
  poolCacheMs: 15 * 60 * 1000,
  dexBatch: 30,
  scanBudgetMs: 9 * 60 * 1000,
});

export const CADENCE = Object.freeze({
  schedule: "hourly",
  cron: "17 * * * *",
  stale_after_minutes: CRITERIA_DEFAULTS.stale_after_minutes,
  label:
    "Hourly GitHub Actions scan at minute 17. GitHub delays scheduled runs under load, often past the clock minute. This page is not a live feed.",
});
