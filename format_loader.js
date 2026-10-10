'use strict';
/* Format loader (spec: FORMAT_SPECIFICATION.md). A format is DATA that can only make the engine stricter.
 *  - strict parser: duplicate keys, __proto__/constructor/prototype, floats, depth and size are rejected
 *  - closed vocabulary: any key not in the schema is an error
 *  - bounds equal the engine defaults on the weak side, so a weaker-than-default value is a load ERROR
 *  - no code, no URLs, no regexes, no secret references
 * Pure except loadFormatsDir (reads files) and registerFormats (writes format_manifests). */
const fs = require('node:fs');
const path = require('node:path');
const { injected } = require('./mission_state');
const { canonicalJson, hashFormat } = require('./format_canon');

const FORMAT_SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 16 * 1024, MAX_FILES = 50, MAX_DEPTH = 6;
const TIERS = ['low', 'medium', 'high'];
const TIER_RANK = { low: 0, medium: 1, high: 2 };
const WHERE = ['objective', 'claim', 'summary', 'artifact'];
const ROLES = ['researcher', 'analyst', 'creator', 'critic'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/* Engine defaults = the effective policy of the `general` format = today's behaviour. Single source of truth. */
const ENGINE_DEFAULTS = Object.freeze({
  persona: { researcher: null, analyst: null, creator: null, critic: null },
  risk: { floor: 'low', triggers: [], mission_types: [] },
  approval: { human_required_for_all: false },
  evidence: { min_claims: 0, min_snippet_chars: 10, source_domains: [] },
  critic: { max_artifact_chars: null, forbidden_terms: [], required_payload_fields: [] },
  limits: { objective_max_chars: 2000 },
});

class FormatError extends Error { constructor(file, errors) { super(`${file}: ${errors.join('; ')}`); this.file = file; this.errors = errors; } }

/* ---------- strict JSON parser (integers only; rejects duplicate and forbidden keys) ---------- */
function parseStrict(text) {
  let i = 0;
  const fail = m => { throw new Error(`JSON: ${m} at offset ${i}`); };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  function value(depth) {
    if (depth > MAX_DEPTH) fail('nesting too deep');
    ws(); const c = text[i];
    if (c === '{') return object(depth);
    if (c === '[') return array(depth);
    if (c === '"') return string();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    if (c === '-' || (c >= '0' && c <= '9')) return number();
    return fail('unexpected character');
  }
  function number() {
    const m = /^-?(0|[1-9][0-9]*)/.exec(text.slice(i)); if (!m) fail('bad number');
    i += m[0].length; if (/[.eE]/.test(text[i] || '')) fail('non-integer numbers are not allowed');
    const n = Number(m[0]); if (!Number.isSafeInteger(n)) fail('integer out of range'); return n;
  }
  function string() {
    i++; let out = '';
    for (;;) {
      if (i >= text.length) fail('unterminated string');
      const c = text[i++];
      if (c === '"') return out;
      if (c === '\\') {
        const e = text[i++];
        if (e === 'u') { const h = text.slice(i, i + 4); if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('bad unicode escape'); out += String.fromCharCode(parseInt(h, 16)); i += 4; }
        else if ('"\\/'.includes(e)) out += e; else if (e === 'n') out += '\n'; else if (e === 't') out += '\t'; else if (e === 'r') out += '\r'; else if (e === 'b') out += '\b'; else if (e === 'f') out += '\f'; else fail('bad escape');
      } else if (c < ' ') fail('raw control character in string'); else out += c;
    }
  }
  function array(depth) { i++; const a = []; ws(); if (text[i] === ']') { i++; return a; } for (;;) { a.push(value(depth + 1)); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === ']') { i++; return a; } fail('expected , or ]'); } }
  function object(depth) {
    i++; const o = Object.create(null); ws(); if (text[i] === '}') { i++; return { ...o }; }
    for (;;) {
      ws(); if (text[i] !== '"') fail('expected a string key'); const k = string();
      if (FORBIDDEN_KEYS.has(k)) fail(`forbidden key "${k}"`);
      if (k in o) fail(`duplicate key "${k}"`);
      ws(); if (text[i++] !== ':') fail('expected :'); o[k] = value(depth + 1); ws();
      if (text[i] === ',') { i++; continue; } if (text[i] === '}') { i++; return { ...o }; } fail('expected , or }');
    }
  }
  const v = value(0); ws(); if (i < text.length) fail('trailing data'); return v;
}

/* ---------- validation ---------- */
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const BAD_TEXT = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;
function validateManifest(m) {
  const errs = []; const e = x => errs.push(x);
  if (!isObj(m)) return ['manifest must be a JSON object'];
  const allow = (obj, keys, where) => { for (const k of Object.keys(obj)) if (!keys.includes(k)) e(`unknown key "${String(k).slice(0, 40)}" in ${where}`); };
  const text = (v, name, min, max, { nl = false } = {}) => {
    if (typeof v !== 'string') return e(`${name} must be text`);
    if (v !== v.normalize('NFC')) e(`${name} must be NFC-normalised`);
    if (BAD_TEXT.test(v) || (!nl && /[\r\n]/.test(v)) || (nl && /\r/.test(v))) e(`${name} contains control, bidi or zero-width characters`);
    if (v.length < min || v.length > max) e(`${name} must be ${min}-${max} characters`);
  };
  const int = (v, name, lo, hi) => { if (!Number.isInteger(v) || v < lo || v > hi) e(`${name} must be an integer ${lo}-${hi}`); };
  const list = (v, name, max) => { if (!Array.isArray(v)) { e(`${name} must be a list`); return false; } if (v.length > max) { e(`${name} may have at most ${max} entries`); return false; } return true; };
  allow(m, ['schema_version', 'format_id', 'format_version', 'title', 'description', 'persona', 'risk', 'approval', 'evidence', 'critic', 'limits'], 'manifest');
  if (m.schema_version !== FORMAT_SCHEMA_VERSION) e(`schema_version must be ${FORMAT_SCHEMA_VERSION}`);
  if (typeof m.format_id !== 'string' || !/^[a-z][a-z0-9_]{2,31}$/.test(m.format_id)) e('format_id must match [a-z][a-z0-9_]{2,31}');
  int(m.format_version, 'format_version', 1, 9999);
  if (m.title !== undefined) text(m.title, 'title', 1, 60);
  if (m.description !== undefined) text(m.description, 'description', 1, 300);
  if (m.persona !== undefined) {
    if (!isObj(m.persona)) e('persona must be an object'); else {
      allow(m.persona, ROLES, 'persona');
      for (const r of ROLES) if (m.persona[r] !== undefined) {
        text(m.persona[r], `persona.${r}`, 1, 600, { nl: true });
        if (typeof m.persona[r] === 'string' && injected(m.persona[r])) e(`persona.${r} contains instruction-like text (rejected at load)`);
      }
    }
  }
  if (m.risk !== undefined) {
    if (!isObj(m.risk)) e('risk must be an object'); else {
      allow(m.risk, ['floor', 'triggers', 'mission_types'], 'risk');
      if (m.risk.floor !== undefined && !TIERS.includes(m.risk.floor)) e('risk.floor must be low, medium or high');
      if (m.risk.triggers !== undefined && list(m.risk.triggers, 'risk.triggers', 20)) {
        const ids = new Set();
        m.risk.triggers.forEach((t, k) => {
          const n = `risk.triggers[${k}]`; if (!isObj(t)) return e(`${n} must be an object`);
          allow(t, ['id', 'where', 'contains', 'tier'], n);
          if (typeof t.id !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(t.id)) e(`${n}.id must match [a-z][a-z0-9_]{1,31}`); else if (ids.has(t.id)) e(`${n}.id is a duplicate`); else ids.add(t.id);
          if (!WHERE.includes(t.where)) e(`${n}.where must be one of ${WHERE.join('/')}`);
          text(t.contains, `${n}.contains`, 2, 60);
          if (t.tier !== 'medium' && t.tier !== 'high') e(`${n}.tier must be medium or high`);
        });
      }
      if (m.risk.mission_types !== undefined && list(m.risk.mission_types, 'risk.mission_types', 10)) {
        const ids = new Set();
        m.risk.mission_types.forEach((t, k) => {
          const n = `risk.mission_types[${k}]`; if (!isObj(t)) return e(`${n} must be an object`);
          allow(t, ['id', 'label', 'floor'], n);
          if (typeof t.id !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(t.id)) e(`${n}.id must match [a-z][a-z0-9_]{1,31}`); else if (ids.has(t.id)) e(`${n}.id is a duplicate`); else ids.add(t.id);
          text(t.label, `${n}.label`, 1, 40);
          if (!TIERS.includes(t.floor)) e(`${n}.floor must be low, medium or high`);
        });
      }
    }
  }
  if (m.approval !== undefined) {
    if (!isObj(m.approval)) e('approval must be an object'); else {
      allow(m.approval, ['human_required_for_all'], 'approval');
      if (m.approval.human_required_for_all !== undefined && typeof m.approval.human_required_for_all !== 'boolean') e('approval.human_required_for_all must be true or false');
    }
  }
  if (m.evidence !== undefined) {
    if (!isObj(m.evidence)) e('evidence must be an object'); else {
      allow(m.evidence, ['min_claims', 'min_snippet_chars', 'source_domains'], 'evidence');
      if (m.evidence.min_claims !== undefined) int(m.evidence.min_claims, 'evidence.min_claims', ENGINE_DEFAULTS.evidence.min_claims, 10);
      if (m.evidence.min_snippet_chars !== undefined) int(m.evidence.min_snippet_chars, 'evidence.min_snippet_chars', ENGINE_DEFAULTS.evidence.min_snippet_chars, 200);
      if (m.evidence.source_domains !== undefined && list(m.evidence.source_domains, 'evidence.source_domains', 20)) {
        const seen = new Set();
        m.evidence.source_domains.forEach((d, k) => {
          if (typeof d !== 'string' || !/^(?=.{3,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d)) e(`evidence.source_domains[${k}] must be a lowercase ASCII hostname`);
          else if (seen.has(d)) e(`evidence.source_domains[${k}] is a duplicate`); else seen.add(d);
        });
      }
    }
  }
  if (m.critic !== undefined) {
    if (!isObj(m.critic)) e('critic must be an object'); else {
      allow(m.critic, ['max_artifact_chars', 'forbidden_terms', 'required_payload_fields'], 'critic');
      if (m.critic.max_artifact_chars !== undefined) int(m.critic.max_artifact_chars, 'critic.max_artifact_chars', 200, 100000);
      if (m.critic.forbidden_terms !== undefined && list(m.critic.forbidden_terms, 'critic.forbidden_terms', 30)) m.critic.forbidden_terms.forEach((t, k) => text(t, `critic.forbidden_terms[${k}]`, 2, 60));
      if (m.critic.required_payload_fields !== undefined && list(m.critic.required_payload_fields, 'critic.required_payload_fields', 10)) m.critic.required_payload_fields.forEach((t, k) => { if (typeof t !== 'string' || !/^[a-z_]{1,32}$/.test(t)) e(`critic.required_payload_fields[${k}] must match [a-z_]{1,32}`); });
    }
  }
  if (m.limits !== undefined) {
    if (!isObj(m.limits)) e('limits must be an object'); else {
      allow(m.limits, ['objective_max_chars'], 'limits');
      if (m.limits.objective_max_chars !== undefined) int(m.limits.objective_max_chars, 'limits.objective_max_chars', 10, ENGINE_DEFAULTS.limits.objective_max_chars);
    }
  }
  return errs;
}

/* Effective policy: every key filled, stricter-of(format, engine default); lists lower-cased and sorted where order has no meaning. */
const lower = s => s.toLowerCase();
function effectivePolicy(m) {
  const D = ENGINE_DEFAULTS, r = m.risk || {}, a = m.approval || {}, ev = m.evidence || {}, c = m.critic || {}, l = m.limits || {}, p = m.persona || {};
  const strictTier = (x, y) => (TIER_RANK[x] >= TIER_RANK[y] ? x : y);
  return {
    persona: Object.fromEntries(ROLES.map(k => [k, p[k] === undefined ? D.persona[k] : p[k]])),
    risk: {
      floor: strictTier(r.floor || D.risk.floor, D.risk.floor),
      triggers: (r.triggers || []).map(t => ({ id: t.id, where: t.where, contains: lower(t.contains), tier: t.tier })),
      mission_types: (r.mission_types || []).map(t => ({ id: t.id, label: t.label, floor: t.floor })),
    },
    approval: { human_required_for_all: !!a.human_required_for_all || D.approval.human_required_for_all },
    evidence: {
      min_claims: Math.max(ev.min_claims ?? 0, D.evidence.min_claims),
      min_snippet_chars: Math.max(ev.min_snippet_chars ?? 0, D.evidence.min_snippet_chars),
      source_domains: [...(ev.source_domains || [])].sort(),
    },
    critic: {
      max_artifact_chars: c.max_artifact_chars === undefined ? D.critic.max_artifact_chars : c.max_artifact_chars,
      forbidden_terms: [...new Set((c.forbidden_terms || []).map(lower))].sort(),
      required_payload_fields: [...new Set(c.required_payload_fields || [])].sort(),
    },
    limits: { objective_max_chars: Math.min(l.objective_max_chars ?? D.limits.objective_max_chars, D.limits.objective_max_chars) },
  };
}

/* Parse + validate + compute. Returns the compiled format, or throws FormatError listing every problem. */
function compileFormat(text, file = 'manifest') {
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new FormatError(file, [`file is larger than ${MAX_FILE_BYTES} bytes`]);
  let manifest; try { manifest = parseStrict(text); } catch (e) { throw new FormatError(file, [e.message]); }
  const errs = validateManifest(manifest); if (errs.length) throw new FormatError(file, errs);
  const effective = effectivePolicy(manifest);
  const hash = hashFormat(manifest, effective);
  return { id: manifest.format_id, version: manifest.format_version, hash, manifest, effective, manifestJson: canonicalJson(manifest), effectiveJson: canonicalJson(effective) };
}

function loadFormatsDir(dir) {
  let files; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch (e) { throw new FormatError(dir, [`cannot read formats directory (${e.code || e.message})`]); }
  if (files.length > MAX_FILES) throw new FormatError(dir, [`more than ${MAX_FILES} format files`]);
  const out = new Map();
  for (const f of files) {
    const c = compileFormat(fs.readFileSync(path.join(dir, f), 'utf8'), f);
    if (f !== `${c.id}.json`) throw new FormatError(f, [`file name must be ${c.id}.json`]);
    if (out.has(c.id)) throw new FormatError(f, [`duplicate format_id ${c.id}`]);
    out.set(c.id, c);
  }
  const g = out.get('general');
  if (!g) throw new FormatError(dir, ['the "general" format is required']);
  if (canonicalJson(g.effective) !== canonicalJson(ENGINE_DEFAULTS)) throw new FormatError('general.json', ['general must equal the engine defaults (it is the identity format)']);
  return out;
}

/* Boot registration. Same id+version with a different hash => refuse (bump the version). */
function registerFormats(db, formats) {
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const f of formats.values()) {
      const ex = db.prepare('SELECT hash FROM format_manifests WHERE format_id = ? AND format_version = ?').get(f.id, f.version);
      if (ex && ex.hash !== f.hash) throw new FormatError(`${f.id}.json`, [`${f.id} version ${f.version} is already registered with different content; bump format_version`]);
      if (!ex) db.prepare('INSERT INTO format_manifests (hash, format_id, format_version, manifest_json, effective_policy_json, registered_at) VALUES (?,?,?,?,?,?)').run(f.hash, f.id, f.version, f.manifestJson, f.effectiveJson, now);
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

/* Deployment selection config: default + allowlist from env. Throws on an inconsistent configuration. */
function selectionConfig(env, formats) {
  const allowed = (env.COS_ALLOWED_FORMATS ? env.COS_ALLOWED_FORMATS.split(',').map(s => s.trim()).filter(Boolean) : [...formats.keys()]);
  const def = env.COS_DEFAULT_FORMAT || 'general';
  const errs = [];
  for (const a of allowed) if (!formats.has(a)) errs.push(`COS_ALLOWED_FORMATS names unknown format "${a.slice(0, 40)}"`);
  if (!allowed.length) errs.push('COS_ALLOWED_FORMATS is empty');
  if (!allowed.includes(def)) errs.push(`COS_DEFAULT_FORMAT "${def.slice(0, 40)}" is not in the allowed formats`);
  if (errs.length) throw new FormatError('environment', errs);
  return { allowed, default: def };
}

/* Per-request selection. Returns { format, missionType } or throws {status:400}. */
function selectForRequest(formats, cfg, { format_id, mission_type } = {}) {
  const bad = m => Object.assign(new Error(m), { status: 400 });
  const id = format_id == null || format_id === '' ? cfg.default : String(format_id);
  if (!/^[a-z][a-z0-9_]{2,31}$/.test(id) || !cfg.allowed.includes(id)) throw bad('format_id is not available on this deployment');
  const format = formats.get(id);
  let mt = null;
  if (mission_type != null && mission_type !== '') {
    mt = format.effective.risk.mission_types.find(t => t.id === String(mission_type));
    if (!mt) throw bad('mission_type is not defined by this format');
  }
  return { format, missionType: mt };
}

module.exports = { FORMAT_SCHEMA_VERSION, ENGINE_DEFAULTS, TIER_RANK, FormatError, parseStrict, validateManifest, effectivePolicy, compileFormat, loadFormatsDir, registerFormats, selectionConfig, selectForRequest, MAX_FILE_BYTES };
