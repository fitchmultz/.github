import { once } from "node:events";
import { createServer } from "node:http";

const nativeFetch = globalThis.fetch;
await import("./npm-version-api.mjs");
const api = globalThis.fetch;
const server = createServer((request) => request.socket.destroy());
server.listen(0, "127.0.0.1");
await once(server, "listening");
server.unref();

globalThis.fetch = (input, options) => {
  const url = new URL(input);
  if (url.pathname === process.env.FAKE_TRANSPORT_PATH) {
    return nativeFetch(`http://127.0.0.1:${server.address().port}${url.pathname}?private=sentinel-query#sentinel-fragment`, options);
  }
  return api(input, options);
};
