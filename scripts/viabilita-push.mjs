// Modulo «Viabilita'» dell'app 1: notifica push a chi puo' validare quando ci sono segnalazioni «da verificare»
// (moduli_dati/viabilita/segnalazioni con stato «proposta» non ancora notificate). Un solo avviso per esecuzione, anche se le segnalazioni sono piu' d'una.
// Toccando la notifica l'app si apre sulla sezione «Da verificare» del modulo (indirizzo ./?apri=mod_viabilita&sez=verifica).
// Destinatari: Admin e chi ha il livello «scrivi» sul modulo (per ruolo o per singolo utente, dal pannello «Permessi» dell'app).
// Gira su GitHub Actions (.github/workflows/viabilita-push.yml). Senza segreto FIREBASE_SERVICE_ACCOUNT, o a modulo spento, non fa nulla.
import { chiaveServizio, leggiCollezione, aggiornaCampi, inviaPush } from './push.mjs';

const FINESTRA_MS = 24 * 3600 * 1000;   // proposte piu' vecchie di un giorno non si notificano piu'
const TIPI = { chiusa: 'Strada chiusa', acqua: 'Allagamento', pericolo: 'Pericolo', critico: 'Punto critico', info: 'Segnalazione' };
const breve = (t, n) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1).trim() + '…' : x; };

export function daNotificare(segn, ora) {
  return (segn || []).filter(s => { const c = s.campi || {}; const t = Date.parse(c.ts); return c.stato === 'proposta' && !c.notificata && (!Number.isFinite(t) || ora - t <= FINESTRA_MS); });
}

// permessi = campi di impostazioni/permessi ({ ruoli: { Ruolo: { mod_viabilita } }, utenti: { email: { mod_viabilita } } }); se manca la voce di un ruolo vale il predefinito del modulo (Operatore SOC: scrivi)
export function destinatari(ruoli, permessi, modulo = 'viabilita') {
  const k = 'mod_' + modulo, p = permessi || {};
  return (ruoli || []).filter(r => {
    const ruolo = String((r.campi || {}).role || '').trim(); if (ruolo === 'Admin') return true;
    const ex = (((p.utenti || {})[String(r.id).toLowerCase()]) || {})[k] || (((p.utenti || {})[r.id]) || {})[k];
    const liv = ex || (((p.ruoli || {})[ruolo]) || {})[k] || (ruolo === 'Operatore SOC' ? 'scrivi' : 'nessuno');
    return liv === 'scrivi';
  }).map(r => String(r.id).toLowerCase());
}

export function messaggio(nuove) {
  const n = nuove.length, riga = (s) => { const c = s.campi || {}; return breve([c.titolo || TIPI[c.tipo] || 'Segnalazione', c.strada].filter(Boolean).join(' · '), 60); };
  return { titolo: n === 1 ? 'Viabilità · 1 segnalazione da verificare' : `Viabilità · ${n} segnalazioni da verificare`, testo: nuove.slice(0, 2).map(riga).join(' | ') + (n > 2 ? ` e altre ${n - 2}` : ''), tag: 'viabilita-verifica', icona: '🚧', url: './?apri=mod_viabilita&sez=verifica' };
}

export async function main(opz = {}) {
  const env = opz.env || process.env;
  if (!chiaveServizio(env)) { console.log('::warning::Push viabilita\' NON attive: manca il segreto FIREBASE_SERVICE_ACCOUNT'); return { saltato: true }; }
  const ora = opz.ora || Date.now(), o = Object.assign({}, opz, { env });
  const impo = (await leggiCollezione('impostazioni', o)) || [], mod = impo.find(x => x.id === 'moduli');
  if (!mod || !(mod.campi.attivi && mod.campi.attivi.viabilita === true)) { console.log('Modulo Viabilita\' non attivo: niente da fare.'); return { spento: true }; }
  const nuove = daNotificare(await leggiCollezione('moduli_dati/viabilita/segnalazioni', o), ora);
  if (!nuove.length) { console.log('Nessuna segnalazione nuova da verificare.'); return { inviate: 0 }; }
  const dest = destinatari((await leggiCollezione('ruoli', o)) || [], (impo.find(x => x.id === 'permessi') || {}).campi, 'viabilita');
  if (!dest.length) { console.log('Nessun utente con il livello «scrivi» sul modulo: niente da avvisare.'); return { inviate: 0 }; }
  try {
    const e = await inviaPush(messaggio(nuove), Object.assign({}, o, { soloEmail: dest }));
    console.log(`Push viabilita': ${nuove.length} segnalazioni, ${e.inviati}/${e.dispositivi} dispositivi, ${e.rimossi} rimossi`);
  } catch (e) { console.log('::error::Push viabilita\' non inviata: ' + e.message); process.exitCode = 1; return { errori: 1 }; }   // si riprova alla prossima esecuzione
  for (const s of nuove) await aggiornaCampi('moduli_dati/viabilita/segnalazioni', s.id, { notificata: true }, o);
  return { inviate: 1, segnalazioni: nuove.length };
}
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) await main();
