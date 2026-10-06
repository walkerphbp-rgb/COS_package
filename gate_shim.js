'use strict';
/* Loads the gate under test with NO fallback. target: 'original' | 'fixed'.
 * 'original' = execute() from the repo's mission_chain.js (pre-hardening baseline).
 * Returns {name, run(db,id), fingerprint} so the report proves which code ran. */
const path = require('path'), crypto = require('crypto');
module.exports = function load(target, repoDir) {
  let fn, src;
  if (target === 'original') {
    fn = require(path.join(__dirname, 'legacy_execute.js')).execute;
    if (typeof fn !== 'function') throw new Error('original execute() not found');
    src = fn.toString();
    if (/exactly-once|preceding AWAITING/.test(src)) throw new Error('"original" contains fixed-gate logic');
    return { name: 'original', run: (db, id) => fn(db, id), fingerprint: sha(src) };
  }
  if (target === 'fixed') {
    fn = require('./gate.js').gateExecute; src = fn.toString();
    return { name: 'fixed', run: (db, id) => fn(db, id), fingerprint: sha(src) };
  }
  throw new Error('target must be original|fixed');
  function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12); }
};
