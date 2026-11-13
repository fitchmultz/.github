import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const RETRY_DELAYS_MS = [200, 600];

export async function releaseFetch(service, input, options = {}) {
  // Native fetch echoes invalid or credential-bearing URLs in its errors.
  assert.ok(URL.canParse(input), `${service} request URL is invalid`);
  const url = new URL(input);
  assert.ok(!url.username && !url.password, `${service} request URL must not contain credentials`);
  const method = (options.method ?? "GET").toUpperCase();
  const retryable = method === "GET" || method === "HEAD";
  const delays = retryable ? RETRY_DELAYS_MS : [];
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(input, options);
    } catch (cause) {
      if (attempt < delays.length && !options.signal?.aborted) {
        try {
          await delay(delays[attempt], undefined, { signal: options.signal });
          continue;
        } catch {
          // Caller signal aborted while waiting; fall through and report the transport failure.
        }
      }
      throw new Error(`${service} ${options.method ?? "GET"} ${url.origin}${url.pathname}: transport failed`, { cause });
    }
    if (TRANSIENT_STATUSES.has(response.status) && attempt < delays.length && !options.signal?.aborted) {
      await response.body?.cancel().catch(() => {});
      try {
        await delay(delays[attempt], undefined, { signal: options.signal });
        continue;
      } catch {
        return response;
      }
    }
    return response;
  }
}
