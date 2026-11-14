// Modulo «Viabilita'» dell'app 1: costruisce il feed per Waze for Cities (formato CIFS, JSON) con le CHIUSURE STRADALI che la sala ha confermato
// e per cui ha scelto «Invia a Waze» (moduli_dati/viabilita/segnalazioni: stato «confermata», tipo «chiusa», inviaWaze = true, con inizio e fine del tratto).
// Non si inviano mai le segnalazioni che arrivano da Waze stesso. Il file viene scritto in waze-feed/cifs.json; il workflow lo pubblica sul ramo «waze-feed»
// (indirizzo del feed: https://raw.githubusercontent.com/<utente>/<repository>/waze-feed/cifs.json), da indicare nel Partner Hub di Waze quando il Comune e' accettato.
// Campi usati (specifica CIFS): id, type ROAD_CLOSED, subtype, polyline (coppie «lat lon» separate da spazi), street, direction, starttime (ISO 8601 con fuso), description.
// DA CONTROLLARE con la specifica CIFS ufficiale prima del primo invio reale: valori ammessi di «subtype» (qui ROAD_CLOSED_HAZARD) e validazione dello schema da Partner Hub.
// Waze richiede: tratto di almeno 30 m e al massimo 20 km, nome della strada; inizio da non cambiare finche' la chiusura e' attiva (qui: ora di conferma).
import { mkdirSync, writeFileSync } from 'node:fs';
import { chiaveServizio, leggiCollezione } from './push.mjs';

const km = (a, b, c, d) => { const R = 6371, r = Math.PI / 180, dl = (c - a) * r, dg = (d - b) * r, h = Math.sin(dl / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
export function coppie(poli) { const n = String(poli || '').trim().split(/\s+/).map(Number); if (n.length < 4 || n.length % 2 || !n.every(Number.isFinite)) return null; const out = []; for (let i = 0; i < n.length; i += 2) out.push([n[i], n[i + 1]]); return out; }
export function fusoIso(iso) { const d = new Date(iso); return isNaN(d) ? '' : d.toISOString().replace(/\.\d{3}Z$/, '+00:00'); }
// Funzione pura: segnalazioni (come [{ id, campi }]) -> feed CIFS e motivi degli scarti.
export function costruisciFeed(segnalazioni, ora = Date.now()) {
  const incidents = [], scartate = [];
  for (const s of segnalazioni) {
    const c = s.campi || {};
    if (c.stato !== 'confermata' || c.tipo !== 'chiusa' || c.inviaWaze !== true || c.fonte === 'waze') continue;
    const p = coppie(c.polilinea), via = String(c.strada || '').trim();
    if (!p) { scartate.push([s.id, 'manca il tratto (inizio e fine)']); continue; }
    if (!via) { scartate.push([s.id, 'manca il nome della strada']); continue; }
    let lung = 0; for (let i = 1; i < p.length; i++) lung += km(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
    if (lung < 0.03) { scartate.push([s.id, 'tratto sotto i 30 metri']); continue; }
    if (lung > 20) { scartate.push([s.id, 'tratto oltre i 20 km']); continue; }
    const inizio = fusoIso(c.confermataIl || c.ts) || fusoIso(new Date(ora));
    incidents.push({ id: s.id, type: 'ROAD_CLOSED', subtype: 'ROAD_CLOSED_HAZARD', description: String(c.titolo || c.nota || 'Strada chiusa').replace(/\s+/g, ' ').trim().slice(0, 40), street: via.slice(0, 80), polyline: p.map(x => x[0].toFixed(6) + ' ' + x[1].toFixed(6)).join(' '), direction: 'BOTH_DIRECTIONS', starttime: inizio, creationtime: fusoIso(c.ts) || inizio, updatetime: fusoIso(new Date(ora)) });
  }
  return { feed: { incidents }, scartate };
}
export async function main(opz = {}) {
  const env = opz.env || process.env, uscita = env.FEED_OUT || 'waze-feed/cifs.json';
  if (!chiaveServizio(env)) { console.log('::warning::Feed Waze NON attivo: manca il segreto FIREBASE_SERVICE_ACCOUNT'); return { saltato: true }; }
  const o = Object.assign({}, opz, { env });
  const mod = ((await leggiCollezione('impostazioni', o)) || []).find(x => x.id === 'moduli');
  const cfg = (((await leggiCollezione('moduli_dati/viabilita/config', o)) || []).find(x => x.id === 'impostazioni') || {}).campi || {};
  if (!mod || !(mod.campi.attivi && mod.campi.attivi.viabilita === true) || cfg.wazeOut !== true) { console.log('Invio a Waze non attivo: nessun feed.'); return { spento: true }; }
  const { feed, scartate } = costruisciFeed((await leggiCollezione('moduli_dati/viabilita/segnalazioni', o)) || [], opz.ora || Date.now());
  scartate.forEach(([id, m]) => console.log(`::warning::Chiusura ${id} non inviata a Waze: ${m}`));
  mkdirSync(uscita.replace(/\/[^/]*$/, '') || '.', { recursive: true }); writeFileSync(uscita, JSON.stringify(feed, null, 1) + '\n');
  console.log(`Feed Waze: ${feed.incidents.length} chiusure in ${uscita}.`);
  return { chiusure: feed.incidents.length };
}
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) await main();
