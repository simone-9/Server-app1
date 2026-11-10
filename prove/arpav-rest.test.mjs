import assert from 'node:assert/strict';
const { tempoRest, idstazDi, unisci, serieDa, integraDaRest, cumulataDa, integraPioggiaRest, _azzeraCache } = await import('../scripts/arpav-rest.mjs');
// ora solare (UTC+1)
assert.equal(new Date(tempoRest('2026-11-10T15:20:00')).toISOString(), '2026-11-10T14:20:00.000Z');
assert.ok(isNaN(tempoRest('boh')));
// codice della stazione dal file XML
const xml = '<STAZIONE><IDSTAZ>283</IDSTAZ><NOME>Barzizza</NOME><SENSORE><ID>300005751</ID></SENSORE><SENSORE><ID>300005752</ID></SENSORE></STAZIONE><STAZIONE><IDSTAZ>302</IDSTAZ><SENSORE><ID>300005777</ID></SENSORE></STAZIONE>';
assert.equal(idstazDi(xml, '300005777'), 302); assert.equal(idstazDi(xml, '300005752'), 283); assert.equal(idstazDi(xml, '999'), null);
// unione: solo misure più recenti, niente doppioni, finestra di ~48 ore
const T = Date.parse('2026-11-10T12:10:00Z');
let u = unisci([[T - 600000, -0.29], [T, -0.29]], [[T - 600000, 9], [T, 9], [T + 600000, -0.30], [T + 1200000, -0.30], [T + 1200000, -0.31]]);
assert.equal(u.aggiunti, 2); assert.deepEqual(u.serie.slice(-2), [[T + 600000, -0.30], [T + 1200000, -0.30]]);
u = unisci([[T - 60 * 3600000, 1], [T, 2]], [[T + 600000, 3]]); assert.equal(u.serie.length, 2, 'misure oltre le 49 ore tolte');
// sensore scelto
const righe = [{ tipo: 'LIDRO', nome_sensore: 'Livello idrometrico 2', dataora: '2026-11-10T15:20:00', valore: '9.9' }, { tipo: 'LIDRO', nome_sensore: 'Livello idrometrico 1', dataora: '2026-11-10T15:20:00', valore: '-0.30' }, { tipo: 'PORT', nome_sensore: 'Portata', dataora: '2026-11-10T15:10:00', valore: '15.69' }];
assert.deepEqual(serieDa(righe, 'LIDRO'), [[Date.parse('2026-11-10T14:20:00Z'), -0.30]]);
assert.deepEqual(serieDa(righe, 'PORT'), [[Date.parse('2026-11-10T14:10:00Z'), 15.69]]);
// integrazione con rete finta
const risposte = {
  meteo_idroOggi: { success: true, data: [{ codice_stazione: 302, codseqst: 300001741 }, { codice_stazione: 283, codseqst: 300001722 }] },
  '300001741': { success: true, data: [{ tipo: 'LIDRO', nome_sensore: 'Livello idrometrico 1', dataora: '2026-11-10T13:10:00', valore: '-0.29' }, { tipo: 'LIDRO', nome_sensore: 'Livello idrometrico 1', dataora: '2026-11-10T15:20:00', valore: '-0.30' }] },
  '300001722': { success: true, data: [{ tipo: 'LIDRO', nome_sensore: 'Livello idrometrico 1', dataora: '2026-11-10T15:20:00', valore: '0.57' }, { tipo: 'PORT', nome_sensore: 'Portata', dataora: '2026-11-10T14:20:00', valore: '15.69' }] }
};
const fetchF = async (url) => { const k = url.includes('meteo_idroOggi') ? 'meteo_idroOggi' : (url.match(/codseqst=(\d+)/) || [])[1]; const j = risposte[k]; return j ? { ok: true, json: async () => j } : { ok: false, status: 404, json: async () => ({}) }; };
const st = {
  '300005777': { nome: 'Limena', ids: 302, dati: [[Date.parse('2026-11-10T12:10:00Z'), -0.29]], q: [], qu: '' },
  '300005751': { nome: 'Barzizza', ids: 283, dati: [[Date.parse('2026-11-10T12:20:00Z'), 0.58]], q: [[Date.parse('2026-11-10T12:20:00Z'), 15.7]], qu: 'm³/s' },
  '300011337': { nome: 'Levico (TN)', ids: 999, dati: [[1, 1]], q: [] },
  'senza': { nome: 'Senza codice', dati: [] }
};
const log = []; const r = await integraDaRest(st, { fetch: fetchF, log: x => log.push(x) });
assert.deepEqual(r, { stazioni: 2, misure: 3, errori: 0, lette: 2 });
assert.equal(new Date(st['300005777'].dati.at(-1)[0]).toISOString(), '2026-11-10T14:20:00.000Z'); assert.equal(st['300005777'].dati.length, 2);
assert.equal(st['300005751'].q.length, 2); assert.equal(st['300011337'].dati.length, 1);
// servizio giù: nessun errore, dati invariati
_azzeraCache();
const st2 = { a: { nome: 'A', ids: 302, dati: [[1, 1]] } };
const r2 = await integraDaRest(st2, { fetch: async () => { throw new Error('rete'); }, log: () => {} });
assert.equal(r2.errori, 1); assert.deepEqual(st2.a.dati, [[1, 1]]);
const r3 = await integraDaRest(st2, { fetch: async () => ({ ok: true, json: async () => ({ success: false }) }), log: () => {} });
assert.equal(r3.errori, 1);
// pioggia: da 5 minuti a cumulata dalla mezzanotte solare ogni 10 minuti
const P = (d, v) => ({ tipo: 'PREC', nome_sensore: 'Precipitazione', dataora: d, valore: String(v) });
const c = cumulataDa([P('2026-11-09T23:55:00', 1), P('2026-11-10T00:00:00', 0.4), P('2026-11-10T00:05:00', 0.2), P('2026-11-10T00:10:00', 0.2), P('2026-11-10T15:55:00', 1), P('2026-11-10T16:00:00', 0.5)]);
assert.deepEqual(c.map(([t, v]) => [new Date(t).toISOString().slice(11, 16), v]), [['23:00', 1.4], ['23:10', 0.4], ['15:00', 1.9]]);
_azzeraCache();
const rispP = { meteo_idroOggi: { success: true, data: [{ codice_stazione: 321, codseqst: 300001774 }] },
  '300001774': { success: true, data: [P('2026-11-10T11:20:00', 0.0), P('2026-11-10T15:40:00', 0.2)] },
  '300000267': { success: true, data: [P('2026-11-10T08:00:00', 3), P('2026-11-10T16:00:00', 2.4)] } };
const fP = async (url) => { const k = url.includes('meteo_idroOggi') ? 'meteo_idroOggi' : (url.match(/codseqst=(\d+)/) || [])[1]; const j = rispP[k]; return j ? { ok: true, json: async () => j } : { ok: false, status: 404, json: async () => ({}) }; };
const pl = { 'rest-300000267': null, '300005808': { nome: 'Vicenza S. Agostino', ids: 321, dati: [[Date.parse('2026-11-10T10:00:00Z'), 1.2]] } };
const rp = await integraPioggiaRest(pl, [{ cs: 300000267, nome: 'Campodarsego' }], { fetch: fP, log: () => {} });
assert.equal(rp.lette, 2); assert.equal(pl['rest-300000267'].nome, 'Campodarsego'); assert.equal(pl['rest-300000267'].dati.at(-1)[1], 5.4);
assert.equal(pl['300005808'].dati.length, 3); assert.ok('rest-300000267' in pl);
// servizio giù: la stazione meteo resta com'era
_azzeraCache(); const vecchio = { nome: 'Campodarsego', dati: [[1, 2]] }; const pl2 = { 'rest-300000267': vecchio };
await integraPioggiaRest(pl2, [{ cs: 300000267, nome: 'Campodarsego' }], { fetch: async () => { throw new Error('rete'); }, log: () => {} });
assert.equal(pl2['rest-300000267'], vecchio);
console.log('TUTTI I TEST OK');
