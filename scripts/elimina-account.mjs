// Elimina da Firebase Authentication gli account di un gruppo cancellato (quelli con indirizzo «...@<gruppo>.pc-gruppi.it»
// e quelli dei monitor «...@monitor.<gruppo>.pc-gruppi.it»). Gli account con un indirizzo email vero non si toccano.
// Si avvia dall'app quando un super admin elimina il gruppo, oppure a mano: Actions → «Elimina account di un gruppo».
// Sicurezza: rifiuta di lavorare su un gruppo che esiste ancora ed è attivo.
// Richiede il segreto FIREBASE_SERVICE_ACCOUNT. Nei registri compaiono solo i numeri, mai gli indirizzi.
import { pathToFileURL } from 'node:url';
import { chiaveServizio, accessToken } from './push.mjs';

const GRUPPI_RISERVATI = ['super', 'gruppi', 'admin', 'impostazioni', 'nessuno'];

export async function eliminaAccount(gruppo, opz = {}) {
  const env = opz.env || process.env, f = opz.fetch || fetch, log = opz.log || console.log;
  const g = String(gruppo || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,29}$/.test(g) || GRUPPI_RISERVATI.includes(g)) throw new Error('Codice del gruppo non valido');
  if (String(opz.conferma ?? env.CONFERMA ?? '').trim().toLowerCase() !== 'si') throw new Error('Manca la conferma: scrivi «si» nel campo conferma');
  const k = chiaveServizio(env); if (!k) throw new Error('Manca il segreto FIREBASE_SERVICE_ACCOUNT');
  const tok = await accessToken(k, f), h = { authorization: 'Bearer ' + tok };
  // il gruppo deve essere già stato eliminato (o almeno disattivato)
  const rg = await f(`https://firestore.googleapis.com/v1/projects/${k.project_id}/databases/(default)/documents/gruppi/${g}`, { headers: h });
  if (rg.ok) { const j = await rg.json().catch(() => ({})); const att = j.fields && j.fields.attivo; if (!att || att.booleanValue !== false) throw new Error('Il gruppo esiste ancora ed è attivo: non elimino i suoi account'); }
  else if (rg.status !== 404) throw new Error('Lettura del gruppo non riuscita (' + rg.status + ')');
  const suff = ['@' + g + '.pc-gruppi.it', '@monitor.' + g + '.pc-gruppi.it'];
  const ids = []; let pag = '';
  do {
    const r = await f(`https://identitytoolkit.googleapis.com/v1/projects/${k.project_id}/accounts:batchGet?maxResults=1000${pag}`, { headers: h });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Elenco degli account non riuscito (' + r.status + '): ' + JSON.stringify(j).slice(0, 200));
    (j.users || []).forEach(u => { const e = String(u.email || '').toLowerCase(); if (u.localId && suff.some(s => e.endsWith(s))) ids.push(u.localId); });
    pag = j.nextPageToken ? '&nextPageToken=' + encodeURIComponent(j.nextPageToken) : '';
  } while (pag);
  let cancellati = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const r = await f(`https://identitytoolkit.googleapis.com/v1/projects/${k.project_id}/accounts:batchDelete`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ localIds: ids.slice(i, i + 500), force: true }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Cancellazione non riuscita (' + r.status + '): ' + JSON.stringify(j).slice(0, 200));
    cancellati += ids.slice(i, i + 500).length - ((j.errors || []).length);
  }
  log(`Gruppo ${g}: ${ids.length} account trovati, ${cancellati} cancellati.`);
  return { trovati: ids.length, cancellati };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  eliminaAccount(process.env.GRUPPO_ID).then(() => process.exit(0)).catch(e => { console.error('::error::' + (e.message || e)); process.exit(1); });
}
