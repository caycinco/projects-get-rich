import { DEX_TOKENS_URL, LIMITS } from "../lib/limits.js";
import { reduceDexPairs } from "../lib/qualify.js";

export function createDexLookup({
  fetchImpl = globalThis.fetch,
  limits = LIMITS,
  now = () => new Date().toISOString(),
} = {}) {
  return async function dexLookup(mints, fetchedAt = now()) {
    const unique = [...new Set(mints)].filter(Boolean);
    const pools = {};
    for (let index = 0; index < unique.length; index += limits.dexBatch) {
      const batch = unique.slice(index, index + limits.dexBatch);
      const response = await fetchImpl(`${DEX_TOKENS_URL}/${batch.join(",")}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(limits.requestTimeoutMs),
      });
      if (response.status === 429 || response.status >= 500) {
        const error = new Error(`dex_${response.status}`);
        error.retryable = true;
        throw error;
      }
      if (!response.ok) throw new Error(`dex_${response.status}`);
      const body = await response.json();
      const pairs = Array.isArray(body) ? body : body?.pairs || [];
      const grouped = new Map(batch.map((mint) => [mint, []]));
      for (const pair of pairs) {
        const base = pair?.baseToken?.address;
        const quote = pair?.quoteToken?.address;
        if (grouped.has(base)) grouped.get(base).push(pair);
        if (quote && quote !== base && grouped.has(quote)) grouped.get(quote).push(pair);
      }
      for (const mint of batch) pools[mint] = reduceDexPairs(grouped.get(mint) || [], mint, fetchedAt);
    }
    return pools;
  };
}
