# Design System — footVSball

Direzione: **flat/vibrant con accenti "juicy"** da mobile game — bordi arrotondati spessi, ombre soffici, micro-animazioni bounce su tap. Tutto in `client/src/styles/main.css` (token → componenti → schermate), zero dipendenze UI.

## Token

| Token | Valore | Uso |
|---|---|---|
| `--green-800/900` | `#0e5c2f` / `#093f20` | Sfondo app (verde campo) |
| `--green-600` | `#1d9a4b` | Superfici secondarie, bottoni secondary |
| `--cta` | `#ff8a1e` | CTA primarie (arancio energico) |
| `--cta-2` | `#ffd23e` | Accenti, highlight, valuta |
| `--danger` | `#e6363c` | Errori, notifiche, forfeit |
| `--info` | `#2f7ddb` | Badge livello, team blu |
| `--font-display` | Bebas Neue | Titoli, punteggi, bottoni (sportivo condensato) |
| `--font-body` | Nunito | Testo (leggibile, tondo) |
| `--r-lg/md/sm` | 22/16/10px | Raggi |
| `--shadow-btn` | `0 4px 0 rgba(0,0,0,.22)` | Ombra "pressabile" 3D dei bottoni |

Font caricati da Google Fonts con fallback di sistema (offline-safe).

## Componenti

- **Button** `.btn` — primary (CTA arancio); varianti `--secondary`, `--ghost`, `--danger`, `--block`; stati `:disabled`, `--loading` (spinner integrato). Press: translate+scale (feel fisico); `.bounce` per pop.
- **Game card** `.game-card` — gradiente per gioco, emoji decorativa, badge `.badge` ("NUOVO") / `.badge--hot` ("IN TENDENZA"), scale su tap.
- **Avatar** `.avatar` — cerchio con cornice bianca + `.avatar__level` (badge livello).
- **Progress XP** `.progress` / `.progress__fill` — gradiente giallo→arancio, transizione elastica.
- **Pill valuta** `.pill` — 🪙 monete / 💎 gemme, sempre visibili nella topbar.
- **Tab bar** `.tabbar` — 5 tab (Home, Classifica, Amici, Negozio, Profilo), sticky bottom, safe-area aware.
- **Toast** `.toast` (+`--error`) — notifica in-app top-center, auto-dismiss 2.6s.
- **Modal** `.modal` — conferme (acquisti, forfeit, reset), backdrop scuro, pop-in.
- **List row** `.list-row` — classifiche/amici; `.me` evidenzia l'utente.
- **Shop item** `.shop-item` — swatch skin radiale, stati `owned`/`equipped`.
- **HUD di gioco** — `.hud-top` (nomi + punteggio display), `.hud-banner` (annunci GOL!/TU TIRI!), timer `.progress`, `.hud-quit`.

## Micro-interazioni (client/src/ui/fx.ts)

| Evento | Feedback |
|---|---|
| Tap bottoni/tab | `sfx.tap()` + scale CSS |
| Gol / parata | Haptic (`navigator.vibrate`) + SFX sintetizzati WebAudio (boato folla = noise bandpass, fischio = square 2.1kHz) |
| Vittoria | Confetti canvas full-screen + fanfara + pattern aptico |
| Tiro spettacolare | Replay slow-motion 0.45× con label REPLAY |
| Acquisto | Confetti breve + toast |

`prefers-reduced-motion` disattiva le animazioni.

## Accessibilità

- Contrasto testo/CTA verificato su sfondi verdi scuri (bianco/quasi-nero su arancio).
- Layout max-width 480px centrato: leggibile anche desktop.
- Font scalabili (rem), touch target ≥ 44px, safe-area iOS (`env(safe-area-inset-*)`).
- Nessuna informazione affidata al solo colore nelle zone di gioco (griglia zone visibile + highlight selezione).
