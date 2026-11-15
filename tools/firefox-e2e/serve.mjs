// Local stand-ins for Miniflux and the Fastmail WebDAV store, served over plain HTTP so a real Firefox can talk to them.
// They are the same fakes the unit tests use. Synthetic data only.   node tools/firefox-e2e/serve.mjs [port]
import http from "node:http";
import { world } from "../../test/helpers.mjs";

const port = Number(process.argv[2] || 8799);
const w = await world();
const hit = { mf: 0, dav: 0, log: [] };
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks).toString();
  const u = new URL(req.url, `http://127.0.0.1:${port}`);
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (u.pathname === "/ctl/blank") { res.writeHead(200, { ...cors, "content-type": "text/html" }); return res.end("<!doctype html><title>launcher</title><a id=go>go</a>"); }
  if (u.pathname === "/ctl/hits") { res.writeHead(200, { ...cors, "content-type": "application/json" }); return res.end(JSON.stringify({ mf: hit.mf, dav: hit.dav, tail: hit.log.slice(-30) })); }
  if (u.pathname === "/ctl/reset") { hit.mf = 0; hit.dav = 0; hit.log = []; res.writeHead(204, cors); return res.end(); }
  const m = u.pathname.match(/^\/(mf|dav)(\/.*)?$/);
  if (!m) { res.writeHead(404, cors); return res.end("not found"); }
  hit[m[1]]++; hit.log.push(`${req.method} ${u.pathname}`);
  const target = new URL(m[2] || "/", m[1] === "mf" ? "https://mf.test" : "https://dav.test"); target.search = u.search;
  const headers = {}; for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase() === "x-auth-token" ? "X-Auth-Token" : k] = v;
  const r = await (m[1] === "mf" ? w.mf.handler : w.dav.handler)(target.toString(), { method: req.method, headers, body: body || undefined });
  let text = await r.text(); if (m[1] === "dav") text = text.replaceAll("<d:href>/", "<d:href>/dav/"); // a real server answers with paths under its own base
  res.writeHead(r.status, { ...cors, "content-type": r.headers.get("content-type") || "application/json" }); res.end(text);
});
server.listen(port, "127.0.0.1", () => console.log(`fake services on http://127.0.0.1:${port}  (/mf = Miniflux, key good-key; /dav = WebDAV, user u, password p)`));
