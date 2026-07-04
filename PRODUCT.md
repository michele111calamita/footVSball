# Product

## Register

product

## Users

Giocatori casual mobile (16-40), sessioni brevi (1-3 min) in mobilità o sul divano, spesso in competizione con amici. Job-to-be-done: partita lampo divertente contro un umano, salire in classifica, vantarsi del rating. Contesto: touch, una mano, schermo piccolo, attenzione frammentata.

## Product Purpose

Hub di minigiochi calcistici multiplayer 1v1 (Rigori, Subbuteo) con matchmaking istantaneo, sfide tra amici via codice, progressione (XP/monete/Elo) e cosmetici. Successo = alta rigiocabilità: "ancora una partita". Architettura modulare per aggiungere minigiochi senza refactoring.

## Brand Personality

Energico, giocoso, competitivo. "Juicy" da mobile game: ogni azione ha feedback fisico esagerato (bounce, confetti, haptics, boato della folla). Stile visivo: cartoon spinto — proporzioni buffe, colori saturi, ombre morbide, esagerazione teatrale. Il tono celebra il giocatore, mai punitivo.

## Anti-references

- Simulazione realistica (FIFA/eFootball): niente foto-realismo, niente grigi broadcast.
- Gestionali/betting app: nessuna densità da dashboard, nessuna estetica scommesse.
- Pay-to-win e dark patterns: i cosmetici non danno vantaggi; nessun timer artificiale/energia.
- UI generica da template SaaS: card tutte uguali, gradienti decorativi senza scopo.

## Design Principles

1. **Il campo è il palcoscenico** — durante il gioco l'HUD sparisce al minimo; tutto il dramma sta nella scena.
2. **Feedback fisico sempre** — ogni tocco produce reazione visiva/sonora/aptica entro 100ms.
3. **Leggibile in un colpo d'occhio** — chi tira, chi para, il punteggio: capibili in 1 secondo anche su schermo piccolo.
4. **Esagerare gli apici** — gol e parate sono momenti teatrali (slow-mo, shake, folla); il resto resta pulito.
5. **60fps prima dei dettagli** — nessun effetto vale un frame drop su fascia media.

## Accessibility & Inclusion

- `prefers-reduced-motion` rispettato (animazioni ridotte a crossfade; niente screen shake).
- Contrasto WCAG AA sull'interfaccia (non richiesto sul gameplay, ma zone/selezioni mai affidate al solo colore).
- Touch target ≥ 44px, testo scalabile (rem), safe-area iOS.
- i18n it/en dal giorno uno.
