// Notifiche push (Firebase Cloud Messaging) dalla sala operativa, anche ad app chiusa:
//  - NUOVA RICHIESTA URGENTE (priorità «1 - Alta») -> Admin, Operatori SOC e Capisquadra
//  - SQUADRA ASSEGNATA a una richiesta -> solo i volontari della squadra incaricata
//  - RAPPORTO DA COMPILARE (intervento chiuso senza rapporto di fine intervento) -> al caposquadra (o, senza caposquadra, ai componenti)
//  - PROBLEMA SEGNALATO DALLA SQUADRA su una richiesta (semaforo lampeggiante, campi problema* sulla richiesta) -> Admin e Operatori SOC; passa anche nelle ore di riposo
//  - LA SALA CHIEDE NOTIZIE (pulsante «Chiedi notizie», campo notizieChieste sulle richieste aperte) -> al caposquadra (o ai componenti); passa anche nelle ore di riposo
// Gira su GitHub Actions (.github/workflows/richieste-push.yml) ogni pochi minuti e subito quando l'app lo avvia; legge solo le richieste recenti
// (interrogazioni su creataIl / assegnataIl / chiusura) e ricorda in «impostazioni/richieste_push» cio' che ha gia' notificato.
// Richiede il segreto FIREBASE_SERVICE_ACCOUNT. Senza, non fa nulla.
import { inviaPush, chiaveServizio, leggiCollezione, interrogaDa, scriviDocumento } from './push.mjs';

const FINESTRA_MS = 3 * 3600 * 1000;         // urgenti e assegnazioni: si notifica solo se sono di meno di 3 ore fa
const FINESTRA_RAPPORTO_MS = 24 * 3600 * 1000;
const FINESTRA_PROBLEMA_MS = 3 * 3600 * 1000;  // un problema segnalato si notifica solo se e' di meno di 3 ore fa
const FINESTRA_NOTIZIE_MS = 30 * 60 * 1000;   // la domanda di notizie vale mezz'ora
const MAX_CHIAVI = 500;
const compatta = t => String(t || '').replace(/\s+/g, ' ').trim();
const breve = (t, n) => { const x = compatta(t); return x.length > n ? x.slice(0, n - 1).trim() + '…' : x; };
const sqReale = n => !!n && n !== 'Da Assegnare';
const urgente = c => String(c.priorita || '').trim().startsWith('1');
const recente = (iso, ora, finestra) => { const t = Date.parse(iso || ''); return !isNaN(t) && ora - t <= finestra && t - ora < 60000; };
const luogo = c => [c.tipo, c.indirizzo].map(compatta).filter(Boolean).join(' - ');

// Ritorna gli eventi da notificare e lo stato aggiornato. Funzione pura (provabile senza rete).
// stato = { urgenti: [id], assegnate: ['id|squadra'], rapporti: [id] } oppure null al primo avvio (si registra l'esistente senza notificare).
export function daNotificare(richieste, stato, ora = Date.now()) {
  const primo = !stato;
  const gia = { urgenti: new Set((stato && stato.urgenti) || []), assegnate: new Set((stato && stato.assegnate) || []), rapporti: new Set((stato && stato.rapporti) || []), notizie: new Set((stato && stato.notizie) || []), problemi: new Set((stato && stato.problemi) || []) };
  const nuovi = { urgenti: [], assegnate: [], rapporti: [], notizie: [], problemi: [] }, eventi = [];
  for (const r of richieste) {
    const c = r.campi || {}, chiusa = c.stato === 'Completato';
    if (urgente(c) && !chiusa && recente(c.creataIl, ora, FINESTRA_MS) && !gia.urgenti.has(r.id)) { nuovi.urgenti.push(r.id); eventi.push({ tipo: 'urgente', id: r.id, c }); }
    const kP = r.id + '|' + c.problemaIl;
    if (c.problemaAperto === true && !chiusa && recente(c.problemaIl, ora, FINESTRA_PROBLEMA_MS) && !gia.problemi.has(kP)) { nuovi.problemi.push(kP); eventi.push({ tipo: 'problema', id: r.id, c }); }
    const kS = r.id + '|' + c.squadra;
    if (sqReale(c.squadra) && !chiusa && recente(c.assegnataIl, ora, FINESTRA_MS) && !gia.assegnate.has(kS)) { nuovi.assegnate.push(kS); eventi.push({ tipo: 'assegnata', id: r.id, c }); }
    if (chiusa && sqReale(c.squadra) && recente(c.chiusura, ora, FINESTRA_RAPPORTO_MS) && !(c.rapporto && c.rapporto.compilatoIl) && !gia.rapporti.has(r.id)) { nuovi.rapporti.push(r.id); eventi.push({ tipo: 'rapporto', id: r.id, c }); }
  }
  // una sola notifica per squadra e per domanda (la stessa ora è scritta su tutte le sue richieste aperte); non se la squadra ha già risposto
  for (const r of richieste) {
    const c = r.campi || {}, kN = c.squadra + '|' + c.notizieChieste;
    if (sqReale(c.squadra) && c.stato !== 'Completato' && recente(c.notizieChieste, ora, FINESTRA_NOTIZIE_MS) && !(Date.parse(c.ultimoContatto || '') >= Date.parse(c.notizieChieste))
        && !gia.notizie.has(kN) && !nuovi.notizie.includes(kN)) { nuovi.notizie.push(kN); eventi.push({ tipo: 'notizie', id: r.id, c }); }
  }
  const stato2 = { urgenti: [...gia.urgenti, ...nuovi.urgenti].slice(-MAX_CHIAVI), assegnate: [...gia.assegnate, ...nuovi.assegnate].slice(-MAX_CHIAVI), rapporti: [...gia.rapporti, ...nuovi.rapporti].slice(-MAX_CHIAVI), notizie: [...gia.notizie, ...nuovi.notizie].slice(-MAX_CHIAVI), problemi: [...gia.problemi, ...nuovi.problemi].slice(-MAX_CHIAVI) };
  return { eventi: primo ? [] : eventi, stato: stato2, primo };
}

// Email dei destinatari. ruoli = [{ id: email, campi: { role, volId } }], squadre = [{ id, campi: { nome, membri: [{ volId, capo }] } }]
export function destinatari(ev, ruoli, squadre) {
  const email = id => String(id || '').toLowerCase();
  if (ev.tipo === 'problema') return ruoli.filter(r => ['Admin', 'Operatore SOC'].includes(String((r.campi || {}).role || '').trim())).map(r => email(r.id));
  if (ev.tipo === 'urgente') return ruoli.filter(r => ['Admin', 'Operatore SOC', 'Caposquadra'].includes(String((r.campi || {}).role || '').trim())).map(r => email(r.id));
  const sq = squadre.find(s => (ev.c.squadraId && s.id === ev.c.squadraId) || ((s.campi || {}).nome && s.campi.nome === ev.c.squadra));
  const membri = ((sq && sq.campi && sq.campi.membri) || []).filter(m => m && m.volId);
  const scelti = (ev.tipo === 'rapporto' || ev.tipo === 'notizie') && membri.some(m => m.capo) ? membri.filter(m => m.capo) : membri;
  const vol = new Set(scelti.map(m => m.volId));
  return ruoli.filter(r => vol.has((r.campi || {}).volId)).map(r => email(r.id));
}

export function messaggio(ev) {
  const c = ev.c, id = c.id || ev.id;
  if (ev.tipo === 'urgente') return { titolo: 'URGENTE · Richiesta ' + id, testo: breve(luogo(c) + (c.descrizione ? '. ' + c.descrizione : ''), 140), tag: 'richiesta-urg-' + ev.id, icona: '🚨' };
  if (ev.tipo === 'problema') return { titolo: 'PROBLEMA · Richiesta ' + id + (sqReale(c.problemaSquadra) ? ' · Squadra ' + breve(c.problemaSquadra, 40) : ''), testo: breve((c.problemaMotivo || 'Problema segnalato') + (c.problemaNota ? ': ' + c.problemaNota : '') + ' · ' + luogo(c), 140), tag: 'richiesta-prob-' + ev.id, icona: '⚠️', urgente: true };
  if (ev.tipo === 'assegnata') return { titolo: 'Squadra ' + breve(c.squadra, 40) + ' · intervento assegnato', testo: breve(luogo(c) + (urgente(c) ? ' (priorità alta)' : ''), 140), tag: 'richiesta-sq-' + ev.id, icona: '🧑‍🚒' };
  if (ev.tipo === 'notizie') return { titolo: 'La sala chiede notizie · Squadra ' + breve(c.squadra, 40), testo: 'Rispondi via radio oppure apri l\'app e premi «Tutto ok». ' + breve(luogo(c), 90), tag: 'richiesta-not-' + ev.id, icona: '📻', urgente: true };
  return { titolo: 'Rapporto da compilare · ' + id, testo: breve(luogo(c) + ': intervento chiuso, compila il rapporto di fine intervento.', 140), tag: 'richiesta-rap-' + ev.id, icona: '📝' };
}

export async function main(opz = {}) {
  const k = chiaveServizio(opz.env || process.env);
  if (!k) { console.log('::warning::Push NON attive: manca il segreto FIREBASE_SERVICE_ACCOUNT'); return { saltato: true }; }
  const ora = opz.ora || Date.now(), iso = ms => new Date(ora - ms).toISOString();
  const per = new Map();
  for (const [campo, ms] of [['creataIl', FINESTRA_MS], ['assegnataIl', FINESTRA_MS], ['chiusura', FINESTRA_RAPPORTO_MS], ['notizieChieste', FINESTRA_NOTIZIE_MS], ['problemaIl', FINESTRA_PROBLEMA_MS]]) {
    for (const r of (await interrogaDa('emergenze', campo, iso(ms), opz)) || []) per.set(r.id, r);
  }
  const impo = (await leggiCollezione('impostazioni', opz)) || [], stato = (impo.find(x => x.id === 'richieste_push') || {}).campi || null;
  const { eventi, stato: nuovo, primo } = daNotificare([...per.values()], stato, ora);
  let inviate = 0, errori = 0;
  if (eventi.length) {
    const ruoli = (await leggiCollezione('ruoli', opz)) || [], squadre = (await leggiCollezione('squadre_operative', opz)) || [];
    for (const ev of eventi) {
      const dest = destinatari(ev, ruoli, squadre), m = messaggio(ev);
      if (!dest.length) { console.log(`Nessun utente da avvisare per ${ev.tipo} ${ev.id}.`); continue; }
      try {
        const e = await inviaPush(m, Object.assign({}, opz, { soloEmail: dest }));
        console.log(`Push ${ev.tipo} ${ev.id}: ${e.inviati}/${e.dispositivi} dispositivi, ${e.rimossi} rimossi`); inviate++;
      } catch (e) {
        errori++; console.log('::error::Push ' + ev.tipo + ' ' + ev.id + ' non inviata: ' + e.message);
        const lista = ev.tipo === 'urgente' ? nuovo.urgenti : ev.tipo === 'rapporto' ? nuovo.rapporti : ev.tipo === 'notizie' ? nuovo.notizie : ev.tipo === 'problema' ? nuovo.problemi : nuovo.assegnate, chiave = ev.tipo === 'assegnata' ? ev.id + '|' + ev.c.squadra : ev.tipo === 'notizie' ? ev.c.squadra + '|' + ev.c.notizieChieste : ev.tipo === 'problema' ? ev.id + '|' + ev.c.problemaIl : ev.id;
        const i = lista.lastIndexOf(chiave); if (i >= 0) lista.splice(i, 1);   // si riprova alla prossima esecuzione
      }
    }
  }
  if (primo || inviate || errori || !stato || JSON.stringify(nuovo) !== JSON.stringify({ urgenti: stato.urgenti || [], assegnate: stato.assegnate || [], rapporti: stato.rapporti || [], notizie: stato.notizie || [], problemi: stato.problemi || [] })) await scriviDocumento('impostazioni', 'richieste_push', Object.assign({}, nuovo, { aggiornato: new Date(ora).toISOString() }), opz);
  console.log(primo ? 'Primo avvio: richieste esistenti registrate, nessuna notifica.' : `Eventi nuovi: ${eventi.length}, notifiche inviate: ${inviate}.`);
  if (errori) process.exitCode = 1;
  return { inviate, errori, primo };
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) await main();
