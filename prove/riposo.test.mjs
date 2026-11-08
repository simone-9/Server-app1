import assert from 'node:assert/strict';
const { pushAmmesso, inRiposo, eUrgente, minutiItalia } = await import('../scripts/push.mjs');
// ore italiane: novembre = UTC+1 (ora solare)
const notte = new Date('2026-11-08T23:30:00Z'), alba = new Date('2026-11-09T05:30:00Z'), giorno = new Date('2026-11-09T11:00:00Z');   // 00:30, 06:30, 12:00 italiane
assert.equal(minutiItalia(notte), 30); assert.equal(minutiItalia(alba), 6 * 60 + 30); assert.equal(minutiItalia(giorno), 12 * 60);
const P = { riposo: true, riposoDa: 22 * 60, riposoA: 7 * 60 };
assert.equal(inRiposo(P, notte), true); assert.equal(inRiposo(P, alba), true); assert.equal(inRiposo(P, giorno), false);
assert.equal(inRiposo({ riposo: false, riposoDa: 0, riposoA: 1439 }, notte), false); assert.equal(inRiposo({}, notte), false); assert.equal(inRiposo(null, notte), false);
assert.equal(inRiposo({ riposo: true, riposoDa: 60, riposoA: 60 }, notte), false, 'fascia vuota');
assert.equal(inRiposo({ riposo: true, riposoDa: 13 * 60, riposoA: 14 * 60 }, new Date('2026-11-09T12:30:00Z')), true, 'fascia diurna');
// estate: UTC+2
assert.equal(minutiItalia(new Date('2026-07-01T20:30:00Z')), 22 * 60 + 30);
// di notte: non urgenti saltate, urgenti passano
assert.equal(pushAmmesso(P, 'bacheca-x', false, false, notte), false, 'avviso normale');
assert.equal(pushAmmesso(P, 'bacheca-x', false, true, notte), true, 'avviso urgente');
assert.equal(pushAmmesso(P, 'bacheca-x', true, true, notte), true, 'chiamata di attivazione');
assert.equal(pushAmmesso(P, 'calendario-new-a', false, false, notte), false);
assert.equal(pushAmmesso(P, 'richiesta-rap-a', false, false, notte), false, 'rapporto da compilare');
assert.equal(pushAmmesso(P, 'richiesta-urg-a', false, false, notte), true); assert.equal(pushAmmesso(P, 'richiesta-sq-a|x', false, false, notte), true);
assert.equal(pushAmmesso(P, 'idro-limena-1', false, false, notte), false, 'Guardia 1'); assert.equal(pushAmmesso(P, 'idro-limena-2', false, false, notte), true, 'Guardia 2');
assert.equal(pushAmmesso(P, 'idro-prev-2', false, false, notte), false, 'previsione');
assert.equal(pushAmmesso(P, 'cfd-09-11-2026-1', false, false, notte), false, 'gialla'); assert.equal(pushAmmesso(P, 'cfd-09-11-2026-2', false, false, notte), true, 'arancione');
assert.equal(pushAmmesso(P, 'idro-prova', false, false, notte), true, 'prova');
// di giorno tutto come prima
assert.equal(pushAmmesso(P, 'bacheca-x', false, false, giorno), true); assert.equal(pushAmmesso({ riposo: true, bacheca: false, riposoDa: 22 * 60, riposoA: 7 * 60 }, 'bacheca-x', false, false, giorno), false);
// urgenti rispettano comunque le preferenze «tutte» e per tipo
assert.equal(pushAmmesso({ tutte: false, riposo: true }, 'richiesta-urg-a', false, false, notte), false);
assert.equal(pushAmmesso({ ...P, richieste: false }, 'richiesta-urg-a', false, false, notte), false);
// senza preferenze: invariato
assert.equal(pushAmmesso(undefined, 'bacheca-x', false, false, notte), true);
console.log('RIPOSO OK');
