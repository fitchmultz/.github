import assert from "node:assert/strict";

export async function releaseFetch(service, input, options = {}) {
  // Native fetch echoes invalid or credential-bearing URLs in its errors.
  assert.ok(URL.canParse(input), `${service} request URL is invalid`);
  const url = new URL(input);
  assert.ok(!url.username && !url.password, `${service} request URL must not contain credentials`);
  try {
    return await fetch(input, options);
  } catch (cause) {
    throw new Error(`${service} ${options.method ?? "GET"} ${url.origin}${url.pathname}: transport failed`, { cause });
  }
}
