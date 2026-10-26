'use strict';
/* Test 33 NET-HARDENING (manual, NOT in npm test / CI): proves, at socket level, that safe_fetch never connects to an unapproved address.
 * How "never connects" is observed: net.Socket.prototype.connect and dns.lookup are instrumented in this process, so EVERY connection attempt
 * (target host/port, the address the pinned lookup handed back) and every established connection (remoteAddress) is recorded; a canary TCP
 * listener on 127.0.0.1:443 additionally counts any connection that actually arrives there.
 * Needs: root (to bind 127.0.0.1:443 and for the canary), openssl (local TLS-error servers), outbound network for the [NET] parts.
 * Parts marked [NET] report INCONCLUSIVE (never PASS) when the network or IPv6 is not available.
 * Run: node test33_net_hardening.js */
const net = require('node:net'), dns = require('node:dns'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module'), { execFileSync, spawnSync } = require('node:child_process');
const SF = require('./safe_fetch');

/* ---------- load the REAL httpsTransport (not exported): same source file, plus one export line, compiled as a module ---------- */
function loadTransport() {
  const file = path.join(__dirname, 'safe_fetch.js');
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(__dirname);
  m._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.__httpsTransport = httpsTransport;\n', file);
  return m.exports.__httpsTransport;
}

/* ---------- TLS child mode: one scenario per process, so trust (NODE_EXTRA_CA_CERTS) is per scenario ---------- */
if (process.argv[2] === '--tls-child') {
  const [, , , dir, which] = process.argv; const https = require('node:https');
  const kc = { selfsigned: ['self.key', 'self.pem'], untrustedca: ['good.key', 'good.pem'], expired: ['expired.key', 'expired.pem'], wronghost: ['wrong.key', 'wrong.pem'], control: ['good.key', 'good.pem'] }[which];
  let requests = 0;
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, kc[0])), cert: fs.readFileSync(path.join(dir, kc[1])) }, (req, res) => { requests++; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
  srv.listen(443, '127.0.0.1', async () => {
    const t = loadTransport(); let r = null, e = null;
    try { r = await t({ url: new URL('https://tls-test.example/'), ip: '127.0.0.1', family: 4, signal: new AbortController().signal, maxBytes: 1000 }); } catch (x) { e = x; }
    console.log(JSON.stringify({ ok: !!r, status: r && r.status, body: r && r.body.toString(), remote: r && r.remoteAddress, errCode: e && e.code, requests }));
    srv.close(); setTimeout(() => process.exit(0), 50);
  });
  return;
}

let pass = 0, fail = 0, inc = 0;
const uncaught = []; process.on('uncaughtException', (e) => { uncaught.push((e && (e.code || e.message)) || String(e)); });
const rec = (st, id, d) => { st === 'PASS' ? pass++ : st === 'FAIL' ? fail++ : inc++; console.log(`${st}  ${id}${d ? '  -> ' + String(d).slice(0, 300) : ''}`); };
const check = (id, ok, d) => rec(ok ? 'PASS' : 'FAIL', id, ok ? '' : d);

/* ---------- socket-level instrumentation ---------- */
const ev = { attempts: [], remotes: [], dnsLookups: 0, canary: 0 };
const resetEv = () => { ev.attempts.length = 0; ev.remotes.length = 0; ev.dnsLookups = 0; ev.canary = 0; };
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = args[0];
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    const r = { host: o.host, port: o.port, pinned: null };
    if (typeof o.lookup === 'function') { const ol = o.lookup; args[0] = { ...o, lookup: (h, opts, cb) => ol(h, opts, (err, a, f) => { r.pinned = err ? null : (Array.isArray(a) ? a.map((x) => x.address) : [a]); cb(err, a, f); }) }; }
    ev.attempts.push(r);
  } else ev.attempts.push({ host: args[1], port: args[0], pinned: null });
  this.once('connect', () => ev.remotes.push(this.remoteAddress));
  return origConnect.apply(this, args);
};
const origLookup = dns.lookup; dns.lookup = function (...a) { ev.dnsLookups++; return origLookup.apply(this, a); };
const noConn = () => ev.attempts.length === 0 && ev.remotes.length === 0 && ev.canary === 0;

const mkResolver = (f) => { const calls = []; const fn = async (h) => { calls.push(h); return f(calls.length, h); }; fn.calls = calls; return fn; };
const mkTransport = (script) => { const calls = []; const fn = async (a) => { calls.push({ host: a.url.hostname, path: a.url.pathname, ip: a.ip, family: a.family }); const r = script(calls.length, a); return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('hello world'), downloadTruncated: false, remoteAddress: a.ip, ...r }; }; fn.calls = calls; return fn; };
const pub = (ip) => [{ address: ip, family: ip.includes(':') ? 6 : 4 }];
const OP = { operatorHosts: ['a.example.org', 'b.example.org', 'raw.githubusercontent.com', 'github.com', 'example.org'] };
const refused = (r, code) => !r.ok && r.code === code && r.text === '' && r.textSha256 === null;

(async () => {
  const canarySrv = net.createServer((c) => { ev.canary++; c.destroy(); }); let canaryUp = true;
  await new Promise((res) => { canarySrv.once('error', () => { canaryUp = false; res(); }); canarySrv.listen(443, '127.0.0.1', res); });
  if (!canaryUp) rec('INCONCLUSIVE', 'canary listener on 127.0.0.1:443 could not bind (need root); socket instrumentation still active');
  let GH = ['185.199.109.133'], net_ok = false;
  try { const r = await dns.promises.lookup('raw.githubusercontent.com', { all: true, verbatim: true }); GH = r.filter((x) => x.family === 4).map((x) => x.address); net_ok = GH.length > 0; } catch { /* offline */ }
  const PUB = GH[0];

  /* ===== A. private / special answers: the REAL transport must never be called ===== */
  const PRIV4 = ['127.0.0.1', '127.255.255.254', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '198.18.0.1', '192.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255'];
  const PRIV6 = ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::1', '2001::1', '2001:db8::1', '100::1', '3fff::1', '0:0:0:0:0:0:0:1'];
  let bad = [];
  for (const ip of [...PRIV4, ...PRIV6]) { resetEv(); const rs = mkResolver(() => pub(ip)); const r = await SF.safeFetch('https://raw.githubusercontent.com/x', { ...OP, resolver: rs }); if (!(refused(r, 'DNS_PRIVATE_ADDRESS') && noConn() && rs.calls.length === 1)) bad.push(`${ip}:${r.code}/att=${ev.attempts.length}/can=${ev.canary}`); }
  check(`A1 ${PRIV4.length + PRIV6.length} private/special/mapped/NAT64/6to4/Teredo answers: refused, NO connection attempt, canary untouched`, bad.length === 0, bad.join(' '));

  /* ===== B. mixed public + private answers: the whole answer set is refused, even the public member is never connected ===== */
  const MIX = { 'B1 [public, private v4]': [PUB, '10.0.0.5'], 'B2 [private v4, public]': ['127.0.0.1', PUB], 'B3 [public, public, ::1]': [PUB, '8.8.8.8', '::1'], 'B4 [public v6, private v4]': ['2606:4700:4700::1111', '192.168.0.1'], 'B5 [public, metadata 169.254.169.254]': [PUB, '169.254.169.254'], 'B6 [public, ::ffff:127.0.0.1]': [PUB, '::ffff:127.0.0.1'] };
  for (const [id, ips] of Object.entries(MIX)) { resetEv(); const r = await SF.safeFetch('https://raw.githubusercontent.com/x', { ...OP, resolver: mkResolver(() => ips.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }))) }); check(`${id}: refused as a whole, public member NOT connected either`, refused(r, 'DNS_PRIVATE_ADDRESS') && noConn(), `${r.code} att=${ev.attempts.length}`); }

  /* ===== C. malformed / hostile answers ===== */
  const WEIRD = ['localhost', '2130706433', '127.1', '0x7f.0.0.1', '010.0.0.1', '127.0.0.1.', 'fe80::1%eth0', '', ' 127.0.0.1', '8.8.8.8\n127.0.0.1', '999.1.1.1', '::ffff:999.1.1.1'];
  bad = [];
  for (const w of WEIRD) { resetEv(); const r = await SF.safeFetch('https://raw.githubusercontent.com/x', { ...OP, resolver: mkResolver(() => [{ address: w, family: 4 }]) }); if (!(refused(r, 'DNS_PRIVATE_ADDRESS') && noConn())) bad.push(`${JSON.stringify(w)}:${r.code}`); }
  { resetEv(); const r = await SF.safeFetch('https://raw.githubusercontent.com/x', { ...OP, resolver: mkResolver(() => [null]) }); if (!(refused(r, 'DNS_PRIVATE_ADDRESS') && noConn())) bad.push('null entry:' + r.code); }
  check(`C1 ${WEIRD.length + 1} unparseable/ambiguous address spellings are treated as private (fail closed), never connected`, bad.length === 0, bad.join(' '));
  for (const [id, f, code] of [['C2 empty answer', () => [], 'DNS_FAILED'], ['C3 resolver throws', () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); }, 'DNS_FAILED'], ['C4 non-array answer', () => ({ address: '8.8.8.8' }), 'DNS_FAILED']]) { resetEv(); const r = await SF.safeFetch('https://raw.githubusercontent.com/x', { ...OP, resolver: mkResolver(f) }); check(`${id} -> ${code}, no connection`, refused(r, code) && noConn(), r.code); }

  /* ===== D. IPv6 classification ===== */
  const V6OK = ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '2001:4860:4860::8888', '2620:fe::fe', '2001:200::1'];
  const V6NO = [...PRIV6, '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '2001:1ff::1', '2001:10::1', '2001:0:0:0:0:0:0:1', 'zz::1', '2606:4700:4700::1111%eth0'];
  check(`D1 public global-unicast IPv6 (${V6OK.length} samples) is allowed`, V6OK.every((a) => SF.isBlockedIp(a) === false), V6OK.filter((a) => SF.isBlockedIp(a)).join(' '));
  check(`D2 loopback/link-local/ULA/multicast/mapped/NAT64/6to4/Teredo/ORCHID/documentation/zoned/garbage IPv6 (${V6NO.length} samples) is blocked`, V6NO.every((a) => SF.isBlockedIp(a) === true), V6NO.filter((a) => !SF.isBlockedIp(a)).join(' '));

  /* ===== E. pinning and connected-address comparison (stub transport, records what it is told to connect to) ===== */
  { const t = mkTransport(() => ({})); const r = await SF.safeFetch('https://raw.githubusercontent.com/x', { ...OP, resolver: mkResolver(() => pub('2606:4700:4700::1111')), transport: t });
    check('E1 an IPv6 answer is pinned as-is (address and family 6) and nothing else is connected', r.ok && t.calls.length === 1 && t.calls[0].ip === '2606:4700:4700::1111' && t.calls[0].family === 6, JSON.stringify(t.calls)); }
  { const t = mkTransport((n, a) => ({ remoteAddress: '2606:4700:4700:0:0:0:0:1111' })); const r = await SF.safeFetch('https://raw.githubusercontent.com/x', { ...OP, resolver: mkResolver(() => pub('2606:4700:4700::1111')), transport: t });
    check('E2 the same IPv6 address in expanded spelling is NOT a mismatch', r.ok, r.code); }
  { const t = mkTransport(() => ({ remoteAddress: '2606:4700:4700::1001' })); const r = await SF.safeFetch('https://raw.githubusercontent.com/x', { ...OP, resolver: mkResolver(() => pub('2606:4700:4700::1111')), transport: t });
    check('E3 connected to a DIFFERENT IPv6 address than validated: DEST_MISMATCH, no text, connectedIp reported', refused(r, 'DEST_MISMATCH') && r.connectedIp === '2606:4700:4700::1001', r.code); }
  { const t = mkTransport(() => ({ remoteAddress: '127.0.0.1' })); const r = await SF.safeFetch('https://raw.githubusercontent.com/x', { ...OP, resolver: mkResolver(() => pub(PUB)), transport: t });
    check('E4 connected to loopback although a public address was validated: DEST_MISMATCH, no text', refused(r, 'DEST_MISMATCH'), r.code); }
  { const t = mkTransport(() => ({ remoteAddress: '::ffff:' + PUB })); const r = await SF.safeFetch('https://raw.githubusercontent.com/x', { ...OP, resolver: mkResolver(() => pub(PUB)), transport: t });
    check('E5 IPv4-mapped spelling of the validated address is refused (conservative: fail closed)', refused(r, 'DEST_MISMATCH'), r.code); }
  let v6res = null;
  { resetEv(); const r = await SF.safeFetch('https://raw.githubusercontent.com/x', { ...OP, resolver: mkResolver(() => pub('2606:4700:4700::1111')), timeoutMs: 4000 }); v6res = r;
    const pinnedOk = ev.attempts.every((a) => a.port === 443 && (a.pinned === null || (a.pinned.length === 1 && a.pinned[0] === '2606:4700:4700::1111'))) && ev.remotes.every((x) => x === '2606:4700:4700::1111') && ev.dnsLookups === 0 && ev.canary === 0;
    check('E6 REAL transport given an IPv6 answer: any attempt is only to that exact address on 443, no hostname re-resolution, canary untouched', pinnedOk, JSON.stringify({ att: ev.attempts, rem: ev.remotes, dns: ev.dnsLookups }));
    rec(r.ok ? 'PASS' : 'INCONCLUSIVE', 'E7 [NET] real IPv6 connection to a public host', r.ok ? '' : `this environment has no usable IPv6 (${r.code} ${r.detail}); the live IPv6 path could not be exercised here`); }
  await new Promise((res) => setTimeout(res, 500));
  check('E8 a connect failure on the real transport (IPv6 answer on a host with no IPv6) is returned as a normal result and does NOT raise an uncaught exception that would kill the process (regression for the fixed pinned-lookup bug; deterministic CI version: test33_transport_failure.js)', uncaught.length === 0 && (v6res.ok || /EAFNOSUPPORT|ENETUNREACH|EHOSTUNREACH|EADDRNOTAVAIL|ECONNREFUSED|ETIMEDOUT|TIMEOUT/.test(String(v6res.code + ' ' + v6res.detail))), `uncaught after safeFetch returned: ${JSON.stringify(uncaught)} result: ${v6res.code} ${v6res.detail}`);

  /* ===== F. DNS rebinding ===== */
  if (net_ok) {
    resetEv(); const real = (h) => dns.promises.lookup(h, { all: true, verbatim: true });
    const rs = mkResolver((n, h) => (n === 1 ? real(h) : pub('127.0.0.1')));
    const r = await SF.safeFetch('https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/README.md', { operatorHosts: ['raw.githubusercontent.com'], resolver: rs });
    check('F1 [NET] resolver turns hostile after validation (2nd answer = loopback): the real connection still goes only to the validated public address, no re-resolution', r.ok && rs.calls.length === 1 && ev.remotes.length >= 1 && ev.remotes.every((x) => GH.includes(x)) && ev.attempts.every((a) => a.port === 443 && a.pinned && a.pinned.every((p) => GH.includes(p))) && ev.dnsLookups === 0 && ev.canary === 0, JSON.stringify({ ok: r.ok, code: r.code, rem: ev.remotes, att: ev.attempts, dns: ev.dnsLookups, can: ev.canary }));
    resetEv();
    const rs2 = mkResolver((n, h) => (n === 1 ? real(h) : pub('127.0.0.1')));
    const r2 = await SF.safeFetch('https://github.com/anthropics/anthropic-sdk-typescript/raw/main/README.md', { operatorHosts: ['github.com', 'raw.githubusercontent.com'], resolver: rs2 });
    const ghIps = (await real('github.com')).map((x) => x.address);
    check('F2 [NET] real redirect github.com -> raw host whose 2nd DNS answer is loopback: hop 2 refused, only github.com addresses were ever connected, canary untouched', refused(r2, 'DNS_PRIVATE_ADDRESS') && rs2.calls.length === 2 && ev.remotes.length === 1 && ghIps.includes(ev.remotes[0]) && !GH.includes(ev.remotes[0]) && ev.canary === 0, JSON.stringify({ code: r2.code, rem: ev.remotes, can: ev.canary }));
  } else { rec('INCONCLUSIVE', 'F1/F2 [NET] real-socket DNS rebinding', 'no network from this environment'); }
  { const rs = mkResolver((n) => (n === 1 ? pub('8.8.8.8') : pub('127.0.0.1'))); const t = mkTransport((n) => ({ status: 302, headers: { location: 'https://a.example.org/second' } }));
    const r = await SF.safeFetch('https://a.example.org/first', { ...OP, resolver: rs, transport: t });
    check('F3 same host re-resolved to loopback on the redirect hop: refused, exactly one connection made (the validated one)', refused(r, 'DNS_PRIVATE_ADDRESS') && t.calls.length === 1 && rs.calls.length === 2, `${r.code} t=${t.calls.length}`); }
  { const rs = mkResolver((n) => (n % 2 ? pub('8.8.8.8') : pub('10.0.0.1'))); const t = mkTransport((n) => (n < 4 ? { status: 302, headers: { location: 'https://a.example.org/n' + n } } : {}));
    const r = await SF.safeFetch('https://a.example.org/first', { ...OP, resolver: rs, transport: t });
    check('F4 flip-flopping resolver (public, private, public...): every connection made was to a validated public address, stops at the first private answer', refused(r, 'DNS_PRIVATE_ADDRESS') && t.calls.every((c) => c.ip === '8.8.8.8') && t.calls.length === 1, JSON.stringify(t.calls)); }

  /* ===== G. redirect limits ===== */
  const chain = (n) => mkTransport((c) => (c <= n ? { status: 302, headers: { location: `https://${c % 2 ? 'b' : 'a'}.example.org/hop${c}` } } : {}));
  { const t = chain(3), rs = mkResolver(() => pub('8.8.8.8')); const r = await SF.safeFetch('https://a.example.org/s', { ...OP, resolver: rs, transport: t });
    check('G1 exactly 3 redirects (the maximum) then 200 succeeds: 4 connections', r.ok && t.calls.length === 4 && r.redirects.length === 3, `${r.code} calls=${t.calls.length}`); }
  { const t = chain(4), rs = mkResolver(() => pub('8.8.8.8')); const r = await SF.safeFetch('https://a.example.org/s', { ...OP, resolver: rs, transport: t });
    check('G2 a 4th redirect is refused TOO_MANY_REDIRECTS and the 5th connection is NEVER made', refused(r, 'TOO_MANY_REDIRECTS') && t.calls.length === 4 && rs.calls.length === 4, `${r.code} calls=${t.calls.length} dns=${rs.calls.length}`); }
  { const t = mkTransport(() => ({ status: 301, headers: { location: 'https://a.example.org/s' } })); const r = await SF.safeFetch('https://a.example.org/s', { ...OP, resolver: mkResolver(() => pub('8.8.8.8')), transport: t });
    check('G3 an endless self-redirect loop stops after 4 connections', refused(r, 'TOO_MANY_REDIRECTS') && t.calls.length === 4, `${r.code} calls=${t.calls.length}`); }
  { const t = chain(1); const r = await SF.safeFetch('https://a.example.org/s', { ...OP, resolver: mkResolver(() => pub('8.8.8.8')), transport: t, maxRedirects: 0 });
    check('G4 maxRedirects=0: the first redirect is not followed (1 connection)', refused(r, 'TOO_MANY_REDIRECTS') && t.calls.length === 1, `${r.code} calls=${t.calls.length}`); }
  for (const [id, hdrs, code] of [['G5 3xx without Location', {}, 'REDIRECT_INVALID'], ['G6 3xx with an unparseable Location', { location: 'http://[::' }, 'REDIRECT_INVALID']]) { const t = mkTransport(() => ({ status: 302, headers: hdrs })); const r = await SF.safeFetch('https://a.example.org/s', { ...OP, resolver: mkResolver(() => pub('8.8.8.8')), transport: t }); check(`${id} -> ${code}, no second connection`, refused(r, code) && t.calls.length === 1, `${r.code} calls=${t.calls.length}`); }
  { const t = mkTransport((c) => (c === 1 ? { status: 302, headers: { location: '/rel/path?q=1' } } : {})); const r = await SF.safeFetch('https://a.example.org/s', { ...OP, resolver: mkResolver(() => pub('8.8.8.8')), transport: t });
    check('G7 a relative Location resolves against the CURRENT host (never an attacker-chosen one)', r.ok && t.calls[1].host === 'a.example.org' && t.calls[1].path === '/rel/path', JSON.stringify(t.calls)); }
  if (net_ok) { resetEv(); const r = await SF.safeFetch('https://github.com/anthropics/anthropic-sdk-typescript/raw/main/README.md', { operatorHosts: ['github.com', 'raw.githubusercontent.com'], maxRedirects: 0 });
    check('G8 [NET] real redirect with maxRedirects=0: not followed, only ONE real connection (to github.com), none to the redirect target', refused(r, 'TOO_MANY_REDIRECTS') && ev.remotes.length === 1 && !GH.includes(ev.remotes[0]), JSON.stringify({ code: r.code, rem: ev.remotes })); }
  else rec('INCONCLUSIVE', 'G8 [NET] real redirect not followed at maxRedirects=0', 'no network from this environment');

  /* ===== H. redirects to disallowed targets: the target is never resolved and never connected ===== */
  const FMT = { operatorHosts: ['a.example.org', 'b.example.org'], formatHosts: ['a.example.org'] };
  const TARGETS = [['http://b.example.org/x', 'URL_SCHEME'], ['ftp://b.example.org/x', 'URL_SCHEME'], ['file:///etc/passwd', 'URL_SCHEME'], ['javascript:alert(1)', 'URL_SCHEME'], ['data:text/plain,hi', 'URL_SCHEME'],
    ['https://b.example.org:8443/x', 'URL_PORT'], ['https://u:p@b.example.org/x', 'URL_USERINFO'], ['https://127.0.0.1/x', 'URL_IP_LITERAL'], ['https://[::1]/x', 'URL_IP_LITERAL'], ['https://2130706433/x', 'URL_IP_LITERAL'], ['https://0x7f.1/x', 'URL_IP_LITERAL'], ['https://169.254.169.254/latest/meta-data', 'URL_IP_LITERAL'],
    ['https://localhost/x', 'URL_HOST_INVALID'], ['https://b.example.org./x', 'URL_HOST_INVALID'], ['https://evil.example/x', 'HOST_NOT_ALLOWED'], ['https://a.example.org.evil.example/x', 'HOST_NOT_ALLOWED'], ['https://b.example.org/x', 'HOST_NOT_ALLOWED_BY_FORMAT']];
  bad = [];
  for (const [loc, code] of TARGETS) { const rs = mkResolver(() => pub('8.8.8.8')), t = mkTransport(() => ({ status: 302, headers: { location: loc } })); const r = await SF.safeFetch('https://a.example.org/s', { ...FMT, resolver: rs, transport: t }); if (!(refused(r, code) && t.calls.length === 1 && rs.calls.length === 1)) bad.push(`${loc} -> ${r.code} (want ${code}) conns=${t.calls.length} dns=${rs.calls.length}`); }
  check(`H1 ${TARGETS.length} disallowed redirect targets (scheme, port, userinfo, IP literals incl. cloud metadata, localhost, trailing dot, lookalike, not-in-allowlist, excluded-by-format): each refused, target never resolved, only the first connection made`, bad.length === 0, bad.join(' | '));
  { const t = mkTransport((c) => (c === 1 ? { status: 302, headers: { location: 'https://B.EXAMPLE.ORG/x' } } : {})); const r = await SF.safeFetch('https://a.example.org/s', { operatorHosts: ['a.example.org', 'b.example.org'], resolver: mkResolver(() => pub('8.8.8.8')), transport: t });
    check('H2 control: an UPPERCASE spelling of an allowed host is normalized and allowed (the checks are not just rejecting everything)', r.ok && t.calls[1].host === 'b.example.org', r.code); }
  if (net_ok) { resetEv(); const r = await SF.safeFetch('https://github.com/anthropics/anthropic-sdk-typescript/raw/main/README.md', { operatorHosts: ['github.com'] });
    check('H3 [NET] real redirect to a host outside the allowlist: refused, exactly one real connection (github.com), the raw host was never connected', refused(r, 'HOST_NOT_ALLOWED') && ev.remotes.length === 1 && !GH.includes(ev.remotes[0]) && r.redirects.length === 1, JSON.stringify({ code: r.code, rem: ev.remotes })); }
  else rec('INCONCLUSIVE', 'H3 [NET] real redirect to a disallowed host', 'no network from this environment');

  /* ===== J. TLS certificate errors ===== */
  await new Promise((res) => canarySrv.close(res));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-tls-'));
  let certsOk = true;
  try {
    const sh = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
    fs.writeFileSync(path.join(dir, 'ca.cnf'), '[ca]\ndefault_ca=d\n[d]\ndir=.\ndatabase=index.txt\nnew_certs_dir=.\nserial=serial\ndefault_md=sha256\npolicy=p\nunique_subject=no\n[p]\ncommonName=supplied\n');
    fs.writeFileSync(path.join(dir, 'index.txt'), ''); fs.writeFileSync(path.join(dir, 'serial'), '01\n');
    const EC = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
    sh('req', '-x509', ...EC, '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '3650', '-subj', '/CN=cos-test-ca', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
    const leaf = (name, host, dates) => { sh('req', ...EC, '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + host); fs.writeFileSync(path.join(dir, name + '.ext'), `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\n`);
      sh('ca', '-config', 'ca.cnf', '-batch', '-notext', '-in', name + '.csr', '-out', name + '.pem', '-cert', 'ca.pem', '-keyfile', 'ca.key', '-extfile', name + '.ext', ...(dates ? ['-startdate', dates[0], '-enddate', dates[1]] : ['-days', '2'])); };
    leaf('good', 'tls-test.example'); leaf('expired', 'tls-test.example', ['20200101000000Z', '20200102000000Z']); leaf('wrong', 'other.example');
    sh('req', '-x509', ...EC, '-keyout', 'self.key', '-out', 'self.pem', '-days', '2', '-subj', '/CN=tls-test.example', '-addext', 'subjectAltName=DNS:tls-test.example');
  } catch (e) { certsOk = false; rec('INCONCLUSIVE', 'J* local TLS-error servers', 'could not generate test certificates: ' + String(e.message).slice(0, 160)); }
  if (certsOk) {
    const child = (which, trust) => { const r = spawnSync(process.execPath, [__filename, '--tls-child', dir, which], { env: { ...process.env, ...(trust ? { NODE_EXTRA_CA_CERTS: path.join(dir, 'ca.pem') } : { NODE_EXTRA_CA_CERTS: '' }) }, encoding: 'utf8', timeout: 30000 }); try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { harness: (r.stderr || r.stdout || 'no output').slice(0, 200) }; } };
    const ctl = child('control', true);
    check('J0 control: valid certificate for the right hostname from a trusted CA is accepted by the real transport (so the rejections below are caused by the certificate, not the harness)', ctl.ok === true && ctl.status === 200 && ctl.body === 'ok' && ctl.requests === 1, JSON.stringify(ctl));
    for (const [id, which, trust, codes] of [['J1 self-signed certificate', 'selfsigned', false, ['DEPTH_ZERO_SELF_SIGNED_CERT']], ['J2 certificate from an untrusted CA', 'untrustedca', false, ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT']], ['J3 expired certificate (CA trusted)', 'expired', true, ['CERT_HAS_EXPIRED']], ['J4 certificate for a different hostname (CA trusted)', 'wronghost', true, ['ERR_TLS_CERT_ALTNAME_INVALID']]]) {
      const r = child(which, trust); check(`${id}: handshake rejected (${r.errCode}), no body returned, the server never saw an HTTP request`, r.ok === false && codes.includes(r.errCode) && r.requests === 0, JSON.stringify(r)); }
  }
  // Interception probe: if a host answers ANY server name with a certificate this process trusts, a TLS-intercepting gateway sits in the path
  // and a hostname-mismatch test against a public address proves nothing. Then J5 is INCONCLUSIVE (never PASS).
  const intercepted = net_ok ? await new Promise((res) => { const t = require('node:tls').connect({ host: PUB, port: 443, servername: 'cos-probe-no-such-host.example' }, () => { const ok = t.authorized; t.destroy(); res(ok); }); t.setTimeout(8000, () => { t.destroy(); res(false); }); t.on('error', () => res(false)); }) : false;
  // J6: trust-isolated run of the REAL end-to-end path. A child process with NODE_EXTRA_CA_CERTS cleared trusts only Node's bundled public roots.
  // Behind an intercepting gateway (whose CA is in the system bundle), the gateway certificate must then be REJECTED by the real transport.
  // Without interception the origin certificate chains to a public root and the fetch must succeed. Either way proves certificate verification is live.
  if (net_ok) {
    const code = `const SF=require(${JSON.stringify(path.join(__dirname, 'safe_fetch.js'))});SF.safeFetch('https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/README.md',{operatorHosts:['raw.githubusercontent.com'],timeoutMs:15000}).then(r=>console.log(JSON.stringify({ok:r.ok,code:r.code,detail:String(r.detail||'').slice(0,120),text:r.text.length,ip:r.connectedIp})));`;
    const cp = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, NODE_EXTRA_CA_CERTS: '', SSL_CERT_FILE: '' }, encoding: 'utf8', timeout: 30000 });
    let o = null; try { o = JSON.parse(cp.stdout.trim().split('\n').pop()); } catch { /* ignore */ }
    if (!o) rec('INCONCLUSIVE', 'J6 [NET] trust-isolated real path', 'child produced no result: ' + String(cp.stderr).slice(0, 160));
    else if (intercepted) check('J6 [NET] behind the intercepting gateway, with only Node\'s bundled public roots trusted, the gateway-issued certificate is REJECTED by the real transport (FETCH_ERROR, no text): certificate verification is live on the real public-IP path', o.ok === false && o.code === 'FETCH_ERROR' && o.text === 0 && /UNABLE_TO_VERIFY|SELF_SIGNED|CERT|ISSUER|ERR_TLS/.test(o.detail), JSON.stringify(o));
    else check('J6 [NET] without interception, the origin certificate chains to a bundled public root and the fetch succeeds', o.ok === true && o.text > 0, JSON.stringify(o));
  }
  if (net_ok && intercepted) rec('INCONCLUSIVE', 'J5 [NET] real public-IP certificate mismatch', 'this environment is behind a TLS-intercepting egress gateway that mints a trusted certificate for ANY server name, so a hostname mismatch cannot be produced here. NOTE: every [NET] result above therefore verified the gateway certificate, not the origin certificate. Local J1-J4 cover the transport\'s certificate checks.');
  else if (net_ok) {
    resetEv(); const r = await SF.safeFetch('https://example.org/', { operatorHosts: ['example.org'], resolver: mkResolver(() => pub(PUB)), timeoutMs: 15000 });
    check('J5 [NET] real public address presenting a certificate that does not match the requested hostname (SNI example.org sent to a GitHub Pages IP): refused as FETCH_ERROR, no text, connection went only to the validated address', !r.ok && r.code === 'FETCH_ERROR' && r.text === '' && /CERT|ALTNAME|UNABLE|SELF_SIGNED|EPROTO|ERR_TLS|ECONNRESET/.test(String(r.detail)) && ev.remotes.every((x) => x === PUB), JSON.stringify({ code: r.code, d: r.detail, rem: ev.remotes }));
  } else rec('INCONCLUSIVE', 'J5 [NET] real public-IP certificate mismatch', 'no network from this environment');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\nTEST33-NET-HARDENING (socket-level instrumentation; canary ${canaryUp ? 'on 127.0.0.1:443' : 'NOT available'}; network ${net_ok ? 'available' : 'unavailable'}) result=${fail ? 'FAIL' : inc ? 'PASS-WITH-INCONCLUSIVE' : 'PASS'} passed=${pass} failed=${fail} inconclusive=${inc}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL  unexpected error', e && e.stack); process.exit(1); });
