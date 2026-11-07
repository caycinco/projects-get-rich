import { LIMITS } from "../lib/limits.js";

export function createLimiter({ minIntervalMs, maxConcurrent }) {
  let active = 0;
  let lastStart = 0;
  const waiting = [];

  const pump = () => {
    while (active < maxConcurrent && waiting.length) {
      const job = waiting.shift();
      const wait = Math.max(0, minIntervalMs - (Date.now() - lastStart));
      active += 1;
      lastStart = Date.now() + wait;
      setTimeout(async () => {
        try {
          job.resolve(await job.fn());
        } catch (error) {
          job.reject(error);
        } finally {
          active -= 1;
          pump();
        }
      }, wait);
    }
  };

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      waiting.push({ fn, resolve, reject });
      pump();
    });
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRpc({
  url,
  fetchImpl = globalThis.fetch,
  limits = LIMITS,
  limiter = createLimiter({ minIntervalMs: limits.rpcMinIntervalMs, maxConcurrent: limits.rpcConcurrency }),
} = {}) {
  if (!url) throw new Error("rpc_url_missing");
  let requests = 0;

  async function call(method, params) {
    requests += 1;
    let delay = 400;
    let lastError = null;
    for (let attempt = 0; attempt <= limits.maxRetries; attempt += 1) {
      try {
        return await limiter(async () => {
          const response = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            signal: AbortSignal.timeout(limits.requestTimeoutMs),
          });
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable) {
            const error = new Error(`rpc_${response.status}`);
            error.retryable = true;
            throw error;
          }
          if (!response.ok) throw new Error(`rpc_${response.status}`);
          const body = await response.json();
          if (body?.error) {
            const code = body.error.code;
            const message = body.error.message || "rpc_error";
            const error = new Error(message);
            error.retryable = code === 429 || code === -32005 || /rate|limit|congest/i.test(message);
            throw error;
          }
          return body.result;
        });
      } catch (error) {
        lastError = error;
        if (!error.retryable || attempt === limits.maxRetries) throw error;
        await sleep(delay);
        delay = Math.min(delay * 2, 8_000);
      }
    }
    throw lastError || new Error("rpc_failed");
  }

  return {
    call,
    get requests() {
      return requests;
    },
    url,
  };
}
