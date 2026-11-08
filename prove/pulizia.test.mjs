import assert from 'node:assert/strict';
const { pulisci, soglia } = await import('../scripts/pulizia-esecuzioni.mjs');
const ora = Date.parse('2026-11-08T12:00:00Z');
assert.equal(soglia(24, ora), '2026-11-07T12:00:00.000Z'); assert.equal(soglia('x', ora), '2026-11-07T12:00:00.000Z'); assert.equal(soglia(48, ora), '2026-11-06T12:00:00.000Z');
const mk = (id, ore, status = 'completed') => ({ id, status, created_at: new Date(ora - ore * 3600000).toISOString() });
function rete(tutte) {
  const cancellate = [], chiamate = [];
  const f = async (url, init = {}) => {
    chiamate.push((init.method || 'GET') + ' ' + url);
    if ((init.method || 'GET') === 'DELETE') { const id = Number(url.split('/').pop()); cancellate.push(id); return { status: id === 999 ? 403 : 204, ok: id !== 999 }; }
    const u = new URL(url), p = Number(u.searchParams.get('page')), lim = Date.parse(decodeURIComponent(u.searchParams.get('created').slice(1)));
    const l = tutte.filter(x => Date.parse(x.created_at) < lim && x.status === u.searchParams.get('status'));
    return { ok: true, status: 200, json: async () => ({ workflow_runs: l.slice((p - 1) * 100, p * 100) }) };
  };
  return { f, cancellate, chiamate };
}
let t = rete([mk(1, 30), mk(2, 25), mk(3, 23), mk(4, 1), mk(5, 100, 'in_progress')]);
let r = await pulisci({ repo: 'a/b', token: 't', ore: 24, ora, fetchF: t.f, log: () => {}, attesa: 0 });
assert.deepEqual(t.cancellate, [1, 2]); assert.equal(r.cancellate, 2);
t = rete([mk(1, 30)]); r = await pulisci({ repo: 'a/b', token: 't', ora, soloProva: true, fetchF: t.f, log: () => {}, attesa: 0 }); assert.equal(t.cancellate.length, 0); assert.equal(r.trovate, 1);
// più pagine
t = rete(Array.from({ length: 230 }, (_, i) => mk(i + 1, 30 + i))); r = await pulisci({ repo: 'a/b', token: 't', ora, fetchF: t.f, log: () => {}, attesa: 0 }); assert.equal(r.cancellate, 230);
// permesso negato: si ferma
t = rete([mk(999, 30), mk(7, 31)]); r = await pulisci({ repo: 'a/b', token: 't', ora, fetchF: t.f, log: () => {}, attesa: 0 }); assert.equal(r.errori, 1); assert.deepEqual(t.cancellate, [999]);
await assert.rejects(() => pulisci({ repo: '../x', token: 't' }), /non valido/); await assert.rejects(() => pulisci({ repo: 'a/b', token: '' }), /mancante/);
console.log('PULIZIA OK');
