#!/usr/bin/env node
/**
 * Chief of Staff — dashboard backend (v1.2, deployable)
 *
 * Serves the three API endpoints the operator dashboard / Test 19 expect:
 *   GET  /api/snapshot                 (bearer token required)
 *   POST /api/missions                 (bearer token required, Test 19)
 *                                      { "objective": string, "nonce": string }
 *                                      Runs a REAL mission through the real
 *                                      Researcher->Analyst->Creator->Critic
 *                                      chain (mission_chain.js) against real
 *                                      Gemini/Groq. No mock path exists here —
 *                                      if GEMINI_API_KEY is unset this route
 *                                      fails with 503 rather than faking a
 *                                      result.
 *   POST /api/missions/:id/decision    (bearer token required)
 *                                      { "decision": "APPROVED" | "REJECTED" }
 * and, unauthenticated, two things that carry no mission data:
 *   GET  /health                       liveness + DB reachability
 *   GET  /                             the static operator dashboard (same origin
 *                                      as the API, so the phone needs no URL)
 *
 * Reads the Test 17 SQLite database (test17_schema.sql). Zero dependencies;
 * needs Node 22.5+ (node:sqlite).
 *
 * Security stance (see SECURITY_BOUNDARIES.md):
 *  - A bearer token is ALWAYS required. If COS_TOKEN / COS_TOKENS is unset, a
 *    random token is generated and printed at startup.
 *  - Binds to 127.0.0.1 unless COS_HOST is set.
 *  - The approver identity comes from the authenticated token. The dashboard's
 *    "decided_by" field is ignored, never trusted.
 *  - Approval requires the mission's LATEST decision row to be
 *    AWAITING_APPROVAL, checked inside a write transaction (no double
 *    decisions, no approving a rejected/completed/in-progress mission).
 *  - Execution goes through gateExecute(), a copy of Test 17's execute(): it
 *    re-reads the APPROVED row from the DB and refuses otherwise.
 *  - Decisions are append-only INSERTs into `decisions`. Nothing is UPDATEd
 *    or DELETEd. Refused attempts are logged to `backend_events`.
 *  - The backend never sees or needs Gemini/Groq keys.
 *
 * Env:
 *   COS_DB               path to SQLite file        (default ./test17.db)
 *   PORT / COS_PORT      listen port. PORT (set by most hosts) wins, then
 *                        COS_PORT, then 8787.
 *   COS_HOST             default 127.0.0.1  (0.0.0.0 inside a container/for LAN)
 *   COS_TOKEN            single token; approver recorded as "operator"
 *   COS_TOKENS           "alice=tok1,bob=tok2"; approver = token's name
 *                        When COS_HOST is not loopback the server REFUSES TO
 *                        START unless a token of >= 24 characters is supplied
 *                        (no generated/ephemeral or short tokens on a network).
 *   COS_READONLY         1 = evidence-viewing mode: no writes at all (decisions
 *                        return 403, no backend_events rows). Use this to look
 *                        at a preserved Test 17 database without altering it.
 *   COS_INIT_DB          1 = if COS_DB does not exist, create it EMPTY from
 *                        COS_SCHEMA (default ./test17_schema.sql). Never
 *                        touches an existing file.
 *   COS_DASHBOARD        path of the dashboard HTML (default
 *                        ./chief_of_staff_dashboard.html next to this file)
 *   COS_CSP_CONNECT      extra connect-src origins for the served dashboard
 *                        (default none: the page may only talk to itself)
 *   COS_TLS_TERMINATED   1 = a proxy/platform terminates HTTPS in front of this
 *                        process (silences the plain-HTTP warning)
 *   COS_MODE             MOCK | LIVE  (default MOCK — the DB does not record
 *                        which mode produced it, so set LIVE yourself only
 *                        when the data came from a --live run)
 *   COS_ALLOWED_ORIGINS  comma list; default * (safe: auth is a header token,
 *                        no cookies)
 *   COS_GEMINI_MODEL / COS_GROQ_MODEL   model labels shown in provider calls
 *   GEMINI_API_KEY       required for POST /api/missions (Test 19). Without
 *                        it that route returns 503. Never returned by any
 *                        endpoint, never logged.
 *   GROQ_API_KEY         optional fallback provider for POST /api/missions.
 *                        Without it, a Gemini failure just fails the call
 *                        (no fallback), same as a 1-provider list elsewhere.
 *   COS_MISSION_SEED_URL server-side (no-CORS) grounding URL the Researcher
 *                        fetches for every POST /api/missions call (default:
 *                        the same public README used by Test 17 --live)
 *
 * NOTE: test17_final_acceptance.js DELETES its DB on every run. Stop this
 * server first, or just restart it after; it opens the DB per request so a
 * recreated file is picked up.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { runLiveMission } = require('./mission_chain');

const DB_PATH = path.resolve(process.env.COS_DB || path.join(__dirname, 'test17.db'));
const PORT = Number(process.env.PORT || process.env.COS_PORT || 8787);
const VERSION = '1.2.0';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const MISSION_SEED_URL = process.env.COS_MISSION_SEED_URL
  || 'https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/README.md';
const READONLY = process.env.COS_READONLY === '1';
const INIT_DB = process.env.COS_INIT_DB === '1';
const SCHEMA_PATH = path.resolve(process.env.COS_SCHEMA || path.join(__dirname, 'test17_schema.sql'));
const DASHBOARD_PATH = path.resolve(process.env.COS_DASHBOARD || path.join(__dirname, 'chief_of_staff_dashboard.html'));
const TLS_TERMINATED = process.env.COS_TLS_TERMINATED === '1';
const CSP_CONNECT = (process.env.COS_CSP_CONNECT || '').trim();
const LOOPBACK = h => h === '127.0.0.1' || h === 'localhost' || h === '::1';
const HOST = process.env.COS_HOST || '127.0.0.1';
const MODE = (process.env.COS_MODE || 'MOCK').toUpperCase() === 'LIVE' ? 'LIVE' : 'MOCK';
const ALLOWED = (process.env.COS_ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
const MODELS = {
  gemini: process.env.COS_GEMINI_MODEL || 'gemini-2.5-flash',
  groq: process.env.COS_GROQ_MODEL || 'llama-3.3-70b-versatile',
};
const MAX_BODY = 8 * 1024;
const SPECIALISTS = ['researcher', 'analyst', 'creator', 'critic'];

/* ---------------- auth ---------------- */
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const tokens = []; // { name, hash }
function addToken(name, tok) { if (tok) tokens.push({ name, hash: sha(tok) }); }
if (process.env.COS_TOKENS) {
  for (const part of process.env.COS_TOKENS.split(',')) {
    const i = part.indexOf('=');
    if (i > 0) addToken(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
}
addToken('operator', process.env.COS_TOKEN);
let generated = null;
if (!tokens.length) { generated = crypto.randomBytes(24).toString('hex'); addToken('operator', generated); }

const MIN_TOKEN = 24;
if (!LOOPBACK(HOST)) {
  const bad = [];
  if (generated) bad.push('no COS_TOKEN / COS_TOKENS set (a generated token changes on every restart and would be printed to logs)');
  for (const t of [process.env.COS_TOKEN, ...(process.env.COS_TOKENS || '').split(',').map(x => x.slice(x.indexOf('=') + 1).trim())]) {
    if (t && t.length < MIN_TOKEN) bad.push(`a token is shorter than ${MIN_TOKEN} characters`);
  }
  if (bad.length) {
    console.error(`REFUSING TO START on ${HOST}: ${[...new Set(bad)].join('; ')}.\n` +
      `Set COS_TOKEN to a random secret of at least ${MIN_TOKEN} characters, e.g.  openssl rand -hex 24`);
    process.exit(2);
  }
}

function authenticate(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const h = sha(m[1].trim());
  let found = null;
  for (const t of tokens) if (crypto.timingSafeEqual(h, t.hash)) found = t; // no early exit
  return found ? found.name : null;
}

/* ---------------- db ---------------- */
function initDbIfRequested() {
  if (!INIT_DB || fs.existsSync(DB_PATH)) return null;
  if (READONLY) return 'COS_INIT_DB ignored: COS_READONLY=1';
  if (!fs.existsSync(SCHEMA_PATH)) return `COS_INIT_DB set but schema file not found: ${SCHEMA_PATH}`;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  try { db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8')); } finally { db.close(); }
  return `created EMPTY database from ${path.basename(SCHEMA_PATH)}`;
}

function open(write) {
  if (write && READONLY) throw Object.assign(new Error('Backend is in read-only (evidence) mode'), { status: 403 });
  if (!fs.existsSync(DB_PATH)) throw Object.assign(new Error('Database file not found'), { status: 503 });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 5000;');
  if (READONLY) db.exec('PRAGMA query_only = ON;');
  if (write) {
    db.exec(`CREATE TABLE IF NOT EXISTS backend_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT, event TEXT NOT NULL,
      detail TEXT NOT NULL, actor TEXT, created_at TEXT NOT NULL)`);
  }
  return db;
}
const nowISO = () => new Date().toISOString();
const hasTable = (db, n) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(n);

function logEvent(mission, event, detail, actor) {
  if (READONLY) { console.warn(`[read-only, not persisted] ${event} ${detail}`); return; }
  let db; try {
    db = open(true);
    db.prepare(`INSERT INTO backend_events (mission_id,event,detail,actor,created_at) VALUES (?,?,?,?,?)`)
      .run(mission || null, event, String(detail).slice(0, 500), actor || null, nowISO());
  } catch { /* logging must never break a request */ } finally { try { db && db.close(); } catch {} }
}

// AUTH_FAILED rows are capped so an internet scanner cannot fill the volume:
// first 20 per 10-minute window are recorded, then a single THROTTLED marker.
let authWin = 0, authCount = 0;
function logAuthFailure(detail) {
  const now = Date.now();
  if (now - authWin > 600000) { authWin = now; authCount = 0; }
  authCount++;
  if (authCount <= 20) logEvent(null, 'AUTH_FAILED', detail, null);
  else if (authCount === 21) logEvent(null, 'AUTH_FAILED_THROTTLED', 'further AUTH_FAILED entries suppressed for this 10-minute window', null);
}

/* ---------------- snapshot ---------------- */
const IN_PROGRESS = new Set(['RESEARCHED', 'ANALYZED', 'ARTIFACT_DRAFTED', 'ARTIFACT_VERIFIED']);
const EVENT_NAME = { RESEARCHED: 'RESEARCH_COMPLETED', AWAITING_APPROVAL: 'APPROVAL_REQUESTED' };
const INJECTION = [/ignore\s+(all\s+|previous\s+|prior\s+)?instructions/i, /pre[-\s]?approved/i,
  /set\s+risk_tier\s*=\s*low/i, /bypass\s+approval/i, /auto[-\s]?approve/i];
const injected = t => INJECTION.some(re => re.test(t || ''));

function buildSnapshot() {
  const db = open(false);
  try {
    const missionsRaw = db.prepare(`SELECT * FROM missions ORDER BY created_at DESC LIMIT 100`).all();
    const decisions = db.prepare(`SELECT * FROM decisions ORDER BY id ASC`).all();
    const calls = db.prepare(`SELECT * FROM provider_calls ORDER BY id ASC`).all();
    const claims = db.prepare(`SELECT * FROM claims ORDER BY id ASC`).all();
    const fetches = db.prepare(`SELECT * FROM fetch_log ORDER BY id ASC`).all();
    const critics = db.prepare(`SELECT * FROM critic_reviews ORDER BY id ASC`).all();
    const execs = db.prepare(`SELECT mission_id, COUNT(*) AS n FROM execution_log GROUP BY mission_id`).all();
    const execCount = Object.fromEntries(execs.map(e => [e.mission_id, e.n]));
    const beEvents = hasTable(db, 'backend_events')
      ? db.prepare(`SELECT * FROM backend_events ORDER BY id ASC`).all() : [];

    const by = (arr, k) => arr.reduce((m, r) => ((m[r[k]] = m[r[k]] || []).push(r), m), {});
    const decBy = by(decisions, 'mission_id'), callBy = by(calls, 'mission_id'),
      claimBy = by(claims, 'mission_id'), critBy = by(critics, 'mission_id');

    const missions = missionsRaw.map(m => {
      const d = decBy[m.id] || [];
      const last = d[d.length - 1];
      const st = last ? last.status : 'PROPOSED';
      const approved = d.find(x => x.status === 'APPROVED');
      const cs = callBy[m.id] || [];
      const cr = critBy[m.id] || [];
      const lastVerdict = cr.length ? cr[cr.length - 1].verdict : null;
      const reasons = [];
      for (const c of claimBy[m.id] || []) {
        if (c.poisoned || injected(c.text)) reasons.push('Claim contained instruction-like text');
        if (c.fetch_match === 0) reasons.push('Claim evidence not verified against fetched content');
      }
      if (lastVerdict && lastVerdict !== 'PASS') reasons.push('Critic verdict ' + lastVerdict);
      const approval =
        st === 'REJECTED' || d.some(x => x.status === 'REJECTED') ? 'REJECTED'
        : approved ? (/^auto:/i.test(approved.rationale) ? 'AUTO (LOW TIER)' : 'APPROVED')
        : st === 'AWAITING_APPROVAL' ? 'PENDING' : 'NOT REQUIRED';
      return {
        id: m.id, objective: m.request_text,
        status: IN_PROGRESS.has(st) ? 'IN_PROGRESS' : st,
        risk_tier: String(m.risk_tier).toUpperCase(),
        specialists: [...new Set([...cs.map(c => c.specialist), ...(cr.length ? ['critic'] : [])])],
        provider_used: cs.length ? cs[cs.length - 1].provider_used : null,
        fallback_used: cs.some(c => c.fallback_triggered === 1),
        approval_status: approval,
        execution_status: execCount[m.id] ? 'COMPLETED' : (approval === 'REJECTED' ? 'NOT EXECUTED' : 'NOT STARTED'),
        created_at: m.created_at, updated_at: last ? last.created_at : m.created_at,
        risk_reason: [...new Set(reasons)].join('; ') || (last && st === 'AWAITING_APPROVAL' ? last.rationale : ''),
      };
    });

    const approvals = missions.filter(m => m.status === 'AWAITING_APPROVAL').map(m => ({
      mission_id: m.id, title: m.objective, risk_tier: m.risk_tier, reason: m.risk_reason, requested_at: m.updated_at }));

    const providerCalls = calls.slice(-60).reverse().map(c => ({
      ts: c.created_at, mission_id: c.mission_id, attempted_provider: c.provider_attempted,
      attempted_status: c.attempted_status_code == null ? 200 : c.attempted_status_code,
      used_provider: c.provider_used, model: MODELS[String(c.provider_used).toLowerCase()] || '',
      fallback_triggered: c.fallback_triggered === 1, outcome: c.schema_valid === 1 ? 'success' : 'schema_invalid',
      schema_valid: c.schema_valid === 1 }));

    const missionReq = Object.fromEntries(missionsRaw.map(m => [m.id, m.request_text]));
    const research = claims.slice(-40).reverse().map(c => {
      const f = fetches.filter(x => x.mission_id === c.mission_id && x.url === c.source_url).pop()
        || fetches.filter(x => x.mission_id === c.mission_id).pop();
      const inj = c.poisoned === 1 || injected(c.text);
      return { mission_id: c.mission_id, query: missionReq[c.mission_id] || '', source_url: c.source_url || '',
        fetched_at: f ? f.created_at : null, snippet: c.evidence_snippet || '', claim: c.text,
        confidence: c.confidence, grounding: c.fetch_match === 1 ? 'GROUNDED' : 'GROUNDING_FAILED',
        uncertainty: c.fetch_match === 1 ? (inj ? 'Claim text contains instruction-like content; treated as data only.' : '')
          : (f && f.bytes === 0 ? 'Fetch returned 0 bytes — no content to verify the claim against.'
            : 'Evidence snippet was not found in fetched content.'),
        injection_flag: inj };
    });

    const audit = [
      ...decisions.map(d => ({ ts: d.created_at, mission_id: d.mission_id, event: EVENT_NAME[d.status] || d.status,
        detail: d.rationale, violation: false })),
      ...beEvents.map(e => ({ ts: e.created_at, mission_id: e.mission_id || '', event: e.event,
        detail: e.detail + (e.actor ? ` (by ${e.actor})` : ''), violation: true })),
    ].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 200);

    const lastActivity = s => { const c = calls.filter(x => x.specialist === s).pop();
      return c ? c.created_at : (s === 'critic' && critics.length ? critics[critics.length - 1].created_at : null); };
    const specialists = SPECIALISTS.map(s => ({ name: s, status: 'ready', current_task: '—', last_activity: lastActivity(s) }));

    // Same invariant Test 17's audit check verifies: no EXECUTED without an earlier APPROVED, per mission.
    let auditOk = true;
    for (const [, d] of Object.entries(decBy)) {
      const ai = d.findIndex(x => x.status === 'APPROVED'), ei = d.findIndex(x => x.status === 'EXECUTED');
      if (ei !== -1 && (ai === -1 || ai > ei)) auditOk = false;
    }
    let integrity = 'FAILED';
    try {
      const fresh = new DatabaseSync(DB_PATH);
      const r = fresh.prepare('PRAGMA integrity_check').get();
      fresh.prepare('SELECT COUNT(*) FROM decisions').get();
      fresh.close();
      if (r && Object.values(r)[0] === 'ok') integrity = 'VERIFIED';
    } catch {}
    const recent = calls.slice(-10);

    return {
      meta: { generated_at: nowISO(), mode: MODE, read_only: READONLY, version: VERSION },
      system: { status: 'operational' },
      providers: { primary: 'gemini', fallback: 'groq', calls: providerCalls },
      missions, approvals, specialists, research, audit,
      memory: { engine: 'SQLite (node:sqlite)',
        counts: { missions: missionsRaw.length, decisions: decisions.length, research: claims.length, audit: decisions.length + beEvents.length },
        // A fresh connection can read the DB and PRAGMA integrity_check is ok. Not the full Test 17 readback.
        fresh_readback: { status: integrity, verified_at: nowISO() } },
      health: { memory: integrity === 'VERIFIED' ? 'ok' : 'fail', audit: auditOk ? 'ok' : 'fail',
        approval: auditOk ? 'ok' : 'fail',
        ...(recent.length ? { ai: recent.every(c => c.schema_valid === 1) ? 'ok' : 'warn' } : {}) },
    };
  } finally { try { db.close(); } catch {} }
}

/* ---------------- decision (the approval boundary) ---------------- */
// Copy of Test 17 execute(): only place EXECUTED is written; re-reads APPROVED from the DB.
function gateExecute(db, missionId, ts) {
  const row = db.prepare(`SELECT id FROM decisions WHERE mission_id = ? AND status = 'APPROVED' ORDER BY id DESC LIMIT 1`).get(missionId);
  if (!row) throw new Error(`BOUNDARY VIOLATION BLOCKED: mission ${missionId} has no APPROVED decision row — execution refused`);
  const later = db.prepare(`SELECT 1 FROM decisions WHERE mission_id = ? AND id > ? AND status = 'REJECTED'`).get(missionId, row.id);
  if (later) throw new Error(`BOUNDARY VIOLATION BLOCKED: mission ${missionId} was rejected after approval`);
  db.prepare(`INSERT INTO execution_log (mission_id, detail, created_at) VALUES (?,?,?)`).run(missionId, `executed under decision id=${row.id}`, ts);
  db.prepare(`INSERT INTO decisions (mission_id,status,rationale,created_at) VALUES (?,?,?,?)`).run(missionId, 'EXECUTED', `executed under decision id=${row.id}`, ts);
  db.prepare(`INSERT INTO decisions (mission_id,status,rationale,created_at) VALUES (?,?,?,?)`).run(missionId, 'COMPLETED', 'mission complete', ts);
}

function decide(missionId, decision, actor) {
  const db = open(true);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const m = db.prepare(`SELECT id FROM missions WHERE id = ?`).get(missionId);
      if (!m) { db.exec('ROLLBACK'); return { code: 404, body: { ok: false, error: 'Unknown mission' } }; }
      const last = db.prepare(`SELECT status FROM decisions WHERE mission_id = ? ORDER BY id DESC LIMIT 1`).get(missionId);
      if (!last || last.status !== 'AWAITING_APPROVAL') {
        db.exec('ROLLBACK');
        return { code: 409, body: { ok: false, error: `Mission is not awaiting approval (current state: ${last ? last.status : 'none'})` }, refused: true };
      }
      const ts = nowISO();
      const ins = db.prepare(`INSERT INTO decisions (mission_id,status,rationale,created_at) VALUES (?,?,?,?)`);
      if (decision === 'REJECTED') {
        ins.run(missionId, 'REJECTED', `human: rejected by ${actor} via operator dashboard`, ts);
        db.exec('COMMIT');
        return { code: 200, body: { ok: true, state: 'REJECTED', decided_by: actor } };
      }
      ins.run(missionId, 'APPROVED', `human: approved by ${actor} via operator dashboard`, ts);
      gateExecute(db, missionId, ts); // same transaction: if it throws, the approval rolls back too
      db.exec('COMMIT');
      return { code: 200, body: { ok: true, state: 'COMPLETED', decided_by: actor } };
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  } finally { try { db.close(); } catch {} }
}

/* ---------------- http ---------------- */
function cors(req, res) {
  const o = req.headers.origin;
  if (ALLOWED.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (o && ALLOWED.includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
// Served page may only talk to its own origin: even if untrusted mission text
// ever produced script injection, the operator token could not be posted elsewhere.
const CSP = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'${CSP_CONNECT ? ' ' + CSP_CONNECT : ''}; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function serveDashboard(req, res) {
  let buf;
  try { buf = fs.readFileSync(DASHBOARD_PATH); }
  catch { return send(res, 404, { ok: false, error: 'Dashboard file not found on the server (COS_DASHBOARD)' }); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, ...SEC });
  res.end(req.method === 'HEAD' ? undefined : buf);
}
function health(req, res) {
  let present = fs.existsSync(DB_PATH), readable = false;
  if (present) { let db; try { db = new DatabaseSync(DB_PATH); db.prepare('SELECT 1 FROM decisions LIMIT 1').get(); readable = true; } catch {} finally { try { db && db.close(); } catch {} } }
  const body = JSON.stringify({ ok: true, service: 'chief-of-staff-backend', version: VERSION, mode: MODE, read_only: READONLY,
    db: { present, readable }, init: { enabled: INIT_DB, result: INIT_RESULT }, time: nowISO() });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...SEC });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function send(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    const url = new URL(req.url, 'http://x');
    // Public, data-free routes: the static page and the health probe.
    if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/index.html')) return serveDashboard(req, res);
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') return health(req, res);
    const actor = authenticate(req);
    if (!actor) { if (url.pathname.startsWith('/api/')) logAuthFailure(`${req.method} ${url.pathname}`); return send(res, 401, { ok: false, error: 'Missing or invalid bearer token' }); }

    if (req.method === 'GET' && url.pathname === '/api/snapshot') return send(res, 200, buildSnapshot());

    if (req.method === 'POST' && url.pathname === '/api/missions') {
      if (READONLY) return send(res, 403, { ok: false, error: 'Backend is in read-only (evidence) mode; no mission can be run' });
      if (!GEMINI_API_KEY) return send(res, 503, { ok: false, error: 'GEMINI_API_KEY not configured on the server — cannot run a live mission' });
      let body; try { body = JSON.parse(await readBody(req) || '{}'); } catch { return send(res, 400, { ok: false, error: 'Invalid JSON' }); }
      const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
      const nonce = typeof body.nonce === 'string' ? body.nonce.trim() : '';
      if (objective.length < 10 || objective.length > 2000) return send(res, 400, { ok: false, error: 'objective must be 10-2000 characters' });
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(nonce)) return send(res, 400, { ok: false, error: 'nonce is required: 6-64 chars, letters/digits/_/- only' });
      const db = open(true);
      try {
        const result = await runLiveMission(db, {
          requestText: objective, nonce, seedUrl: MISSION_SEED_URL,
          keys: { gemini: GEMINI_API_KEY, groq: GROQ_API_KEY || null },
          models: MODELS,
        });
        logEvent(result.missionId, 'MISSION_SUBMITTED',
          `by ${actor}, outcome=${result.outcome}, provider_used=${result.providerUsed}, nonce_verified=${result.nonceVerifiedInProviderResponse && result.nonceVerifiedInArtifact}`, actor);
        return send(res, 201, { ok: true, ...result });
      } catch (e) {
        logEvent(null, 'MISSION_FAILED', `by ${actor}: ${e.message}`, actor);
        return send(res, 502, { ok: false, error: e.message });
      } finally { try { db.close(); } catch {} }
    }

    const m = /^\/api\/missions\/([A-Za-z0-9_-]{1,64})\/decision$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      let body; try { body = JSON.parse(await readBody(req) || '{}'); } catch { return send(res, 400, { ok: false, error: 'Invalid JSON' }); }
      const decision = body && body.decision;
      if (decision !== 'APPROVED' && decision !== 'REJECTED') return send(res, 400, { ok: false, error: 'decision must be APPROVED or REJECTED' });
      if (READONLY) return send(res, 403, { ok: false, error: 'Backend is in read-only (evidence) mode; no decision was recorded' });
      const r = decide(m[1], decision, actor); // body.decided_by is deliberately ignored
      if (r.refused) logEvent(m[1], 'DECISION_REFUSED', `${decision} refused: ${r.body.error}`, actor);
      return send(res, r.code, r.body);
    }
    send(res, 404, { ok: false, error: 'Not found' });
  } catch (e) {
    const code = e.status || 500;
    if (String(e.message).startsWith('BOUNDARY VIOLATION')) logEvent(null, 'EXECUTION_BLOCKED', e.message, null);
    send(res, code, { ok: false, error: code === 500 ? 'Internal error' : e.message });
    if (code === 500) console.error(e);
  }
});

let initNote = null;
try { initNote = initDbIfRequested(); } catch (e) { initNote = 'DB init failed: ' + e.message; }
// Path-free summary for the public /health probe (the full note, with paths, stays in the console only).
const INIT_RESULT = !INIT_DB ? 'disabled' : initNote === null ? 'not_needed' : /^created/.test(initNote) ? 'created' : /ignored: COS_READONLY/.test(initNote) ? 'skipped' : 'failed';

server.listen(PORT, HOST, () => {
  console.log(`Chief of Staff backend v${VERSION} on http://${HOST}:${PORT}  (mode=${MODE}${READONLY ? ', READ-ONLY' : ''})`);
  console.log(`DB: ${DB_PATH}${fs.existsSync(DB_PATH) ? '' : '   <-- NOT FOUND yet (set COS_INIT_DB=1 to create an empty one)'}`);
  if (initNote) console.log(`DB init: ${initNote}`);
  console.log(`Dashboard file: ${fs.existsSync(DASHBOARD_PATH) ? 'found' : 'NOT FOUND'}  |  health: GET /health`);
  if (generated) console.log(`Access token (generated, changes each start; set COS_TOKEN to keep one):\n  ${generated}`);
  if (!LOOPBACK(HOST)) console.log(TLS_TERMINATED
    ? 'Listening beyond loopback; HTTPS is assumed to be terminated in front of this process (COS_TLS_TERMINATED=1).'
    : 'WARNING: listening beyond loopback over plain HTTP — the token can be sniffed on shared networks. Put HTTPS in front of it (set COS_TLS_TERMINATED=1 once you have).');
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.log(`${sig}: shutting down`); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
