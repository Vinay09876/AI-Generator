// Isolated E2E only. Preloaded into EVERY Node process of the isolated run (Next server, its
// workers, the clipper worker, Prisma CLI, the guard) via NODE_OPTIONS="--import <this file>".
// Blocks every outbound TCP/TLS connection and DNS lookup that is not loopback. Local IPC (named
// pipes / unix sockets) is allowed. Every blocked attempt is appended to E2E_EGRESS_LOG.
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";

const LOG = process.env.E2E_EGRESS_LOG;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]);
const isLoopback = (host) => LOOPBACK.has(String(host ?? "localhost").replace(/^\[|\]$/g, "").toLowerCase());

function blocked(what, target) {
  const msg = `[egress-blocked] ${what} ${target} pid=${process.pid} argv=${process.argv.slice(1, 3).join(" ")}`;
  try {
    if (LOG) fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // ignore
  }
  return Object.assign(new Error(msg), { code: "E2E_EGRESS_BLOCKED" });
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0]; // already-normalised internal form
  if (typeof options === "number" || (typeof options === "string" && /^\d+$/.test(options))) {
    options = { port: Number(options), host: typeof args[1] === "string" ? args[1] : "localhost" };
  } else if (typeof options === "string") {
    options = { path: options }; // IPC path
  }
  if (options && typeof options === "object" && !options.path) {
    const host = options.host ?? options.hostname ?? "localhost";
    if (!isLoopback(host)) {
      const err = blocked("connect", `${host}:${options.port}`);
      process.nextTick(() => this.destroy(err));
      return this;
    }
  }
  return originalConnect.apply(this, args);
};

const originalLookup = dns.lookup;
dns.lookup = function patchedLookup(hostname, options, callback) {
  const cb = typeof options === "function" ? options : callback;
  if (!isLoopback(hostname)) {
    const err = blocked("dns", hostname);
    process.nextTick(() => cb(err));
    return {};
  }
  return originalLookup.call(this, hostname, options, callback);
};
const originalPromisesLookup = dns.promises.lookup;
dns.promises.lookup = async function patchedPromisesLookup(hostname, options) {
  if (!isLoopback(hostname)) throw blocked("dns", hostname);
  return originalPromisesLookup.call(this, hostname, options);
};

globalThis.__E2E_EGRESS_GUARD__ = true;
