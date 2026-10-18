'use strict';
/* Minimal S3-compatible client (AWS Signature V4) for Backblaze B2's S3 API. Server-side only; no dependencies.
 * Credentials come from the caller (environment variables in cos_backend / b2_boot) and are used ONLY to sign:
 * they are never put in a URL, never logged, and never returned. Errors carry status + S3 error code, not secrets. */
const crypto = require('node:crypto');

const sha256hex = b => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = p => p.split('/').map(enc).join('/');
const amz = d => d.toISOString().replace(/[:-]|\.\d{3}/g, '');           // 20130524T000000Z

/* Returns the headers to send (including Authorization). headers: extra headers to sign (lower-case names). */
function signRequest({ method, host, path, query = {}, headers = {}, payload = '', payloadHash, keyId, secret, region, service = 's3', date = new Date() }) {
  const t = amz(date), day = t.slice(0, 8), ph = payloadHash || sha256hex(payload);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host, 'x-amz-content-sha256': ph, 'x-amz-date': t };
  const names = Object.keys(all).sort();
  const canonHeaders = names.map(n => `${n}:${all[n]}\n`).join('');
  const canonQuery = Object.keys(query).sort().map(k => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonical = [method, encPath(path), canonQuery, canonHeaders, names.join(';'), ph].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', t, scope, sha256hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secret, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(sts).digest('hex');
  return { headers: { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` }, signature, canonical, stringToSign: sts };
}

class S3Error extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const xmlTag = (x, t) => { const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(x); return m ? m[1] : null; };
const xmlUnescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function makeS3({ endpoint, bucket, keyId, appKey, region, fetchFn, timeoutMs = 30000, now = () => new Date() }) {
  const u = new URL(endpoint), f = fetchFn || fetch;
  const scrub = s => String(s).split(keyId).join('[key-id]').split(appKey).join('[secret]');
  async function call(method, key, { query = {}, body, headers = {}, listing = false } = {}) {
    const path = '/' + bucket + (listing ? '' : '/' + key), payload = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
    const s = signRequest({ method, host: u.host, path, query, headers, payload, keyId, secret: appKey, region, date: now() });
    const qs = Object.keys(query).sort().map(k => `${enc(k)}=${enc(query[k])}`).join('&');
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const sendHeaders = { ...s.headers }; delete sendHeaders.host;
      const r = await f(`${u.protocol}//${u.host}${encPath(path)}${qs ? '?' + qs : ''}`, { method, headers: sendHeaders, body: payload.length ? payload : undefined, signal: ctl.signal });
      const buf = Buffer.from(await r.arrayBuffer());
      if (!r.ok && !(method === 'HEAD')) { const x = buf.toString('utf8').slice(0, 2000); throw new S3Error(r.status, xmlTag(x, 'Code') || 'Error', scrub(`S3 ${method} failed: HTTP ${r.status} ${xmlTag(x, 'Code') || ''}`)); }
      return { status: r.status, ok: r.ok, body: buf, headers: r.headers };
    } catch (e) {
      if (e instanceof S3Error) throw e;
      throw new S3Error(0, 'NetworkError', scrub(`S3 ${method} network error: ${e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || e}`));
    } finally { clearTimeout(t); }
  }
  return {
    bucket,
    async put(key, body, { contentType = 'application/octet-stream', metadata = {} } = {}) {
      const h = { 'content-type': contentType }; for (const [k, v] of Object.entries(metadata)) h['x-amz-meta-' + k.toLowerCase()] = v;
      return call('PUT', key, { body, headers: h });
    },
    async get(key) { return call('GET', key); },
    async head(key) { return call('HEAD', key); },
    async del(key) { return call('DELETE', key); },
    async list(prefix) {
      const out = []; let token;
      for (let page = 0; page < 50; page++) {
        const q = { 'list-type': '2', prefix }; if (token) q['continuation-token'] = token;
        const x = (await call('GET', '', { query: q, listing: true })).body.toString('utf8');
        for (const c of x.split('<Contents>').slice(1)) out.push({ key: xmlUnescape(xmlTag(c, 'Key') || ''), size: Number(xmlTag(c, 'Size') || 0), lastModified: xmlTag(c, 'LastModified') });
        if (xmlTag(x, 'IsTruncated') === 'true' && xmlTag(x, 'NextContinuationToken')) token = xmlUnescape(xmlTag(x, 'NextContinuationToken')); else break;
      }
      return out;
    },
    scrub,
  };
}
module.exports = { signRequest, makeS3, S3Error, sha256hex };
