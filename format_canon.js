'use strict';
/* Canonical JSON + manifest hashing. Pure (node:crypto only) so the loader, the gate and Decision Memory
 * all compute the SAME hash from the SAME code. Spec: FORMAT_SPECIFICATION.md section 5.2.
 * Canonical form: object keys sorted, no whitespace, UTF-8, strings NFC-normalised, integers only. */
const crypto = require('node:crypto');

function canonicalJson(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') { if (!Number.isInteger(v)) throw new Error('canonical JSON: non-integer number'); return String(v); }
  if (typeof v === 'string') return JSON.stringify(v.normalize('NFC'));
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k.normalize('NFC')) + ':' + canonicalJson(v[k])).join(',') + '}';
  throw new Error('canonical JSON: unsupported type ' + typeof v);
}
const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
/* The hash covers BOTH the authored manifest and the effective policy (engine defaults applied). */
const hashFormat = (manifest, effective) => sha256(canonicalJson({ manifest, effective_policy: effective }));

/* Verify a stored format_manifests row: its hash must equal the recomputed hash of what it stores. */
function verifyStoredRow(row) {
  try {
    const manifest = JSON.parse(row.manifest_json), eff = JSON.parse(row.effective_policy_json);
    return hashFormat(manifest, eff) === row.hash && canonicalJson(manifest) === row.manifest_json && canonicalJson(eff) === row.effective_policy_json;
  } catch { return false; }
}
module.exports = { canonicalJson, sha256, hashFormat, verifyStoredRow };
