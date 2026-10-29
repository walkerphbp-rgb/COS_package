'use strict';
/* Test 33 LIVE-FETCH: exercises the REAL safe_fetch transport (real DNS, real TLS, real redirects, real connected-address check)
 * against public GitHub hosts. NO model is called. This needs outbound network, so it is NOT part of npm test or CI.
 * Run: node test33_live_fetch.js        Result lines: PASS / FAIL / INCONCLUSIVE (network unreachable). */
const crypto = require('crypto'), dns = require('dns');
const SF = require('./safe_fetch');
let pass = 0, fail = 0, inc = 0;
const rec = (st, id, d) => { st === 'PASS' ? pass++ : st === 'FAIL' ? fail++ : inc++; console.log(`${st}  ${id}${d ? '  -> ' + String(d).slice(0, 240) : ''}`); };
const check = (id, ok, d) => rec(ok ? 'PASS' : 'FAIL', id, ok ? '' : d);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const RAW = 'https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/README.md';
const VIA = 'https://github.com/anthropics/anthropic-sdk-typescript/raw/main/README.md';
(async () => {
  // Reachability gate: if the direct fetch cannot even reach the network, results are INCONCLUSIVE, never a pass.
  const a = await SF.safeFetch(RAW, { operatorHosts: ['raw.githubusercontent.com'] });
  if (!a.ok && ['DNS_FAILED', 'FETCH_ERROR', 'TIMEOUT'].includes(a.code)) { rec('INCONCLUSIVE', 'network not reachable from here', `${a.code} ${a.detail}`); return done(); }
  check('L1 real fetch of a raw file succeeds (https, real TLS, real DNS)', a.ok && a.status === 200 && /^text\//.test(a.contentType || '') && a.textChars > 500, JSON.stringify({ code: a.code, d: a.detail, s: a.status, ct: a.contentType }));
  // L2 independent check: raw hash equals the SHA-256 of the bytes fetched by a second, unrelated client
  const ref = Buffer.from(await (await fetch(RAW, { headers: { 'accept-encoding': 'identity' } })).arrayBuffer());
  check('L2 rawSha256 equals the hash of the same bytes fetched independently', !a.downloadTruncated && a.rawSha256 === sha(ref) && a.bytesDownloaded === ref.length, `${a.bytesDownloaded} vs ${ref.length}`);
  // L3 connected address is a real public address that the resolver itself returned for that host
  const ips = (await dns.promises.lookup('raw.githubusercontent.com', { all: true })).map((x) => x.address);
  check('L3 connectedIp is public and one of the resolver answers', !!a.connectedIp && !SF.isBlockedIp(a.connectedIp) && ips.includes(a.connectedIp), `${a.connectedIp} in ${ips}`);
  // L4 real cross-host redirect followed when BOTH hosts are allowed
  const b = await SF.safeFetch(VIA, { operatorHosts: ['github.com', 'raw.githubusercontent.com'] });
  check('L4 github.com -> raw.githubusercontent.com redirect is followed, final URL on the second host', b.ok && b.redirects.length >= 1 && /^https:\/\/raw\.githubusercontent\.com\//.test(b.finalUrl || '') && b.rawSha256 === a.rawSha256, JSON.stringify({ code: b.code, d: b.detail, r: b.redirects, f: b.finalUrl }));
  // L5 same redirect REFUSED when the target host is not allowed (allowlist re-checked on the real hop)
  const c = await SF.safeFetch(VIA, { operatorHosts: ['github.com'] });
  check('L5 redirect to a host outside the allowlist is refused and no text is returned', !c.ok && c.text === '' && c.redirects.length >= 1 && /redirect hop 1/.test(c.detail || ''), JSON.stringify({ code: c.code, d: c.detail }));
  // L6 format hosts narrow the operator list (intersection) on the real hop too
  const d = await SF.safeFetch(VIA, { operatorHosts: ['github.com', 'raw.githubusercontent.com'], formatHosts: ['github.com'] });
  check('L6 format source_domains narrow the operator list: redirect target refused', !d.ok && d.text === '', JSON.stringify({ code: d.code, d: d.detail }));
  // L7 host not allowed at all: refused before any connection
  const e = await SF.safeFetch('https://example.com/', { operatorHosts: ['github.com'] });
  check('L7 a non-allowlisted host is refused without connecting', !e.ok && e.connectedIp === null, JSON.stringify({ code: e.code, ip: e.connectedIp }));
  // L8 HTTP error status
  const f = await SF.safeFetch('https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/NO_SUCH_FILE_COS_TEST.md', { operatorHosts: ['raw.githubusercontent.com'] });
  check('L8 a real 404 is refused with HTTP_STATUS and no text', !f.ok && f.code === 'HTTP_STATUS' && f.text === '', JSON.stringify({ code: f.code, d: f.detail }));
  // L9 download bound: real server, tiny maxBytes
  const g = await SF.safeFetch(RAW, { operatorHosts: ['raw.githubusercontent.com'], maxBytes: 2000 });
  check('L9 download is cut at maxBytes and flagged truncated', g.ok && g.bytesDownloaded === 2000 && g.downloadTruncated === true, JSON.stringify({ ok: g.ok, b: g.bytesDownloaded, t: g.downloadTruncated, c: g.code }));
  // L10 model-context bound is reported separately from the download bound
  const h = await SF.safeFetch(RAW, { operatorHosts: ['raw.githubusercontent.com'], maxModelChars: 300 });
  check('L10 model-text cut at maxModelChars is flagged separately from download truncation', h.ok && h.textChars <= 300 && h.modelTruncated === true && h.downloadTruncated === false, JSON.stringify({ n: h.textChars, m: h.modelTruncated, d: h.downloadTruncated }));
  // L11 whole-call timeout on the real transport
  const t0 = Date.now(), i = await SF.safeFetch(RAW, { operatorHosts: ['raw.githubusercontent.com'], timeoutMs: 1 });
  check('L11 a 1 ms timeout aborts the real request with TIMEOUT', !i.ok && i.code === 'TIMEOUT' && Date.now() - t0 < 3000, JSON.stringify({ code: i.code, ms: Date.now() - t0 }));
  done();
})().catch((e) => { console.log('FAIL  unexpected error', e && e.stack); process.exitCode = 1; });
function done() { console.log(`\nTEST33-LIVE-FETCH (real transport, public GitHub hosts, NO model) result=${fail ? 'FAIL' : inc ? 'INCONCLUSIVE' : 'PASS'} passed=${pass} failed=${fail} inconclusive=${inc}`); if (fail) process.exitCode = 1; }
