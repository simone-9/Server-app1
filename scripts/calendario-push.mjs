// Notifiche push (Firebase Cloud Messaging) del calendario attività, anche ad app chiusa:
//  - NUOVO EVENTO programmato (esercitazione, manifestazione, prevenzione...) -> a tutti gli utenti (esclusi i Monitor)
//  - PROMEMORIA 3 giorni e 1 giorno prima -> a chi non ha ancora risposto «Ci sono / Forse / Non ci sono» (il giorno prima anche a chi ha risposto «Forse»)
// Gira su GitHub Actions (.github/workflows/calendario-push.yml) ogni 15 minuti e subito quando l'app lo avvia (dopo aver programmato un evento).
// Legge solo gli eventi recenti o futuri e ricorda in «impostazioni/calendario_push» cio' che ha gia' notificato. I promemoria partono tra le 8 e le 20 (ora italiana).
// Richiede il segreto FIREBASE_SERVICE_ACCOUNT. Senza, non fa nulla.
import { inviaPush, chiaveServizio, leggiCollezione, interrogaDa, scriviDocumento } from './push.mjs';

const FINESTRA_NUOVO_MS = 24 * 3600 * 1000;   // un evento programmato da piu' di un giorno non si annuncia piu'
const GIORNI_PROMEMORIA = [3, 1];
const ORA_DA = 8, ORA_A = 20;
const MAX_CHIAVI = 500;
const compatta = t => String(t || '').replace(/\s+/g, ' ').trim();
const breve = (t, n) => { const x = compatta(t); return x.length > n ? x.slice(0, n - 1).trim() + '…' : x; };
const parti = (ora) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ora)).map(x => [x.type, x.value])); return { oggi: `${p.year}-${p.month}-${p.day}`, ore: Number(p.hour) }; };
const giorniA = (oggi, iso) => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(oggi + 'T00:00:00Z')) / 86400000);
const fine = c => (c.dataFine && c.dataFine >= c.data) ? c.dataFine : c.data;
const dataIt = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${m[3]}/${m[2]}` : ''; };
const quando = c => dataIt(c.data) + (c.ora && !c.tuttoGiorno ? ' ore ' + c.ora : '');

// Ritorna gli eventi da notificare e lo stato aggiornato. Funzione pura (provabile senza rete).
// stato = { nuovi: [id], promemoria: ['id|giorni'] } oppure null al primo avvio (si registrano gli eventi esistenti senza annunciarli).
export function daNotificare(eventi, stato, ora = Date.now()) {
  const primo = !stato, { oggi, ore } = parti(ora);
  const gia = { nuovi: new Set((stato && stato.nuovi) || []), promemoria: new Set((stato && stato.promemoria) || []) };
  const nuovi = [], promemoria = [], out = [];
  for (const e of eventi) {
    const c = e.campi || {}; if (!c.titolo || !/^\d{4}-\d{2}-\d{2}$/.test(c.data || '')) continue;
    const t = Date.parse(c.creato || ''), annunciato = !gia.nuovi.has(e.id), recente = !isNaN(t) && ora - t <= FINESTRA_NUOVO_MS && t - ora < 60000;
    let appenaAnnunciato = false;
    if (annunciato && !isNaN(t) && fine(c) >= oggi && (primo || recente)) { nuovi.push(e.id); if (!primo) { out.push({ tipo: 'nuovo', id: e.id, c }); appenaAnnunciato = true; } }
    if (primo || ore < ORA_DA || ore >= ORA_A || appenaAnnunciato) continue;
    const n = giorniA(oggi, c.data); if (!GIORNI_PROMEMORIA.includes(n)) continue;
    if (!isNaN(t) && ora - t < 12 * 3600 * 1000) continue;   // appena programmato: l'annuncio basta
    const k = e.id + '|' + n; if (gia.promemoria.has(k)) continue;
    promemoria.push(k); out.push({ tipo: 'promemoria', id: e.id, c, giorni: n });
  }
  return { eventi: out, stato: { nuovi: [...gia.nuovi, ...nuovi].slice(-MAX_CHIAVI), promemoria: [...gia.promemoria, ...promemoria].slice(-MAX_CHIAVI) }, primo };
}

// Email dei destinatari. ruoli = [{ id: email, campi: { role } }], adesioni = [{ campi: { eventoId, utente, stato } }], proposte = [{ campi: { eventoId, utente } }]
export function destinatari(ev, ruoli, adesioni, proposte) {
  const tutti = ruoli.filter(r => String((r.campi || {}).role || '').trim() !== 'Monitor').map(r => String(r.id).toLowerCase());
  if (ev.tipo === 'nuovo') return tutti;
  const risposte = new Map();
  for (const a of adesioni) { const c = a.campi || {}; if (c.eventoId === ev.id) risposte.set(String(c.utente || '').toLowerCase(), c.stato); }
  const proposti = new Set(proposte.filter(p => (p.campi || {}).eventoId === ev.id).map(p => String(p.campi.utente || '').toLowerCase()));
  return tutti.filter(em => !proposti.has(em) && (!risposte.has(em) || (ev.giorni === 1 && risposte.get(em) === 'forse')));
}

export function messaggio(ev) {
  const c = ev.c, dove = c.luogo ? ' · ' + breve(c.luogo, 40) : '';
  if (ev.tipo === 'nuovo') return { titolo: 'Nuovo evento · ' + breve(c.tipo || 'Calendario', 30), testo: breve(`${c.titolo} · ${quando(c)}${dove}. Rispondi: Ci sono / Forse / Non ci sono.`, 140), tag: 'calendario-new-' + ev.id, icona: '📅' };
  return { titolo: (ev.giorni === 1 ? 'Domani · ' : 'Tra 3 giorni · ') + breve(c.tipo || 'Evento', 30), testo: breve(`${c.titolo} · ${quando(c)}${dove}. Non hai ancora confermato: rispondi dal calendario.`, 140), tag: `calendario-ric-${ev.id}-${ev.giorni}`, icona: '⏰' };
}

export async function main(opz = {}) {
  const k = chiaveServizio(opz.env || process.env);
  if (!k) { console.log('::warning::Push NON attive: manca il segreto FIREBASE_SERVICE_ACCOUNT'); return { saltato: true }; }
  const ora = opz.ora || Date.now(), { oggi } = parti(ora), per = new Map();
  for (const [campo, da] of [['data', oggi], ['creato', new Date(ora - FINESTRA_NUOVO_MS).toISOString()]]) for (const r of (await interrogaDa('calendario_eventi', campo, da, opz)) || []) per.set(r.id, r);
  const impo = (await leggiCollezione('impostazioni', opz)) || [], stato = (impo.find(x => x.id === 'calendario_push') || {}).campi || null;
  const { eventi, stato: nuovo, primo } = daNotificare([...per.values()], stato, ora);
  let inviate = 0, errori = 0;
  if (eventi.length) {
    const ruoli = (await leggiCollezione('ruoli', opz)) || [], adesioni = (await leggiCollezione('calendario_adesioni', opz)) || [], proposte = (await leggiCollezione('calendario_proposte', opz)) || [];
    for (const ev of eventi) {
      const dest = destinatari(ev, ruoli, adesioni, proposte), m = messaggio(ev);
      if (!dest.length) { console.log(`Nessun utente da avvisare per ${ev.tipo} ${ev.id}.`); continue; }
      try {
        const e = await inviaPush(m, Object.assign({}, opz, { soloEmail: dest }));
        console.log(`Push ${ev.tipo} «${breve(ev.c.titolo, 30)}»: ${e.inviati}/${e.dispositivi} dispositivi, ${e.rimossi} rimossi`); inviate++;
      } catch (e) {
        errori++; console.log('::error::Push ' + ev.tipo + ' ' + ev.id + ' non inviata: ' + e.message);
        const lista = ev.tipo === 'nuovo' ? nuovo.nuovi : nuovo.promemoria, chiave = ev.tipo === 'nuovo' ? ev.id : ev.id + '|' + ev.giorni;
        const i = lista.lastIndexOf(chiave); if (i >= 0) lista.splice(i, 1);   // si riprova alla prossima esecuzione
      }
    }
  }
  if (primo || inviate || errori || !stato || JSON.stringify(nuovo) !== JSON.stringify({ nuovi: stato.nuovi || [], promemoria: stato.promemoria || [] })) await scriviDocumento('impostazioni', 'calendario_push', Object.assign({}, nuovo, { aggiornato: new Date(ora).toISOString() }), opz);
  console.log(primo ? 'Primo avvio: eventi esistenti registrati, nessun annuncio.' : `Notifiche da inviare: ${eventi.length}, inviate: ${inviate}.`);
  if (errori) process.exitCode = 1;
  return { inviate, errori, primo };
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) await main();
