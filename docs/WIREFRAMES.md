# Wireframes — footVSball

Wireframe testuali delle schermate implementate (mobile portrait, max-width 480px).

## 1. Splash / Onboarding (3 slide + login)

```
┌──────────────────────────┐
│                          │
│       footVSball         │   logo display, "VS" giallo
│           ⚽             │   emoji flottante (slide 1/2/3)
│     SFIDA IL MONDO       │   titolo slide
│  Minigiochi 1v1 online…  │   testo breve
│         ● ○ ○            │   dots progresso
│  ┌────────────────────┐  │
│  │       AVANTI       │  │   CTA block
│  └────────────────────┘  │
└──────────────────────────┘
Slide 4: input nome + "INIZIA A GIOCARE" (guest login)
```

## 2. Home / Hub

```
┌──────────────────────────┐
│ (🧑1) Michele  [🪙100][💎0]│  topbar: avatar+livello, XP bar, valute
│ HOME                     │
│ ┌──────────────────────┐ │
│ │ NUOVO            🥅  │ │  card Rigori (gradiente verde)
│ │ RIGORI               │ │
│ │ Sfida ai rigori 1v1  │ │
│ └──────────────────────┘ │
│ ┌──────────────────────┐ │
│ │ IN TENDENZA      🎯  │ │  card Subbuteo (gradiente blu)
│ │ SUBBUTEO             │ │
│ └──────────────────────┘ │
│                          │
│ [🏠][🏆][👥][🛒][👤]      │  tab bar
└──────────────────────────┘
```

## 3. Pre-partita / Matchmaking

```
┌──────────────────────────┐
│           🥅             │
│         RIGORI           │
│  [   GIOCA ONLINE    ]   │
│  [   GIOCA VS BOT    ]   │
│  [      ANNULLA      ]   │
└──────────────────────────┘
Ricerca: spinner + "Ricerca avversario..." + "Nessun avversario? Entra un bot!" + Annulla
```

## 4a. Gioco — Rigori (vista tiratore)

```
┌──────────────────────────┐
│ Michele   2 - 1  CalcioBot│  HUD nomi + punteggio
│ ▓▓▓▓▓▓▓▓░░░░ (timer)     │
│    ┌────────────────┐    │
│    │   [rete/porta]  │    │  porta frontale + portiere
│    │      🧤        │    │
│    └────────────────┘    │
│        TU TIRI!          │  banner fase
│                          │
│           ⚽             │  palla: drag→su per tirare
│  Trascina dal pallone…   │  hint (assist mira sparisce dopo 2 tiri)
│ [ABBANDONA]              │
└──────────────────────────┘
Vista portiere: porta specchiata + griglia 3×3 tappabile, "TU PARI!"
Esito: banner GOL!/PARATA!/PALO!/FUORI! + replay slow-mo se spettacolare
```

## 4b. Gioco — Subbuteo

```
┌──────────────────────────┐
│ Michele   0 - 0   Bot Zoff│
│ ▓▓▓▓▓▓░░░ Turni: 23      │
│   ┌──────[porta]──────┐  │
│   │  ●    ●            │ │  dischi blu (avversario)
│   │       ●        ●   │ │
│   │        ○ palla     │ │  campo panno, vista dall'alto
│   │  ◉    ◉        ◉  │ │  dischi rossi (tuoi, bordo giallo se di turno)
│   │      [◉ portiere]  │ │
│   └──────[porta]──────┘  │
│      TOCCA A TE!         │  flick: drag da un tuo disco (freccia mira)
│ [ABBANDONA]              │
└──────────────────────────┘
```

## 5. Risultato

```
┌──────────────────────────┐
│        VITTORIA!         │  (o SCONFITTA/PAREGGIO) + confetti
│          5 - 3           │
│ [🪙+50] [⭐+100 XP] [📈+12]│  reward chips
│  [RIVINCITA] [TORNA HOME]│
└──────────────────────────┘
```

## 6. Classifica

Topbar + segmented control (Rigori | Subbuteo) + lista righe: rank, nome, Lv/W, rating Elo. Riga utente evidenziata.

## 7. Amici

"Il tuo ID" condivisibile + input aggiunta per ID + lista amici con rating per gioco.

## 8. Negozio

Griglia 2 colonne di skin pallone: swatch radiale, prezzo (🪙/💎), stati Compra/Usa/In uso. Modal conferma acquisto.

## 9. Profilo

Statistiche per gioco (W/L, rating), cambio nome, lingua IT/EN, reset account ospite (modal conferma).
