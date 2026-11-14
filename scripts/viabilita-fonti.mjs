// Modulo «Viabilita'» dell'app 1: legge le fonti esterne e ne ricava segnalazioni «da confermare» (moduli_dati/viabilita/segnalazioni).
//  - TomTom (incidenti stradali nel raggio indicato): segreto TOMTOM_API_KEY, attivo se nelle impostazioni del modulo c'e' «tomtom»
//  - Waze for Cities (segnalazioni degli utenti, ricezione): segreto WAZE_FEED_URL (indirizzo del feed assegnato al Comune), attivo se c'e' «wazeIn».
//    ATTENZIONE: il formato del feed Waze qui sotto (alerts[].uuid/type/subtype/street/location{x,y}/pubMillis) e' quello consueto dei feed Waze for Cities,
//    ma non e' stato provato su un feed reale: alla prima attivazione va controllato (prove/viabilita.test.mjs usa un esempio inventato).
// Le segnalazioni non diventano mai punti della mappa da sole: le conferma la sala. Le proposte non confermate scadono dopo «scadenzaOre».
// Gira su GitHub Actions (.github/workflows/viabilita.yml). Senza segreto FIREBASE_SERVICE_ACCOUNT, o a modulo spento, non fa nulla.
import { chiaveServizio, leggiCollezione, aggiornaCampi } from './push.mjs';

const TT_TIPO = { 8: 'chiusa', 7: 'critico', 11: 'acqua', 1: 'pericolo', 14: 'pericolo', 3: 'pericolo', 10: 'pericolo', 2: 'pericolo', 5: 'pericolo' };   // iconCategory TomTom -> tipo (code, lavori e pioggia si ignorano)
const TT_NOME = { 8: 'Strada chiusa', 7: 'Corsia chiusa', 11: 'Allagamento', 1: 'Incidente', 14: 'Veicolo in avaria', 3: 'Condizioni pericolose', 10: 'Vento forte', 2: 'Nebbia', 5: 'Ghiaccio' };
const breve = (t, n) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1).trim() + '…' : x; };
const km = (a, b, c, d) => { const R = 6371, r = Math.PI / 180, dl = (c - a) * r, dg = (d - b) * r, h = Math.sin(dl / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
export function riquadro(lat, lon, raggioKm) { const dl = raggioKm / 111.32, dg = raggioKm / (111.32 * Math.cos(lat * Math.PI / 180)); return [lon - dg, lat - dl, lon + dg, lat + dl]; }   // minLon,minLat,maxLon,maxLat

// ---- TomTom: risposta di incidentDetails -> segnalazioni ----
export function daTomtom(j, conf) {
  const out = [];
  for (const f of (j && j.incidents) || []) {
    const p = f.properties || {}, cat = Number(p.iconCategory), g = f.geometry || {};
    if (!TT_TIPO[cat] || !p.id) continue;
    const pts = g.type === 'Point' ? [g.coordinates] : (g.type === 'LineString' ? g.coordinates : []); if (!pts.length || !Array.isArray(pts[0])) continue;
    const [lon, lat] = pts[0]; if (!Number.isFinite(lat) || !Number.isFinite(lon) || km(conf.lat, conf.lon, lat, lon) > conf.raggioKm) continue;
    const ev = (p.events && p.events[0]) || {}, vie = Array.isArray(p.roadNumbers) ? p.roadNumbers.join(', ') : '';
    out.push({ id: 'tomtom_' + p.id, fonte: 'tomtom', tipo: TT_TIPO[cat], titolo: breve(TT_NOME[cat] + (vie ? ' ' + vie : ''), 80), strada: breve([p.from, p.to].filter(Boolean).join(' → '), 80), nota: breve(ev.description, 300), gravita: Number(p.magnitudeOfDelay) || 0, lat: +lat.toFixed(6), lon: +lon.toFixed(6), polilinea: pts.length > 1 ? pts.slice(0, 30).map(([x, y]) => `${y.toFixed(6)} ${x.toFixed(6)}`).join(' ') : '', ts: p.startTime || '' });
  }
  return out;
}
// ---- Waze for Cities: feed JSON -> segnalazioni ----
export function daWaze(j, conf) {
  const out = [];
  for (const a of (j && j.alerts) || []) {
    const t = String(a.type || ''), sub = String(a.subtype || ''), loc = a.location || {};
    const tipo = t === 'ROAD_CLOSED' ? 'chiusa' : (t === 'ACCIDENT' ? 'pericolo' : (t === 'HAZARD' || t === 'WEATHERHAZARD' ? (/FLOOD/.test(sub) ? 'acqua' : 'pericolo') : ''));
    if (!tipo || !a.uuid || !Number.isFinite(loc.y) || !Number.isFinite(loc.x) || km(conf.lat, conf.lon, loc.y, loc.x) > conf.raggioKm) continue;
    out.push({ id: 'waze_' + a.uuid, fonte: 'waze', tipo, titolo: breve(({ chiusa: 'Strada chiusa', acqua: 'Allagamento', pericolo: sub ? sub.replace(/^(HAZARD_|ACCIDENT_)/, '').replace(/_/g, ' ').toLowerCase() : 'Pericolo' })[tipo], 80), strada: breve(a.street, 80), nota: breve(a.reportDescription || sub.replace(/_/g, ' ').toLowerCase(), 300), gravita: 0, lat: +loc.y.toFixed(6), lon: +loc.x.toFixed(6), polilinea: '', ts: a.pubMillis ? new Date(a.pubMillis).toISOString() : '' });
  }
  return out;
}

// Funzione pura: dato cio' che c'e' gia' e cio' che le fonti vedono adesso, decide le scritture. Mai si toccano stato e decisioni della sala.
export function unisci(esistenti, viste, fontiLette, ora, scadenzaOre) {
  const per = new Map(esistenti.map(e => [e.id, e.campi || {}])), adesso = new Date(ora).toISOString(), scrivi = [], idVisti = new Set(viste.map(v => v.id));
  for (const v of viste) {
    const e = per.get(v.id);
    if (!e) scrivi.push({ id: v.id, campi: Object.assign({}, v, { id: undefined, stato: 'proposta', ts: v.ts || adesso, visto: adesso, creatoDa: 'Fonte ' + (v.fonte === 'waze' ? 'Waze' : 'TomTom'), inviaWaze: false }) });
    else scrivi.push({ id: v.id, campi: { visto: adesso } });
  }
  for (const [id, e] of per) {   // proposte di una fonte letta con successo e non piu' presenti: scadute dopo scadenzaOre
    if (!idVisti.has(id) && e.stato === 'proposta' && fontiLette.has(e.fonte) && ora - Date.parse(e.visto || e.ts || 0) > scadenzaOre * 3600000) scrivi.push({ id, campi: { stato: 'scaduta', scadutaIl: adesso } });
  }
  return scrivi;
}

export async function main(opz = {}) {
  const env = opz.env || process.env, f = opz.fetch || fetch;
  if (!chiaveServizio(env)) { console.log('::warning::Viabilita\' NON attiva: manca il segreto FIREBASE_SERVICE_ACCOUNT'); return { saltato: true }; }
  const ora = opz.ora || Date.now(), o = Object.assign({}, opz, { env, fetch: f });
  const mod = ((await leggiCollezione('impostazioni', o)) || []).find(x => x.id === 'moduli');
  if (!mod || !(mod.campi.attivi && mod.campi.attivi.viabilita === true)) { console.log('Modulo Viabilita\' non attivo: niente da fare.'); return { spento: true }; }
  const cfg = (((await leggiCollezione('moduli_dati/viabilita/config', o)) || []).find(x => x.id === 'impostazioni') || {}).campi || {};
  const conf = { lat: Number(cfg.lat) || 45.515, lon: Number(cfg.lon) || 11.865, raggioKm: Math.min(30, Math.max(1, Number(cfg.raggioKm) || 8)), scadenzaOre: Math.min(72, Math.max(1, Number(cfg.scadenzaOre) || 6)) };
  const viste = [], lette = new Set(); let errori = 0;
  if (cfg.tomtom === true) {
    if (!env.TOMTOM_API_KEY) console.log('::warning::TomTom attivo nelle impostazioni ma manca il segreto TOMTOM_API_KEY');
    else try {
      const campi = '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity}}}';
      const u = `https://api.tomtom.com/traffic/services/5/incidentDetails?key=${encodeURIComponent(env.TOMTOM_API_KEY)}&bbox=${riquadro(conf.lat, conf.lon, conf.raggioKm).map(x => x.toFixed(5)).join(',')}&fields=${encodeURIComponent(campi)}&language=it-IT&timeValidityFilter=present`;
      const r = await f(u); if (!r.ok) throw new Error('TomTom ' + r.status);
      viste.push(...daTomtom(await r.json(), conf)); lette.add('tomtom');
    } catch (e) { errori++; console.log('::error::TomTom non letto: ' + String(e.message).replace(/key=[^&\s]+/g, 'key=***')); }
  }
  if (cfg.wazeIn === true) {
    if (!env.WAZE_FEED_URL) console.log('::warning::Waze (ricezione) attivo nelle impostazioni ma manca il segreto WAZE_FEED_URL');
    else try { const r = await f(env.WAZE_FEED_URL); if (!r.ok) throw new Error('Waze ' + r.status); viste.push(...daWaze(await r.json(), conf)); lette.add('waze'); }
    catch (e) { errori++; console.log('::error::Waze non letto: ' + String(e.message).slice(0, 120)); }
  }
  if (!lette.size) { console.log('Nessuna fonte letta.'); if (errori) process.exitCode = 1; return { errori }; }
  const esistenti = (await leggiCollezione('moduli_dati/viabilita/segnalazioni', o)) || [];
  const scrivi = unisci(esistenti, viste, lette, ora, conf.scadenzaOre);
  for (const s of scrivi) await aggiornaCampi('moduli_dati/viabilita/segnalazioni', s.id, s.campi, o);
  const nuove = scrivi.filter(s => s.campi.stato === 'proposta').length;
  console.log(`Viabilita': ${viste.length} segnalazioni dalle fonti, ${nuove} nuove, ${scrivi.filter(s => s.campi.stato === 'scaduta').length} scadute.`);
  if (errori) process.exitCode = 1;
  return { viste: viste.length, nuove, errori };
}
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) await main();
