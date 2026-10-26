'use strict';
/* Test 33 TRANSPORT-FAILURE (CI-safe: no network, no root, no IPv6 needed).
 * Regression for the process-killing defect found by test33_net_hardening E8: when the OS rejects the connect right after the pinned lookup answered
 * (typically EAFNOSUPPORT for an IPv6 answer on a host without IPv6), the real https transport used to return FETCH_ERROR *and* leak an uncaught
 * 'error' event from a half-built TLS socket, which kills the Node process. The OS failure is emulated faithfully: net.Socket#connect asks the lookup
 * function for the address and then fails; if the lookup answered synchronously the failure is synchronous, otherwise it happens on a later tick.
 * Run: node test33_transport_failure.js */
const net = require('node:net');
const SF = require('./safe_fetch');
let pass = 0, fail = 0;
const check = (id, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${ok ? '' : '  -> ' + String(d).slice(0, 300)}`); };
const uncaught = []; process.on('uncaughtException', (e) => { uncaught.push((e && (e.code || e.message)) || String(e)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seen = { lookups: [], syncAnswer: [], failCode: 'EAFNOSUPPORT' };
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (o) {
  const self = this, code = seen.failCode;
  const fail = () => self.destroy(Object.assign(new Error(`connect ${code}`), { code, syscall: 'connect', port: 443 }));
  if (o && typeof o === 'object' && typeof o.lookup === 'function') {
    // Node 22 asks with {all:true} (autoSelectFamily); older/other paths ask with {all:false}. Both forms must pin the same address and answer later.
    let inCall = true, first = true;
    o.lookup(o.host, { all: true }, (err, list) => { seen.syncAnswer.push(inCall); seen.lookups.push({ form: 'all', err, address: list && list[0] && list[0].address, family: list && list[0] && list[0].family, n: Array.isArray(list) ? list.length : -1 }); if (first) { first = false; fail(); } });
    o.lookup(o.host, { all: false }, (err, address, family) => { seen.lookups.push({ form: 'single', err, address, family, n: 1 }); });
    inCall = false;
  } else fail();
  return this;
};
const V6 = '2606:4700:4700::1111', V4 = '93.184.216.34';
const run = (ip, fam) => SF.safeFetch('https://example.org/x', { operatorHosts: ['example.org'], resolver: async () => [{ address: ip, family: fam }], timeoutMs: 4000 });
(async () => {
  for (const code of ['EAFNOSUPPORT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'EINVAL']) {
    seen.failCode = code; uncaught.length = 0; seen.lookups.length = 0; seen.syncAnswer.length = 0;
    const r = await run(code === 'EAFNOSUPPORT' ? V6 : V4, code === 'EAFNOSUPPORT' ? 6 : 4); await sleep(150);
    check(`T1 OS connect failure ${code} right after the pinned lookup: clean FETCH_ERROR carrying the code, no text`, !r.ok && r.code === 'FETCH_ERROR' && new RegExp(code).test(String(r.detail)) && r.text === '' && r.textSha256 === null, JSON.stringify({ code: r.code, d: r.detail }));
    check(`T2 ... and NO uncaught exception escapes (the process would have died): ${code}`, uncaught.length === 0, JSON.stringify(uncaught));
  }
  seen.failCode = 'EAFNOSUPPORT'; uncaught.length = 0; seen.lookups.length = 0; seen.syncAnswer.length = 0;
  for (let i = 0; i < 5; i++) await run(V6, 6);
  await sleep(300);
  check('T3 five consecutive failed IPv6 connects: still no uncaught exception, process alive', uncaught.length === 0, JSON.stringify(uncaught));
  check('T4 BOTH lookup forms (all:true as Node 22 uses, and all:false) handed back exactly the validated address and family, a single entry, every time (never another address)', seen.lookups.length === 10 && seen.lookups.every((l) => !l.err && l.address === V6 && l.family === 6 && l.n === 1), JSON.stringify(seen.lookups.slice(0, 3)));
  check('T5 the pinned lookup answers on a LATER tick, never synchronously (this is what prevents the half-built-socket error)', seen.syncAnswer.length === 5 && seen.syncAnswer.every((x) => x === false), JSON.stringify(seen.syncAnswer));
  net.Socket.prototype.connect = origConnect;
  console.log(`\nTEST33-TRANSPORT-FAILURE (no network) result=${fail ? 'FAIL' : 'PASS'} passed=${pass} failed=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL  unexpected error', e && e.stack); process.exit(1); });
