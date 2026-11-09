// Notifica push (Firebase Cloud Messaging) dei NUOVI avvisi della bacheca dell'app, anche ad app chiusa.
// Gira su GitHub Actions (.github/workflows/bacheca-push.yml) ogni pochi minuti: legge la raccolta Firestore «bacheca_avvisi» con l'account di servizio,
// manda una push a tutti i dispositivi registrati (tranne a quelli di chi ha pubblicato l'avviso) e ricorda in «impostazioni/bacheca_push» quali avvisi ha già notificato.
// Le chiamate di attivazione ricevono un solo sollecito, dopo 30 minuti, verso chi non ha ancora risposto (con la sveglia entro la prima ora).
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

// Sollecito delle chiamate di attivazione: tra 30 e 120 minuti dalla pubblicazione, una sola volta, a chi non ha ancora risposto.
export const SOLLECITO_DOPO_MS = 30 * 60 * 1000, SOLLECITO_ENTRO_MS = 120 * 60 * 1000, SOLLECITO_SVEGLIA_MS = 60 * 60 * 1000;
export function daSollecitare(avvisi, notificati, stato, ora = Date.now(), oggi = oggiIso()) {
  const gia = new Set(Array.isArray(stato && stato.sollecitati) ? stato.sollecitati : []), avvisati = new Set(notificati || []);
  return avvisi.filter(a => {
    const c = a.campi || {}, t = Date.parse(c.creato || '');
    return c.chiamata === true && c.titolo && avvisati.has(a.id) && !gia.has(a.id) && !(c.scade && String(c.scade) < oggi)
      && !isNaN(t) && ora - t >= SOLLECITO_DOPO_MS && ora - t <= SOLLECITO_ENTRO_MS;
  });
}
// email di chi ha già risposto a un avviso (qualunque risposta)
export function hannoRisposto(risposte, avvisoId) {
  return [...new Set((risposte || []).filter(r => (r.campi || {}).avvisoId === avvisoId).map(r => String((r.campi || {}).utente || '').toLowerCase()).filter(Boolean))];
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
      const e = await inviaPush({ titolo: (chiamata ? 'CHIAMATA DI ATTIVAZIONE · ' : urgente ? 'URGENTE · ' : 'Nuovo avviso · ') + breve(c.titolo, 80), testo: breve(c.testo, 140), tag: 'bacheca-' + a.id, icona: chiamata || urgente ? '🚨' : '📌', allarme, urgente, avvisoId: a.id }, Object.assign({}, opz, { escludiEmail: [c.creatoEmail] }));
      console.log(`Push avviso «${breve(c.titolo, 40)}»: ${e.inviati}/${e.dispositivi} dispositivi, ${e.rimossi} rimossi`);
      inviate++;
    } catch (e) {
      errori++; console.log('::error::Push avviso non inviata: ' + e.message);
      const i = notificati.indexOf(a.id); if (i >= 0) notificati.splice(i, 1);   // si riprova alla prossima esecuzione
    }
  }
  // sollecito di chi non ha risposto alle chiamate di attivazione
  const ora = opz.ora || Date.now(), sollecitati = (Array.isArray(stato && stato.sollecitati) ? stato.sollecitati : []).filter(id => avvisi.some(a => a.id === id));
  let solleciti = 0;
  const daSoll = primo ? [] : daSollecitare(avvisi, notificati, stato, ora, opz.oggi);
  if (daSoll.length) {
    const risposte = (await leggiCollezione('bacheca_risposte', opz)) || [];
    for (const a of daSoll) {
      const c = a.campi, risp = hannoRisposto(risposte, a.id), allarme = ora - Date.parse(c.creato) <= SOLLECITO_SVEGLIA_MS;
      try {
        const e = await inviaPush({ titolo: 'CHIAMATA DI ATTIVAZIONE · NON HAI ANCORA RISPOSTO · ' + breve(c.titolo, 60), testo: breve(c.testo, 120) || 'Apri l\'app e rispondi «Ci sono» o «Non ci sono».', tag: 'bacheca-' + a.id, icona: '🚨', allarme, urgente: true, avvisoId: a.id }, Object.assign({}, opz, { escludiEmail: risp.concat([c.creatoEmail]) }));
        console.log(`Sollecito chiamata «${breve(c.titolo, 40)}»: ${e.inviati}/${e.dispositivi} dispositivi (hanno già risposto ${risp.length})`);
        sollecitati.push(a.id); solleciti++;
      } catch (e) { errori++; console.log('::error::Sollecito non inviato: ' + e.message); }
    }
  }
  if (primo || inviate || errori || solleciti || !stato || (stato.notificati || []).length !== notificati.length || (stato.sollecitati || []).length !== sollecitati.length) await scriviDocumento('impostazioni', 'bacheca_push', { notificati, sollecitati, aggiornato: new Date().toISOString() }, opz);
  console.log(primo ? `Primo avvio: ${notificati.length} avvisi esistenti registrati, nessuna notifica.` : `Avvisi nuovi: ${invia.length}, notifiche inviate: ${inviate}.`);
  if (errori) process.exitCode = 1;
  return { inviate, errori, primo, solleciti };
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) await main();
