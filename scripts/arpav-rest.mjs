// Completa i livelli del file aperto ARPAV (Ultime48ore.xml) con il servizio usato dai grafici del sito ARPAV
// (api.arpa.veneto.it/REST/v1), che di solito è più aggiornato: a volte il file XML resta indietro di una o due ore.
// Il file XML resta la base: dal servizio si aggiungono solo le misure più recenti dell'ultima presente nel file.
// Se il servizio non risponde o cambia formato non succede nulla (si usa il solo XML, come prima).
// È un servizio interno del sito, non un dato aperto documentato: per questo ogni errore viene solo annotato nel registro.
export const REST = (process.env.ARPAV_REST_URL || 'https://api.arpa.veneto.it/REST/v1').replace(/\/$/, '');
const ORA = 3600000, FINESTRA = 49 * ORA;

// «2026-11-10T15:20:00» in ora solare (UTC+1, come tutto ARPAV) -> millisecondi
export function tempoRest(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - ORA : NaN;
}
// codice della stazione (IDSTAZ) che contiene il sensore «id» nel file XML
export function idstazDi(xml, id) {
  const m = new RegExp('<ID>\\s*' + id + '\\s*</ID>').exec(xml || ''); if (!m) return null;
  const s = xml.lastIndexOf('<STAZIONE>', m.index); if (s < 0) return null;
  const x = /<IDSTAZ>\s*(\d+)\s*<\/IDSTAZ>/.exec(xml.slice(s, m.index));
  return x ? Number(x[1]) : null;
}
// aggiunge alla serie [[ms, valore]] le misure più recenti dell'ultima; tiene circa 48 ore
export function unisci(serie, nuovi) {
  const base = Array.isArray(serie) ? serie : [], ult = base.length ? base[base.length - 1][0] : -Infinity;
  const visti = new Set(), agg = [];
  for (const [t, v] of nuovi || []) if (isFinite(t) && isFinite(v) && t > ult && !visti.has(t)) { visti.add(t); agg.push([t, v]); }
  agg.sort((a, b) => a[0] - b[0]);
  const tutti = base.concat(agg), fine = tutti.length ? tutti[tutti.length - 1][0] : 0;
  return { serie: tutti.filter(([t]) => t >= fine - FINESTRA), aggiunti: agg.length };
}
// righe del servizio -> serie del sensore scelto (livello: «Livello idrometrico 1» se ce n'è più d'uno)
export function serieDa(righe, tipo) {
  const l = (righe || []).filter(r => r && r.tipo === tipo);
  const nomi = [...new Set(l.map(r => r.nome_sensore))];
  const nome = nomi.find(n => /\b1\b/.test(String(n))) || nomi[0];
  return l.filter(r => r.nome_sensore === nome).map(r => [tempoRest(r.dataora), parseFloat(String(r.valore).replace(',', '.'))]).filter(([t, v]) => isFinite(t) && isFinite(v));
}

async function json(url, f, ms) {
  const r = await f(url + (url.includes('?') ? '&' : '?') + 'rnd=' + Math.random(), { headers: { 'User-Agent': 'idrometria-protezione-civile-curtarolo', Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('risposta ' + r.status);
  const j = await r.json();
  if (!j || j.success === false || !Array.isArray(j.data)) throw new Error('formato inatteso');
  return j.data;
}

// st = stazioni del file idro.json ({ nome, ids, dati, q }); le modifica sul posto. Ritorna un riepilogo.
export async function integraDaRest(st, opz = {}) {
  const f = opz.fetch || fetch, log = opz.log || console.log, ms = opz.timeout || 20000;
  const out = { stazioni: 0, misure: 0, errori: 0, lette: 0 };
  const con = Object.entries(st || {}).filter(([, s]) => s && s.ids);
  if (!con.length) return out;
  let elenco;
  try { elenco = await json(REST + '/meteo_idroOggi', f, ms); }
  catch (e) { log('::notice::Servizio dei grafici ARPAV non letto (si usa solo il file XML): ' + (e && e.message ? e.message : e)); out.errori++; return out; }
  const cod = new Map(); for (const r of elenco) if (r && r.codice_stazione != null && r.codseqst && !cod.has(Number(r.codice_stazione))) cod.set(Number(r.codice_stazione), r.codseqst);
  for (const [id, s] of con) {
    const cs = cod.get(Number(s.ids)); if (!cs) continue;
    try {
      const righe = await json(`${REST}/meteo_meteogrammi_tabella?codseqst=${encodeURIComponent(cs)}`, f, ms); out.lette++;
      const a = unisci(s.dati, serieDa(righe, 'LIDRO')); s.dati = a.serie;
      let aq = { aggiunti: 0 };
      if (Array.isArray(s.q) && (s.q.length || s.qu)) { aq = unisci(s.q, serieDa(righe, 'PORT')); s.q = aq.serie; }
      if (a.aggiunti || aq.aggiunti) {
        out.stazioni++; out.misure += a.aggiunti + aq.aggiunti;
        const u = s.dati[s.dati.length - 1];
        log(`ARPAV (grafici del sito): ${s.nome || id} +${a.aggiunti} livelli${aq.aggiunti ? ', +' + aq.aggiunti + ' portate' : ''}, ultimo ${u ? new Date(u[0]).toISOString().slice(11, 16) + ' UTC' : '-'}`);
      }
    } catch (e) { out.errori++; log(`::notice::${s.nome || id}: servizio dei grafici ARPAV non letto (${e && e.message ? e.message : e})`); }
  }
  return out;
}
