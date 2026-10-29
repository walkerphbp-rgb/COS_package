'use strict';
// Test 33 (Step 3, source-based research). STUBBED ONLY: no network, no model. Run: node test33_research.js
const assert = require('assert');
const crypto = require('crypto');
const { safeFetch, validateUrl, isBlockedIp, extractText } = require('./safe_fetch');
const { parseResearch } = require('./research_request');

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '::', e.message.split('\n')[0]); } };
const POL = { operatorHosts: ['docs.example.com', 'cdn.example.com', 'raw.example.org'], formatHosts: [] };
const valid = (extra = {}) => ({ research: { question: 'What does the SDK provide?', sources: ['https://docs.example.com/a'], ...extra } });
const codes = (r) => (r.errors || []).map((e) => e.code);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// stub transport/resolver
const pub = [{ address: '93.184.216.34', family: 4 }];
const resolverFor = (map) => async (h) => { if (!(h in map)) { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e; } return map[h]; };
const page = (body, ct = 'text/plain', status = 200, extra = {}) => ({ status, headers: { 'content-type': ct, ...(extra.headers || {}) }, body: Buffer.from(body), downloadTruncated: !!extra.trunc, remoteAddress: extra.remote });
const seq = (...rs) => { let i = 0; const calls = []; const f = async (a) => { calls.push(a.url.href + '@' + a.ip); return rs[Math.min(i++, rs.length - 1)]; }; f.calls = calls; return f; };

(async () => {
  /* ---------- A. malformed input ---------- */
  await t('A1 research absent -> kind absent (legacy route), not an error', () => assert.strictEqual(parseResearch({ objective: 'x' }, POL).kind, 'absent'));
  for (const [n, v] of [['null', null], ['array', []], ['string', 'x'], ['number', 5]]) await t(`A2 research=${n} -> invalid, NOT absent`, () => { const r = parseResearch({ research: v }, POL); assert.strictEqual(r.kind, 'invalid'); });
  await t('A3 empty sources / missing sources -> invalid (never falls back to the seed)', () => { for (const s of [[], undefined, 'https://docs.example.com/a', {}]) { const r = parseResearch(valid({ sources: s }), POL); assert.strictEqual(r.kind, 'invalid'); assert.ok(codes(r).includes('SOURCES_REQUIRED')); } });
  await t('A4 question missing / too short / too long / not a string', () => {
    for (const q of [undefined, 'short', 'x'.repeat(1001), 42, {}]) { const b = valid(); if (q === undefined) delete b.research.question; else b.research.question = q; assert.strictEqual(parseResearch(b, POL).kind, 'invalid'); }
  });
  await t('A5 unknown research field rejected (no silent ignore)', () => { const r = parseResearch(valid({ format: 'smme_finance' }), POL); assert.strictEqual(r.kind, 'invalid'); assert.ok(codes(r).includes('UNKNOWN_FIELD')); });
  await t('A6 more than 5 sources rejected', () => { const s = Array.from({ length: 6 }, (_, i) => `https://docs.example.com/p${i}`); assert.ok(codes(parseResearch(valid({ sources: s }), POL)).includes('TOO_MANY_SOURCES')); });
  await t('A7 source shapes: number / array / extra keys / bad label rejected; {url,label} accepted', () => {
    for (const s of [5, ['https://docs.example.com/a'], { url: 'https://docs.example.com/a', extra: 1 }, { url: 'https://docs.example.com/a', label: 7 }, { label: 'x' }]) assert.strictEqual(parseResearch(valid({ sources: [s] }), POL).kind, 'invalid');
    assert.strictEqual(parseResearch(valid({ sources: [{ url: 'https://docs.example.com/a', label: 'Docs' }] }), POL).kind, 'ok');
  });
  await t('A8 control characters stripped from text fields', () => { const r = parseResearch(valid({ scope: 'a\u0000b\u0007c' }), POL); assert.strictEqual(r.research.scope, 'abc'); });
  await t('A9 body not an object -> invalid', () => { for (const b of [null, [], 'x']) assert.strictEqual(parseResearch(b, POL).kind, 'invalid'); });

  /* ---------- B. URL policy ---------- */
  const bad = {
    'http scheme': ['http://docs.example.com/a', 'URL_SCHEME'], 'file scheme': ['file:///etc/passwd', 'URL_SCHEME'], 'javascript': ['javascript:alert(1)', 'URL_SCHEME'], 'ftp': ['ftp://docs.example.com/a', 'URL_SCHEME'],
    'userinfo': ['https://user:pw@docs.example.com/a', 'URL_USERINFO'], 'userinfo trick': ['https://docs.example.com@evil.com/a', 'URL_USERINFO'], 'port 8443': ['https://docs.example.com:8443/a', 'URL_PORT'],
    'ipv4 literal': ['https://93.184.216.34/a', 'URL_IP_LITERAL'], 'ipv4 loopback': ['https://127.0.0.1/a', 'URL_IP_LITERAL'], 'ipv6 loopback': ['https://[::1]/a', 'URL_IP_LITERAL'], 'decimal ip': ['https://2130706433/a', 'URL_IP_LITERAL'],
    'hex ip': ['https://0x7f000001/a', 'URL_IP_LITERAL'], 'metadata ip': ['https://169.254.169.254/latest', 'URL_IP_LITERAL'], 'localhost': ['https://localhost/a', 'URL_HOST_INVALID'], 'single label': ['https://intranet/a', 'URL_HOST_INVALID'],
    'not allowlisted': ['https://evil.com/a', 'HOST_NOT_ALLOWED'], 'subdomain not allowed': ['https://x.docs.example.com/a', 'HOST_NOT_ALLOWED'], 'parent not allowed': ['https://example.com/a', 'HOST_NOT_ALLOWED'],
    'lookalike suffix': ['https://docs.example.com.evil.com/a', 'HOST_NOT_ALLOWED'], 'whitespace': ['https://docs.example.com/a b', 'URL_MALFORMED'], 'empty': ['', 'URL_MALFORMED'], 'garbage': ['not a url', 'URL_MALFORMED'], 'newline': ['https://docs.example.com/a\nHost: evil', 'URL_MALFORMED'],
  };
  for (const [n, [u, c]] of Object.entries(bad)) await t(`B1 refuse ${n} -> ${c}`, () => { const v = validateUrl(u, POL); assert.strictEqual(v.ok, false); assert.strictEqual(v.code, c); });
  await t('B2 user-source research DISABLED by default (empty operator list)', () => { assert.strictEqual(validateUrl('https://docs.example.com/a', { operatorHosts: [] }).code, 'RESEARCH_DISABLED'); assert.strictEqual(validateUrl('https://docs.example.com/a', {}).code, 'RESEARCH_DISABLED'); assert.strictEqual(validateUrl('https://docs.example.com/a').code, 'RESEARCH_DISABLED'); });
  await t('B3 case-insensitive host, fragment dropped, canonical form', () => { const v = validateUrl('https://DOCS.Example.COM/A?x=1#frag', POL); assert.ok(v.ok); assert.strictEqual(v.canonical, 'https://docs.example.com/A?x=1'); });
  await t('B4 trailing-dot host refused', () => assert.strictEqual(validateUrl('https://docs.example.com./a', POL).ok, false));
  await t('B5 blocked address classes', () => {
    for (const ip of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '2001::1', 'garbage', ''])
      assert.strictEqual(isBlockedIp(ip), true, ip);
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946', '2a00:1450:4001:81b::200e']) assert.strictEqual(isBlockedIp(ip), false, ip);
  });
  await t('B6 invalid source URL inside a request makes the whole request invalid, with the field named', () => { const r = parseResearch(valid({ sources: ['https://docs.example.com/a', 'https://evil.com/x'] }), POL); assert.strictEqual(r.kind, 'invalid'); assert.strictEqual(r.errors[0].field, 'research.sources[1]'); });

  /* ---------- C. duplicate sources ---------- */
  await t('C1 duplicate URLs (case, fragment) collapse deterministically; first wins; ids S1..Sn', () => {
    const r = parseResearch(valid({ sources: ['https://docs.example.com/a', 'https://cdn.example.com/b', 'https://DOCS.example.com/a#x', 'https://cdn.example.com/b'] }), POL);
    assert.strictEqual(r.kind, 'ok'); assert.deepStrictEqual(r.research.sources.map((s) => s.source_id), ['S1', 'S2']); assert.deepStrictEqual(r.duplicates, [{ index: 2, duplicate_of: 'S1' }, { index: 3, duplicate_of: 'S2' }]);
  });
  await t('C2 same input twice gives identical ids and order (deterministic)', () => { const b = valid({ sources: ['https://cdn.example.com/b', 'https://docs.example.com/a', 'https://cdn.example.com/b'] }); assert.deepStrictEqual(parseResearch(b, POL), parseResearch(JSON.parse(JSON.stringify(b)), POL)); });
  await t('C3 different query strings are different sources', () => { const r = parseResearch(valid({ sources: ['https://docs.example.com/a?v=1', 'https://docs.example.com/a?v=2'] }), POL); assert.strictEqual(r.research.sources.length, 2); });

  /* ---------- D. fetch behaviour (stub transport + resolver) ---------- */
  const R = resolverFor({ 'docs.example.com': pub, 'cdn.example.com': pub, 'raw.example.org': pub });
  await t('D1 happy path: text, hashes, timestamp, connection pinned to the validated address', async () => {
    const tr = seq(page('Hello source text.\r\nSecond line.', 'text/plain; charset=utf-8', 200, { remote: '93.184.216.34' }));
    const r = await safeFetch('https://docs.example.com/a', { ...POL, resolver: R, transport: tr, now: () => new Date('2026-10-25T00:00:00Z') });
    assert.ok(r.ok); assert.strictEqual(r.rawSha256, sha('Hello source text.\r\nSecond line.')); assert.strictEqual(r.text, 'Hello source text.\nSecond line.'); assert.strictEqual(r.textSha256, sha(r.text));
    assert.strictEqual(r.retrievedAt, '2026-10-25T00:00:00.000Z'); assert.deepStrictEqual(tr.calls, ['https://docs.example.com/a@93.184.216.34']);
  });
  await t('D2 DNS answer containing ANY private address refuses (rebinding mix)', async () => { for (const ans of [[{ address: '127.0.0.1' }], [{ address: '93.184.216.34' }, { address: '10.0.0.5' }], [{ address: '::1' }], [{ address: '169.254.169.254' }]]) { const tr = seq(page('x')); const r = await safeFetch('https://docs.example.com/a', { ...POL, resolver: resolverFor({ 'docs.example.com': ans }), transport: tr }); assert.strictEqual(r.code, 'DNS_PRIVATE_ADDRESS'); assert.strictEqual(tr.calls.length, 0); } });
  await t('D3 DNS failure / empty answer -> DNS_FAILED, no transport call', async () => { const tr = seq(page('x')); assert.strictEqual((await safeFetch('https://docs.example.com/a', { ...POL, resolver: resolverFor({}), transport: tr })).code, 'DNS_FAILED'); assert.strictEqual((await safeFetch('https://docs.example.com/a', { ...POL, resolver: resolverFor({ 'docs.example.com': [] }), transport: tr })).code, 'DNS_FAILED'); assert.strictEqual(tr.calls.length, 0); });
  await t('D4 actual connected address differs from the validated one -> DEST_MISMATCH', async () => { const r = await safeFetch('https://docs.example.com/a', { ...POL, resolver: R, transport: seq(page('x', 'text/plain', 200, { remote: '127.0.0.1' })) }); assert.strictEqual(r.code, 'DEST_MISMATCH'); assert.strictEqual(r.text, ''); });
  await t('D5 redirect to an allowlisted host is followed and re-validated; final URL recorded', async () => {
    const tr = seq(page('', 'text/plain', 302, { headers: { location: 'https://cdn.example.com/final' } }), page('final text body'));
    const r = await safeFetch('https://docs.example.com/a', { ...POL, resolver: R, transport: tr }); assert.ok(r.ok); assert.strictEqual(r.finalUrl, 'https://cdn.example.com/final'); assert.deepStrictEqual(r.redirects, ['https://cdn.example.com/final']);
  });
  await t('D6 redirect to a non-allowlisted host / http / private literal / userinfo is refused at that hop', async () => {
    for (const [loc, code] of [['https://evil.com/x', 'HOST_NOT_ALLOWED'], ['http://docs.example.com/x', 'URL_SCHEME'], ['https://127.0.0.1/x', 'URL_IP_LITERAL'], ['https://169.254.169.254/latest', 'URL_IP_LITERAL'], ['https://u:p@cdn.example.com/x', 'URL_USERINFO'], ['file:///etc/passwd', 'URL_SCHEME']]) {
      const tr = seq(page('', 'text/plain', 302, { headers: { location: loc } }), page('SHOULD NOT BE FETCHED')); const r = await safeFetch('https://docs.example.com/a', { ...POL, resolver: R, transport: tr });
      assert.strictEqual(r.ok, false); assert.strictEqual(r.code, code, loc); assert.strictEqual(tr.calls.length, 1, 'second hop must not be requested');
    }
  });
  await t('D7 redirect whose host resolves to a private address is refused (DNS re-checked per hop)', async () => { const tr = seq(page('', 'text/plain', 301, { headers: { location: 'https://cdn.example.com/x' } }), page('no')); const r = await safeFetch('https://docs.example.com/a', { ...POL, resolver: resolverFor({ 'docs.example.com': pub, 'cdn.example.com': [{ address: '10.0.0.9' }] }), transport: tr }); assert.strictEqual(r.code, 'DNS_PRIVATE_ADDRESS'); assert.strictEqual(tr.calls.length, 1); });
  await t('D8 redirect loop / too many redirects / missing Location', async () => {
    const loop = page('', 'text/plain', 302, { headers: { location: 'https://docs.example.com/a' } }); assert.strictEqual((await safeFetch('https://docs.example.com/a', { ...POL, resolver: R, transport: seq(loop) })).code, 'TOO_MANY_REDIRECTS');
    assert.strictEqual((await safeFetch('https://docs.example.com/a', { ...POL, resolver: R, transport: seq(page('', 'text/plain', 302)) })).code, 'REDIRECT_INVALID');
  });
  await t('D9 non-2xx, empty body, binary content type refused; none yield text', async () => {
    for (const [p, c] of [[page('nf', 'text/plain', 404), 'HTTP_STATUS'], [page('', 'text/plain', 200), 'EMPTY_BODY'], [page('%PDF', 'application/pdf'), 'CONTENT_TYPE'], [page('x', 'image/png'), 'CONTENT_TYPE'], [{ status: 200, headers: {}, body: Buffer.from('x') }, 'CONTENT_TYPE']]) {
      const r = await safeFetch('https://docs.example.com/a', { ...POL, resolver: R, transport: seq(p) }); assert.strictEqual(r.ok, false); assert.strictEqual(r.code, c); assert.strictEqual(r.text, '');
    }
  });
  await t('D10 download truncation and model truncation are reported separately', async () => {
    const big = 'word '.repeat(100);
    const a = await safeFetch('https://docs.example.com/a', { ...POL, resolver: R, transport: seq(page(big, 'text/plain', 200, { trunc: true })), maxModelChars: 1000 }); assert.ok(a.ok); assert.strictEqual(a.downloadTruncated, true); assert.strictEqual(a.modelTruncated, false);
    const b = await safeFetch('https://docs.example.com/a', { ...POL, resolver: R, transport: seq(page(big)), maxModelChars: 50 }); assert.strictEqual(b.downloadTruncated, false); assert.strictEqual(b.modelTruncated, true); assert.strictEqual(b.text.length, 50); assert.strictEqual(b.textSha256, sha(b.text)); assert.strictEqual(b.rawSha256, sha(big));
  });
  await t('D11 hash scopes: rawSha256 covers downloaded bytes, textSha256 covers the text given to the model (differ for HTML)', async () => {
    const html = '<html><head><script>evil()</script><style>x{}</style></head><body><h1>Title</h1><p>Body &amp; more</p><!-- hidden --></body></html>';
    const r = await safeFetch('https://docs.example.com/a', { ...POL, resolver: R, transport: seq(page(html, 'text/html; charset=utf-8')) });
    assert.strictEqual(r.rawSha256, sha(html)); assert.strictEqual(r.text, 'Title Body & more'); assert.strictEqual(r.textSha256, sha('Title Body & more')); assert.notStrictEqual(r.rawSha256, r.textSha256); assert.ok(!/evil|hidden/.test(r.text));
  });
  await t('D12 transport throwing / timing out maps to FETCH_ERROR / TIMEOUT; never throws', async () => {
    assert.strictEqual((await safeFetch('https://docs.example.com/a', { ...POL, resolver: R, transport: async () => { throw Object.assign(new Error('boom'), { code: 'ECONNRESET' }); } })).code, 'FETCH_ERROR');
    const hang = ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'TimeoutError' }))));
    assert.strictEqual((await safeFetch('https://docs.example.com/a', { ...POL, resolver: R, transport: hang, timeoutMs: 40 })).code, 'TIMEOUT');
  });
  await t('D13 policy not satisfied -> transport and resolver never called', async () => { let n = 0; const r = await safeFetch('https://evil.com/a', { ...POL, resolver: async () => { n++; return pub; }, transport: async () => { n++; return page('x'); } }); assert.strictEqual(r.code, 'HOST_NOT_ALLOWED'); assert.strictEqual(n, 0); });

  console.log(`\nTEST33-PART1 (A-D) result=${fail ? 'FAIL' : 'PASS'} passed=${pass} failed=${fail}`);
  process.exit(fail ? 1 : 0);
})();
