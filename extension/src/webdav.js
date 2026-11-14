// Minimal WebDAV client. Every failure carries a plain sentence for the status panel.
export class PlainError extends Error {
  constructor(plain, code) { super(plain); this.plain = plain; this.code = code || "error"; }
}

export class WebDav {
  constructor({ baseUrl, user, pass, fetchImpl }) {
    this.base = String(baseUrl || "").replace(/\/+$/, "");
    this.auth = "Basic " + btoa(unescape(encodeURIComponent(`${user}:${pass}`)));
    this.fetch = fetchImpl || ((...a) => fetch(...a));
  }
  url(path) { return this.base + "/" + String(path).split("/").filter(Boolean).map(encodeURIComponent).join("/"); }
  async req(method, path, opts = {}) {
    let res;
    try {
      res = await this.fetch(this.url(path), { method, headers: { Authorization: this.auth, ...(opts.headers || {}) }, body: opts.body });
    } catch {
      throw new PlainError("Could not reach the WebDAV storage. Check the connection; changes stay saved on this machine until it returns.", "unreachable");
    }
    if (res.status === 401 || res.status === 403) throw new PlainError("The WebDAV storage refused the username or app password. Create a new app password in Fastmail and enter it in Settings.", "auth");
    return res;
  }
  async get(path) {
    const r = await this.req("GET", path);
    if (r.status === 404) return null;
    if (!r.ok) throw new PlainError(`The WebDAV storage answered with an unexpected reply while reading ${path}.`, "bad-reply");
    return await r.text();
  }
  async put(path, text) {
    const r = await this.req("PUT", path, { body: text, headers: { "Content-Type": "application/octet-stream" } });
    if (!r.ok && r.status !== 201 && r.status !== 204) throw new PlainError(`The WebDAV storage did not accept the file ${path}.`, "bad-reply");
  }
  async mkcol(path) {
    const r = await this.req("MKCOL", path);
    if (!r.ok && r.status !== 405 && r.status !== 301) throw new PlainError(`Could not create the folder ${path} on the WebDAV storage.`, "bad-reply");
  }
  async mkdirs(path) {
    let cur = "";
    for (const part of String(path).split("/").filter(Boolean)) { cur += (cur ? "/" : "") + part; await this.mkcol(cur); }
  }
  async list(path) {
    const r = await this.req("PROPFIND", path, { headers: { Depth: "1", "Content-Type": "application/xml" }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>' });
    if (r.status === 404) return [];
    if (!r.ok && r.status !== 207) throw new PlainError(`Could not list ${path} on the WebDAV storage.`, "bad-reply");
    const xml = await r.text();
    const names = []; const re = /<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/gi; let m;
    const selfPath = decodeURIComponent(new URL(this.url(path)).pathname).replace(/\/+$/, "");
    while ((m = re.exec(xml))) {
      let p;
      try { p = decodeURIComponent(new URL(m[1], this.base + "/").pathname).replace(/\/+$/, ""); } catch { continue; }
      if (!p || p === selfPath) continue;
      const name = p.split("/").pop(); if (name === "." || name === "..") continue;
      names.push(name);
    }
    return [...new Set(names)];
  }
}
