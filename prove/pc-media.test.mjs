// Worker pc-media: caricamento del libretto dei mezzi (foto e PDF, ambito «veicoli») con un accesso Firebase finto ma firmato davvero
import assert from 'node:assert/strict';
const worker = (await import('../pc-media/worker.js')).default;
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
const b64 = b => Buffer.from(b).toString('base64url');
async function token(email) {
  const now = Math.floor(Date.now() / 1000), t = b64(JSON.stringify({ alg: 'RS256', kid: 'k1' })) + '.' + b64(JSON.stringify({ aud: 'prova', iss: 'https://securetoken.google.com/prova', sub: 'u', exp: now + 600, iat: now, email }));
  return t + '.' + b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(t)));
}
const RUOLI = { 'soc@prova.it': { role: { stringValue: 'Operatore SOC' } }, 'vol@prova.it': { role: { stringValue: 'Volontario' } }, 'ente@prova.it': { role: { stringValue: 'Ente' }, scade: { integerValue: String(Date.now() + 3600000) } } };
globalThis.fetch = async (u) => {
  u = String(u);
  if (u.includes('securetoken@system')) return { ok: true, json: async () => ({ keys: [jwk] }) };
  const m = u.match(/documents\/ruoli\/(.+)$/); if (m) { const f = RUOLI[decodeURIComponent(m[1])]; return { ok: !!f, json: async () => ({ fields: f }) }; }
  throw new Error('rete non prevista: ' + u);
};
const R2 = new Map();
const env = { FIREBASE_PROJECT_ID: 'prova', ALLOWED_ORIGINS: 'https://app.prova', ADMIN_EMAILS: 'admin@prova.it',
  MEDIA: { put: async (k, d, o) => { R2.set(k, { d, ...o, size: d.byteLength }); }, head: async k => R2.get(k) || null, get: async k => { const o = R2.get(k); return o ? { body: o.d, size: o.size, httpMetadata: o.httpMetadata } : null; }, delete: async k => { R2.delete(k); } } };
async function chiama(metodo, percorso, email, tipo, corpo) {
  const r = await worker.fetch(new Request('https://w.prova' + percorso, { method: metodo, headers: { Origin: 'https://app.prova', Authorization: 'Bearer ' + await token(email), ...(tipo ? { 'Content-Type': tipo } : {}) }, body: corpo }), env);
  let j = null; if ((r.headers.get('Content-Type') || '').includes('json')) j = await r.json(); return { s: r.status, j, r };
}
const PDF = new TextEncoder().encode('%PDF-1.4 prova'), JPG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);

// PDF del libretto: ammesso solo nell'ambito «veicoli»
let x = await chiama('POST', '/media?ambito=veicoli', 'soc@prova.it', 'application/pdf', PDF);
assert.equal(x.s, 201); assert.match(x.j.k, /^veicoli\/\d{4}\/[0-9a-f-]{36}\.pdf$/); assert.equal(x.j.tipo, 'application/pdf');
const kPdf = x.j.k; assert.equal(R2.get(kPdf).customMetadata.ambito, 'veicoli');
assert.equal((await chiama('POST', '/media?ambito=interventi', 'soc@prova.it', 'application/pdf', PDF)).s, 415, 'PDF fuori dai veicoli');
assert.equal((await chiama('POST', '/media', 'soc@prova.it', 'application/pdf', PDF)).s, 415, 'PDF senza ambito');
assert.equal((await chiama('POST', '/media?ambito=veicoli', 'soc@prova.it', 'application/pdf', new TextEncoder().encode('<html>non un pdf</html>'))).s, 415, 'finto PDF');
assert.equal((await chiama('POST', '/media?ambito=veicoli', 'soc@prova.it', 'application/pdf', new Uint8Array(10 * 1024 * 1024 + 1))).s, 413, 'PDF troppo grande');
// foto del libretto
x = await chiama('POST', '/media?ambito=veicoli', 'admin@prova.it', 'image/jpeg', JPG);
assert.equal(x.s, 201); assert.match(x.j.k, /^veicoli\/\d{4}\/.+\.jpg$/); const kJpg = x.j.k;
// lettura: ruoli operativi sì, Volontario ed Ente no
x = await chiama('GET', '/media/' + kPdf, 'admin@prova.it'); assert.equal(x.s, 200); assert.equal(x.r.headers.get('Content-Type'), 'application/pdf'); assert.equal(x.r.headers.get('X-Content-Type-Options'), 'nosniff');
assert.equal((await chiama('GET', '/media/' + kPdf, 'vol@prova.it')).s, 403);
assert.equal((await chiama('GET', '/media/' + kPdf, 'ente@prova.it')).s, 404);
assert.equal((await chiama('POST', '/media?ambito=veicoli', 'ente@prova.it', 'image/jpeg', JPG)).s, 403, 'Ente non carica nei veicoli');
// gli altri ambiti restano come prima
x = await chiama('POST', '/media?ambito=richieste', 'ente@prova.it', 'image/jpeg', JPG); assert.equal(x.s, 201); assert.match(x.j.k, /^richieste\//);
assert.equal((await chiama('POST', '/media?ambito=inventato', 'soc@prova.it', 'image/jpeg', JPG)).j.k.split('/')[0], 'interventi');
assert.equal((await chiama('POST', '/media?ambito=veicoli', 'soc@prova.it', 'text/html', JPG)).s, 415);
// eliminazione
assert.equal((await chiama('DELETE', '/media/' + kJpg, 'soc@prova.it')).s, 200); assert.ok(!R2.has(kJpg));
assert.equal((await chiama('DELETE', '/media/' + kPdf, 'admin@prova.it')).s, 200); assert.ok(!R2.has(kPdf));
assert.equal((await chiama('GET', '/media/veicoli/2026/x.exe', 'admin@prova.it')).s, 400);
console.log('pc-media: prove superate');
