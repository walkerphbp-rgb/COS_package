'use strict';
/* safe_fetch.js (Step 3). SSRF-resistant fetch for user-supplied research sources.
 * Policy (all enforced here, in code):
 *  - https only, default port only, no userinfo, DNS hostname only (no IP literals), exact-hostname allowlist.
 *  - Effective allowlist = operator list AND (format source_domains when the format sets any). Neither widens the other.
 *    An empty operator list means research from user sources is DISABLED.
 *  - Every hop (initial URL and each redirect) is re-validated against the policy and re-resolved; any private/special
 *    address among the DNS answers refuses the hop. The connection is pinned to the validated address and the actual
 *    remote address is compared to it after connecting.
 *  - Redirects are followed manually (max 3). Download is bounded (maxBytes) and timed (timeoutMs, whole call).
 *  - Hashes: raw_sha256 covers the downloaded bytes (<= maxBytes); text_sha256 covers the extracted text actually given
 *    to the model (<= maxModelChars). Download truncation and model truncation are reported separately.
 *  A hash alone does not let anyone reconstruct evidence: the model-facing text is stored with it (see mission_sources). */
const net = require('node:net');
const dns = require('node:dns');
const https = require('node:https');
const crypto = require('node:crypto');

const DEFAULTS = { maxBytes: 1024 * 1024, maxRedirects: 3, timeoutMs: 15000, maxModelChars: 20000 };
const HOST_RE = /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/* ---------- address classification ---------- */
function v4ToInt(s) {
  const p = String(s).split('.'); if (p.length !== 4) return null;
  let n = 0; for (const x of p) { if (!/^(0|[1-9]\d{0,2})$/.test(x) || Number(x) > 255) return null; n = n * 256 + Number(x); }
  return n;
}
const V4_BLOCKED = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]];
function v6ToBig(str) {
  let s = String(str); if (s.includes('%')) return null;
  if (s.includes('.')) { const i = s.lastIndexOf(':'), q = v4ToInt(s.slice(i + 1)); if (q === null) return null; s = s.slice(0, i + 1) + (q >>> 16).toString(16) + ':' + (q & 0xffff).toString(16); }
  const parts = s.split('::'); if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [], tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  let g; if (parts.length === 2) { const fill = 8 - head.length - tail.length; if (fill < 1) return null; g = [...head, ...Array(fill).fill('0'), ...tail]; } else g = head;
  if (g.length !== 8) return null;
  let n = 0n; for (const x of g) { if (!/^[0-9a-f]{1,4}$/i.test(x)) return null; n = (n << 16n) | BigInt(parseInt(x, 16)); }
  return n;
}
const in6 = (n, base, len) => (n >> BigInt(128 - len)) === (base >> BigInt(128 - len));
/* true = must NOT be connected to. Unparseable input is blocked. IPv6 is allowed only inside global unicast 2000::/3 minus special ranges
 * (mapped / NAT64 / 6to4 / Teredo / documentation are all refused, conservative by design). */
function isBlockedIp(ip) {
  const f = net.isIP(ip);
  if (f === 4) { const n = v4ToInt(ip); if (n === null) return true; return V4_BLOCKED.some(([b, l]) => Math.floor(n / 2 ** (32 - l)) === Math.floor(v4ToInt(b) / 2 ** (32 - l))); }
  if (f === 6) {
    const n = v6ToBig(ip); if (n === null) return true;
    if (!in6(n, 0x2000n << 112n, 3)) return true;
    if (in6(n, 0x2001n << 112n, 23) || in6(n, 0x20010db8n << 96n, 32) || in6(n, 0x2002n << 112n, 16) || in6(n, 0x3fffn << 112n, 20)) return true;
    return false;
  }
  return true;
}

/* ---------- URL policy ---------- */
function hostPermitted(host, { operatorHosts = [], formatHosts = [] } = {}) {
  if (!Array.isArray(operatorHosts) || !operatorHosts.length) return { ok: false, code: 'RESEARCH_DISABLED' };
  if (!operatorHosts.includes(host)) return { ok: false, code: 'HOST_NOT_ALLOWED' };
  if (Array.isArray(formatHosts) && formatHosts.length && !formatHosts.includes(host)) return { ok: false, code: 'HOST_NOT_ALLOWED_BY_FORMAT' };
  return { ok: true };
}
function validateUrl(input, policy) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048 || /[\u0000-\u0020\u007f]/.test(input.trim())) return { ok: false, code: 'URL_MALFORMED' };
  let u; try { u = new URL(input.trim()); } catch { return { ok: false, code: 'URL_MALFORMED' }; }
  if (u.protocol !== 'https:') return { ok: false, code: 'URL_SCHEME' };
  if (u.username || u.password) return { ok: false, code: 'URL_USERINFO' };
  if (u.port && u.port !== '443') return { ok: false, code: 'URL_PORT' };
  const host = u.hostname.toLowerCase();
  if (net.isIP(host) || host.startsWith('[') || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return { ok: false, code: 'URL_IP_LITERAL' };
  if (host.endsWith('.') || !HOST_RE.test(host)) return { ok: false, code: 'URL_HOST_INVALID' };
  const p = hostPermitted(host, policy || {}); if (!p.ok) return p;
  u.hash = '';
  return { ok: true, url: u, host, canonical: `https://${host}${u.pathname}${u.search}` };
}

/* ---------- text extraction ---------- */
const TEXT_TYPES = /^(text\/[a-z0-9.+-]+|application\/(json|xml|[a-z0-9.+-]+\+(json|xml))|application\/x-ndjson)$/;
function extractText(contentType, buf, maxModelChars) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  let t = new TextDecoder('utf-8').decode(buf);
  if (ct === 'text/html' || ct === 'application/xhtml+xml') {
    t = t.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    t = t.replace(/\s+/g, ' ').trim();
  } else t = t.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  const full = t.length;
  const text = t.slice(0, maxModelChars);
  return { text, textChars: text.length, fullTextChars: full, modelTruncated: full > text.length, textSha256: sha256(Buffer.from(text, 'utf8')) };
}

/* ---------- default transport: one https GET to a PRE-VALIDATED address ---------- */
function httpsTransport({ url, ip, family, signal, maxBytes }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ method: 'GET', protocol: 'https:', hostname: url.hostname, port: 443, path: url.pathname + url.search, servername: url.hostname,
      headers: { host: url.hostname, 'user-agent': 'cos-research/1', accept: 'text/*, application/json, application/xml', 'accept-encoding': 'identity' },
      // The pinned lookup answers on a LATER tick, never synchronously. A synchronous answer lets net.connect() fail (e.g. EAFNOSUPPORT for an IPv6 address on a host
      // without IPv6) before tls.connect() has finished initialising the TLS socket: that surfaced as a TypeError ('setServername' of null) plus an 'error' event
      // on a half-built socket that nothing listened to, which is an uncaught exception that kills the process.
      lookup: (_h, o, cb) => setImmediate(() => (o && o.all ? cb(null, [{ address: ip, family }]) : cb(null, ip, family))), signal, agent: false }, (res) => {
      const remoteAddress = res.socket && res.socket.remoteAddress;
      const chunks = []; let total = 0, truncated = false, done = false;
      const finish = () => { if (done) return; done = true; resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), downloadTruncated: truncated, remoteAddress }); };
      res.on('data', (c) => { if (done) return; const room = maxBytes - total; if (c.length > room) { chunks.push(c.subarray(0, room)); total = maxBytes; truncated = true; finish(); res.destroy(); } else { chunks.push(c); total += c.length; } });
      res.on('end', finish); res.on('close', finish); res.on('error', (e) => { if (!done) { done = true; reject(e); } });
    });
    req.on('error', reject); req.end();
  });
}
const defaultResolver = (host) => dns.promises.lookup(host, { all: true, verbatim: true });
const sameIp = (a, b) => { const x = String(a || '').toLowerCase(), y = String(b || '').toLowerCase(); return x === y || (net.isIPv6(x) && net.isIPv6(y) && v6ToBig(x) === v6ToBig(y)); };

/* ---------- main entry ---------- */
async function safeFetch(urlStr, opts = {}) {
  const o = { ...DEFAULTS, ...opts }, resolver = o.resolver || defaultResolver, transport = o.transport || httpsTransport;
  const policy = { operatorHosts: o.operatorHosts || [], formatHosts: o.formatHosts || [] };
  const ac = new AbortController(), signal = ac.signal;
  const timer = setTimeout(() => ac.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), o.timeoutMs);   // ref'd on purpose: AbortSignal.timeout() is unref'd and lets Node exit mid-fetch
  const out = { ok: false, code: null, detail: null, requestedUrl: String(urlStr), finalUrl: null, redirects: [], status: 0, contentType: null,
    bytesDownloaded: 0, downloadTruncated: false, rawSha256: null, text: '', textChars: 0, modelTruncated: false, textSha256: null, connectedIp: null, retrievedAt: null };
  const fail = (code, detail) => { out.ok = false; out.code = code; out.detail = detail || null; out.text = ''; return out; };
  let cur = urlStr;
  try {
    for (let hop = 0; hop <= o.maxRedirects; hop++) {
      const v = validateUrl(cur, policy);
      if (!v.ok) return fail(v.code, hop ? `redirect hop ${hop}: ${String(cur).slice(0, 200)}` : null);
      let addrs; try { addrs = await resolver(v.host); } catch (e) { return fail('DNS_FAILED', e && e.code ? String(e.code) : 'resolver error'); }
      if (!Array.isArray(addrs) || !addrs.length) return fail('DNS_FAILED', 'no addresses');
      if (addrs.some((a) => !a || isBlockedIp(a.address))) return fail('DNS_PRIVATE_ADDRESS', v.host);
      const pick = addrs[0];
      const r = await transport({ url: v.url, ip: pick.address, family: net.isIP(pick.address), signal, maxBytes: o.maxBytes });
      out.connectedIp = r.remoteAddress || null;
      if (r.remoteAddress && !sameIp(r.remoteAddress, pick.address)) return fail('DEST_MISMATCH', 'connected address differs from validated address');
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers && r.headers.location; if (!loc) return fail('REDIRECT_INVALID', 'no Location header');
        if (hop === o.maxRedirects) return fail('TOO_MANY_REDIRECTS');
        let nxt; try { nxt = new URL(loc, v.url).href; } catch { return fail('REDIRECT_INVALID', 'bad Location'); }
        out.redirects.push(nxt); cur = nxt; continue;
      }
      out.finalUrl = v.canonical; out.status = r.status;
      if (!(r.status >= 200 && r.status < 300)) return fail('HTTP_STATUS', String(r.status));
      const ct = String((r.headers && r.headers['content-type']) || '').split(';')[0].trim().toLowerCase();
      out.contentType = ct || null;
      if (!TEXT_TYPES.test(ct)) return fail('CONTENT_TYPE', ct || 'missing');
      const body = Buffer.from(r.body || []); if (!body.length) return fail('EMPTY_BODY');
      out.bytesDownloaded = body.length; out.downloadTruncated = !!r.downloadTruncated; out.rawSha256 = sha256(body);
      const x = extractText(ct, body, o.maxModelChars);
      if (!x.text) return fail('EMPTY_TEXT');
      Object.assign(out, x, { ok: true, code: 'OK', retrievedAt: (o.now ? o.now() : new Date()).toISOString() });
      return out;
    }
    return fail('TOO_MANY_REDIRECTS');
  } catch (e) {
    const t = e && (e.name === 'TimeoutError' || e.name === 'AbortError' || e.code === 'ABORT_ERR');
    return fail(t ? 'TIMEOUT' : 'FETCH_ERROR', t ? `after ${o.timeoutMs}ms` : String((e && e.code) || (e && e.message) || e).slice(0, 200));
  } finally { clearTimeout(timer); }
}

module.exports = { safeFetch, validateUrl, hostPermitted, isBlockedIp, extractText, DEFAULTS, HOST_RE };
