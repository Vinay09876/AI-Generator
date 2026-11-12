// LOCAL STAND-IN for the subset of the Supabase Storage HTTP API that this app uses.
// It exists ONLY for the isolated browser E2E run. Passing tests against it shows the app's
// browser/server flow works end to end on this machine; it does NOT verify real Supabase
// behaviour (CORS, signed-upload format, 0-byte objects, upsert, Range, list semantics, limits).
//
// Endpoints (prefix /storage/v1), mirroring @supabase/storage-js 2.119 requests:
//   POST   /object/list/:bucket                 list one folder level
//   POST   /object/:bucket/:path                upload (x-upsert)
//   DELETE /object/:bucket                      remove { prefixes }
//   GET    /object/info/:bucket/:path           object info
//   POST   /object/upload/sign/:bucket/:path    signed upload URL (x-upsert)
//   PUT    /object/upload/sign/:bucket/:path    browser upload with token (raw body)
//   POST   /object/sign/:bucket/:path           signed download URL
//   GET    /object/sign/:bucket/:path           download with token (Range, ?download=)
// Debug (stand-in only): GET /__debug/objects, POST /__debug/expire-tokens, GET /__debug/stats
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.env.STANDIN_PORT ?? 54321);
const ROOT = process.env.STANDIN_DIR;
const KEY = process.env.STANDIN_SECRET_KEY;
const MAX_OBJECT_BYTES = 50 * 1024 * 1024; // Supabase Free per-object default (assumed)
if (!ROOT || !KEY) {
  console.error("STANDIN_DIR and STANDIN_SECRET_KEY are required");
  process.exit(2);
}
fs.mkdirSync(ROOT, { recursive: true });

const meta = new Map(); // "bucket/path" -> { size, mimetype, created_at, updated_at, id }
const stats = {};
let tokenEpoch = 0;
const hmac = (s) => crypto.createHmac("sha256", KEY).update(s).digest("base64url");
const makeToken = (kind, full, expiresIn, extra = "") => {
  const exp = Date.now() + expiresIn * 1000;
  const body = `${kind}|${full}|${exp}|${tokenEpoch}|${extra}`;
  return Buffer.from(body).toString("base64url") + "." + hmac(body);
};
const readToken = (token, kind, full) => {
  if (!token || !token.includes(".")) return null;
  const [b, sig] = token.split(".");
  const body = Buffer.from(b, "base64url").toString();
  if (hmac(body) !== sig) return null;
  const [k, f, exp, epoch, extra] = body.split("|");
  if (k !== kind || f !== full || Number(exp) < Date.now() || Number(epoch) !== tokenEpoch) return null;
  return { extra };
};

const fileOf = (full) => path.join(ROOT, ...full.split("/"));
const bump = (op) => (stats[op] = (stats[op] ?? 0) + 1);
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,apikey,x-upsert,content-type,range,x-client-info,cache-control",
  "access-control-expose-headers": "content-range,content-length,content-disposition,accept-ranges",
};
function send(res, status, body, headers = {}) {
  const json = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { ...CORS, "content-type": "application/json", ...headers });
  res.end(json);
}
const err = (res, status, error, message) => send(res, status, { statusCode: String(status), error, message });
const authed = (req) => req.headers.authorization === `Bearer ${KEY}` || req.headers.apikey === KEY;
async function readBody(req, limit = MAX_OBJECT_BYTES + 1) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) return { tooLarge: true };
    chunks.push(c);
  }
  return { buf: Buffer.concat(chunks) };
}
function writeObject(full, buf, mimetype) {
  const f = fileOf(full);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
  const now = new Date().toISOString();
  const prev = meta.get(full);
  meta.set(full, { size: buf.length, mimetype: mimetype || "application/octet-stream", created_at: prev?.created_at ?? now, updated_at: now, id: prev?.id ?? crypto.randomUUID() });
}

const server = http.createServer(async (req, res) => {
  if (process.env.STANDIN_LOG) {
    const t0 = Date.now();
    res.on("finish", () => {
      const u = req.url.replace(/token=[^&]+/, "token=…");
      fs.appendFileSync(process.env.STANDIN_LOG, `${new Date().toISOString()} ${req.method} ${u} range=${req.headers.range ?? "-"} -> ${res.statusCode} (${Date.now() - t0}ms)
`);
    });
  }
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === "OPTIONS") return send(res, 204);
    const p = decodeURIComponent(url.pathname);

    if (p === "/__debug/objects") return send(res, 200, [...meta.entries()].map(([k, v]) => ({ key: k, ...v })));
    if (p === "/__debug/stats") return send(res, 200, stats);
    if (p === "/__debug/expire-tokens" && req.method === "POST") {
      tokenEpoch++;
      return send(res, 200, { tokenEpoch });
    }
    if (p === "/health") return send(res, 200, { ok: true });

    const m = p.match(/^\/storage\/v1\/object\/(.+)$/);
    if (!m) return err(res, 404, "not_found", "Route not found");
    const rest = m[1];

    // ---- token-authorised (browser / signed) routes
    let mm;
    if ((mm = rest.match(/^upload\/sign\/(.+)$/)) && req.method === "PUT") {
      bump("signed-upload-put");
      const full = mm[1];
      const t = readToken(url.searchParams.get("token"), "up", full);
      if (!t) return err(res, 400, "InvalidJWT", "invalid signature");
      if (meta.has(full) && t.extra !== "upsert" && meta.get(full).size > 0) return err(res, 409, "Duplicate", "The resource already exists");
      const { buf, tooLarge } = await readBody(req);
      if (tooLarge) return err(res, 413, "Payload too large", "The object exceeded the maximum allowed size");
      writeObject(full, buf, req.headers["content-type"]);
      return send(res, 200, { Key: full });
    }
    if ((mm = rest.match(/^sign\/(.+)$/)) && req.method === "GET") {
      bump("signed-get");
      const full = mm[1];
      if (!readToken(url.searchParams.get("token"), "get", full)) return err(res, 400, "InvalidJWT", "invalid signature");
      const info = meta.get(full);
      if (!info) return err(res, 404, "not_found", "Object not found");
      const f = fileOf(full);
      const headers = { ...CORS, "content-type": info.mimetype, "accept-ranges": "bytes" };
      if (url.searchParams.has("download")) {
        const name = url.searchParams.get("download") || path.basename(full);
        headers["content-disposition"] = `attachment; filename="${name.replace(/"/g, "")}"`;
      }
      const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (range && info.size > 0) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = Math.min(range[2] ? Number(range[2]) : info.size - 1, info.size - 1);
        res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": end - start + 1 });
        return fs.createReadStream(f, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...headers, "content-length": info.size });
      return fs.createReadStream(f).pipe(res);
    }

    // ---- service-key routes
    if (!authed(req)) return err(res, 401, "Unauthorized", "Invalid Compact JWS");

    if ((mm = rest.match(/^list\/([^/]+)$/)) && req.method === "POST") {
      bump("list");
      const bucket = mm[1];
      const { buf } = await readBody(req, 1e6);
      const body = JSON.parse(buf.toString() || "{}");
      const prefix = `${bucket}/${String(body.prefix ?? "").replace(/^\/|\/$/g, "")}`;
      const level = new Map();
      for (const [full, info] of meta) {
        if (!full.startsWith(`${prefix}/`)) continue;
        const rel = full.slice(prefix.length + 1);
        const [first, ...more] = rel.split("/");
        if (more.length) level.set(first, { name: first, id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null });
        else level.set(first, { name: first, id: info.id, updated_at: info.updated_at, created_at: info.created_at, last_accessed_at: info.updated_at, metadata: { size: info.size, mimetype: info.mimetype } });
      }
      const sorted = [...level.values()].sort((a, b) => a.name.localeCompare(b.name));
      const offset = Number(body.offset ?? 0);
      const limit = Number(body.limit ?? 100);
      return send(res, 200, sorted.slice(offset, offset + limit));
    }
    if ((mm = rest.match(/^info\/(.+)$/)) && req.method === "GET") {
      bump("info");
      const full = mm[1];
      const info = meta.get(full);
      if (!info) return err(res, 404, "not_found", "Object not found");
      return send(res, 200, { id: info.id, name: full.split("/").slice(1).join("/"), size: info.size, content_type: info.mimetype, created_at: info.created_at, last_modified: info.updated_at, metadata: { size: info.size, mimetype: info.mimetype } });
    }
    if ((mm = rest.match(/^upload\/sign\/(.+)$/)) && req.method === "POST") {
      bump("sign-upload");
      const full = mm[1];
      const token = makeToken("up", full, 7200, req.headers["x-upsert"] === "true" ? "upsert" : "");
      return send(res, 200, { url: `/object/upload/sign/${full}?token=${token}` });
    }
    if ((mm = rest.match(/^sign\/(.+)$/)) && req.method === "POST") {
      bump("sign");
      const full = mm[1];
      if (!meta.has(full)) return err(res, 400, "not_found", "Object not found");
      const { buf } = await readBody(req, 1e6);
      const body = JSON.parse(buf.toString() || "{}");
      const token = makeToken("get", full, Math.max(1, Number(body.expiresIn ?? 60)));
      return send(res, 200, { signedURL: `/object/sign/${full}?token=${token}` });
    }
    if ((mm = rest.match(/^([^/]+)$/)) && req.method === "DELETE") {
      bump("remove");
      const bucket = mm[1];
      const { buf } = await readBody(req, 1e6);
      const body = JSON.parse(buf.toString() || "{}");
      const out = [];
      for (const k of body.prefixes ?? []) {
        const full = `${bucket}/${k}`;
        if (meta.has(full)) {
          meta.delete(full);
          fs.rmSync(fileOf(full), { force: true });
          out.push({ name: k });
        }
      }
      return send(res, 200, out);
    }
    if ((mm = rest.match(/^([^/]+)\/(.+)$/)) && (req.method === "POST" || req.method === "PUT")) {
      bump("upload");
      const full = `${mm[1]}/${mm[2]}`;
      const upsert = req.headers["x-upsert"] === "true" || req.method === "PUT";
      if (meta.has(full) && !upsert) return err(res, 409, "Duplicate", "The resource already exists");
      const { buf, tooLarge } = await readBody(req);
      if (tooLarge) return err(res, 413, "Payload too large", "The object exceeded the maximum allowed size");
      writeObject(full, buf, req.headers["content-type"]);
      return send(res, 200, { Key: full, Id: meta.get(full).id });
    }
    return err(res, 404, "not_found", "Route not found");
  } catch (e) {
    return err(res, 500, "internal", String(e?.message ?? e));
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`[storage-standin] listening on http://127.0.0.1:${PORT} (LOCAL STAND-IN, not Supabase)`));
