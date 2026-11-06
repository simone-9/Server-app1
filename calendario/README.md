# Calendario – Protezione Civile Curtarolo

Ogni 15 minuti una GitHub Action legge gli eventi del calendario dell'app (esercitazioni, manifestazioni, prevenzioni) e:

1. crea il file **`calendario.ics`** e lo pubblica con GitHub Pages: gli utenti vi si abbonano dall'app («La mia area») e il loro calendario (Apple, Outlook, ecc.) si aggiorna da solo;
2. (facoltativo) li riporta nel **Google Calendar** del gruppo;
3. invia il **promemoria push** la sera prima di ogni evento ai dispositivi registrati nell'app.

Il repository è pubblico: non contiene password né chiavi (l'account di servizio sta solo nei *Secrets* del repository).
Il file `calendario.ics` è leggibile da chiunque conosca l'indirizzo.

Istruzioni di configurazione: vedi [LEGGIMI.md](LEGGIMI.md).

## Licenza

© 2026 Simone Sabbadin. **Tutti i diritti riservati.** Il software non è open source. È concesso in uso gratuito, solo per scopi non commerciali, al gruppo di Protezione Civile di Curtarolo e al Comune di Curtarolo. Per ogni altro uso (copia, modifica, redistribuzione, uso commerciale) serve il permesso scritto dell'autore. Testo completo nel file [LICENSE](LICENSE).

I dati ARPAV Veneto (CC BY 4.0) e dell'Osservatorio delle Alpi Orientali (Italian Open Data License, IODL v2.0) restano soggetti alle loro licenze e vanno citati come fonte.
