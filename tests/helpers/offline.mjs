// Test-only outbound network guard. The real SDK loopback is restricted to literal loopback IPs.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
function check(value, channel) {
  const host = typeof value === "string" || value instanceof URL ? new URL(value).hostname : value?.hostname ?? value?.host ?? "localhost";
  if (!["127.0.0.1", "::1", "[::1]", "localhost"].includes(host)) {
    if (process.env.DSH_KERNEL_NETWORK_LOG) appendFileSync(process.env.DSH_KERNEL_NETWORK_LOG, JSON.stringify({ channel, blocked: true, pid: process.pid }) + "\n");
    throw new Error("OFFLINE_TEST: external network denied");
  }
}
const fetch = globalThis.fetch;
globalThis.fetch = (input, options) => { check(typeof input === "string" || input instanceof URL ? input : input.url, "fetch"); return fetch(input, options); };
for (const client of [http, https]) for (const method of ["request", "get"]) {
  const original = client[method]; client[method] = function (input, ...args) { check(input, method); return original.call(this, input, ...args); };
}
for (const client of [net, tls]) for (const method of client === net ? ["connect", "createConnection"] : ["connect"]) {
  const original = client[method]; client[method] = function (input, ...args) { check(typeof input === "number" ? { host: typeof args[0] === "string" ? args[0] : "localhost" } : input, method); return original.call(this, input, ...args); };
}
syncBuiltinESMExports();
