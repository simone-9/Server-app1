// Notifica push (Firebase Cloud Messaging) dei NUOVI avvisi della bacheca dell'app, anche ad app chiusa.
// Gira su GitHub Actions (.github/workflows/bacheca-push.yml) ogni pochi minuti: legge la raccolta Firestore «bacheca_avvisi» con l'account di servizio,
// manda una push a tutti i dispositivi registrati (tranne a quelli di chi ha pubblicato l'avviso) e ricorda in «impostazioni/bacheca_push» quali avvisi ha già notificato.
// Richiede il segreto FIREBASE_SERVICE_ACCOUNT. Senza, non fa nulla.
import { inviaPush, chiaveServizio, leggiCollezione, scriviDocumento } from './push.mjs';

const MAX_ETA_MS = 24 * 3600 * 1000;
const MAX_ETA_SVEGLIA_MS = 30 * 60 * 1000;   // una chiamata di attivazione vecchia di più di mezz'ora non fa più suonare la sveglia (arriva come notifica normale)   // gli avvisi più vecchi di un giorno non si notificano (sicurezza dopo un fermo prolungato)
const compatta = t => String(t || '').replace(/\s+/g, ' ').trim();
const breve = (t, n) => { const x = compatta(t); return x.length > n ? x.slice(0, n - 1).trim() + '…' : x; };
const oggiIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());   // AAAA-MM-GG

// Ritorna gli avvisi da notificare e lo stato aggiornato. Funzione pura (provabile senza rete).
export function daNotificare(avvisi, stato, ora = Date.now(), oggi = oggiIso()) {
  const gia = new Set(Array.isArray(stato && stato.notificati) ? stato.notificati : []);
  const primo = !stato || !Array.isArray(stato.notificati);
  const ids = avvisi.map(a => a.id);
  if (primo) return { invia: [], notificati: ids, primo: true };   // primo avvio: si memorizzano gli avvisi esistenti senza notificarli
  const invia = avvisi.filter(a => {
    const c = a.campi || {}, t = Date.parse(c.creato || '');
    return !gia.has(a.id) && c.titolo && !(c.scade && String(c.scade) < oggi) && (isNaN(t) || ora - t <= MAX_ETA_MS);
  }).sort((x, y) => String((x.campi || {}).creato || '').localeCompare(String((y.campi || {}).creato || '')));
  // si ricordano solo gli avvisi ancora presenti (quelli eliminati escono dall'elenco)
  return { invia, notificati: ids.filter(id => gia.has(id) || invia.some(a => a.id === id)), primo: false };
}

export async function main(opz = {}) {
  const k = chiaveServizio(opz.env || process.env);
  if (!k) { console.log('::warning::Push NON attive: manca il segreto FIREBASE_SERVICE_ACCOUNT'); return { saltato: true }; }
  const avvisi = (await leggiCollezione('bacheca_avvisi', opz)) || [];
  const impo = (await leggiCollezione('impostazioni', opz)) || [], stato = (impo.find(x => x.id === 'bacheca_push') || {}).campi || null;
  const { invia, notificati, primo } = daNotificare(avvisi, stato, opz.ora, opz.oggi);
  let inviate = 0, errori = 0;
  for (const a of invia) {
    const c = a.campi, urgente = c.urgente === true, chiamata = c.chiamata === true, tc = Date.parse(c.creato || '');
    const allarme = chiamata && (isNaN(tc) || (opz.ora || Date.now()) - tc <= MAX_ETA_SVEGLIA_MS);
    try {
      const e = await inviaPush({ titolo: (chiamata ? 'CHIAMATA DI ATTIVAZIONE · ' : urgente ? 'URGENTE · ' : 'Nuovo avviso · ') + breve(c.titolo, 80), testo: breve(c.testo, 140), tag: 'bacheca-' + a.id, icona: chiamata || urgente ? '🚨' : '📌', allarme, avvisoId: a.id }, Object.assign({}, opz, { escludiEmail: [c.creatoEmail] }));
      console.log(`Push avviso «${breve(c.titolo, 40)}»: ${e.inviati}/${e.dispositivi} dispositivi, ${e.rimossi} rimossi`);
      inviate++;
    } catch (e) {
      errori++; console.log('::error::Push avviso non inviata: ' + e.message);
      const i = notificati.indexOf(a.id); if (i >= 0) notificati.splice(i, 1);   // si riprova alla prossima esecuzione
    }
  }
  if (primo || inviate || errori || !stato || (stato.notificati || []).length !== notificati.length) await scriviDocumento('impostazioni', 'bacheca_push', { notificati, aggiornato: new Date().toISOString() }, opz);
  console.log(primo ? `Primo avvio: ${notificati.length} avvisi esistenti registrati, nessuna notifica.` : `Avvisi nuovi: ${invia.length}, notifiche inviate: ${inviate}.`);
  if (errori) process.exitCode = 1;
  return { inviate, errori, primo };
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) await main();
