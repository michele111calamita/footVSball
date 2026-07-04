# API — footVSball

Base URL: `http://<host>:2567`. REST sotto `/api`, WebSocket (Colyseus) sulla stessa porta.

## Autenticazione

Guest token. `POST /api/auth/guest` restituisce `{ user, token }`; il token va inviato:
- REST: header `Authorization: Bearer <token>`
- WebSocket: opzione `{ token }` al join della room

## REST

| Metodo | Path | Auth | Descrizione |
|---|---|---|---|
| POST | `/api/auth/guest` | — | Crea profilo ospite. Body `{ name }` → `{ user, token }` |
| GET | `/api/me` | ✔ | Profilo completo dell'utente |
| PATCH | `/api/me` | ✔ | Rinomina. Body `{ name }` |
| GET | `/api/users/:id` | — | Vista pubblica `{ id, name, level, stats }` |
| GET | `/api/leaderboard/:game` | — | `game`: `penalty` \| `subbuteo`. Query `limit` (default 50). Ordinata per rating Elo |
| GET | `/api/friends` | ✔ | Lista amici (vista pubblica) |
| POST | `/api/friends/:id` | ✔ | Aggiungi amico per ID |
| GET | `/api/shop/items` | — | Catalogo skin |
| POST | `/api/shop/buy` | ✔ | Body `{ itemId }`. Errori: `insufficient_funds`, `already_owned` |
| POST | `/api/shop/equip` | ✔ | Body `{ itemId }` (deve essere posseduto) |
| GET | `/api/health` | — | `{ ok, uptime }` |

Errori: `{ "error": "<codice>" }` con status 4xx. Rate limit: 120 req/min per IP → 429 `rate_limited`.

## WebSocket (Colyseus)

Room disponibili: `penalty`, `subbuteo`. Join:

```ts
client.joinOrCreate("penalty", { token });                 // matchmaking (bot dopo 6s)
client.create("penalty", { token, vsBot: true });          // partita privata vs bot
client.create("penalty", { token, privateMatch: true });   // sfida amico: niente bot,
                                                           // room.roomId = codice invito
client.joinById(codice, { token });                        // l'amico entra col codice
```

Le room `privateMatch` aspettano l'ospite fino a 10 minuti, poi si chiudono.

### Messaggi comuni (server → client)

| Tipo | Payload | Note |
|---|---|---|
| `match_start` | `{ gameId, players: [PlayerInfo, PlayerInfo], youAre: 0\|1 }` | |
| `match_end` | `{ winnerIdx: 0\|1\|-1, score, reason: finished\|forfeit\|disconnect, rewards }` | `rewards` null per bot/anonimi; `ratingDelta` = 0 nei match vs bot |
| `opponent_paused` | `{ graceS }` | Avversario disconnesso, partita in pausa |
| `opponent_resumed` | `{}` | |

Rate limit room: 30 messaggi/s per client (eccedenze scartate).

### Room `penalty`

Convenzioni: goal-space `tx ∈ [-1,1]` (pali), `ty ∈ [0,1]` (terra→traversa). 5 round a testa, poi oltranza.

Server → client:

| Tipo | Payload |
|---|---|
| `phase` | `{ kickIndex, round, shooterIdx, shotTimeoutMs, suddenDeath }` |
| `result` | `{ outcome: goal\|saved\|post\|out, bx, by, zoneCol, zoneRow, flightMs, shot, dive, kickIndex, score, kicksTaken }` |

Client → server:

| Tipo | Payload | Vincoli |
|---|---|---|
| `shoot` | `{ tx, ty, power: 0..1, curve: -1..1 }` | Solo il tiratore, una volta per kick; timeout → tiro debole automatico |
| `dive` | `{ col: -1\|0\|1, row: 0\|1\|2 }` | Solo il portiere, modificabile fino al tiro |

L'esito è calcolato solo dal server (`shared/penaltyLogic.resolveShot`): rumore crescente con la potenza, banda palo, probabilità di parata per distanza zona/palla. Timer ridotto nei tiri decisivi (pressione).

### Room `subbuteo`

Campo 600×900 (portrait), team 0 difende il fondo (y=900). Turni alternati, 24 flick totali max, vince chi arriva a 3 gol o è avanti allo scadere.

Server → client:

| Tipo | Payload |
|---|---|
| `board` | Snapshot statico `{ t, ball: [x,y], discs: [x,y][], moving:false }` |
| `turn` | `{ team, turnIndex, turnMs }` |
| `flick_ok` | `{ team, disc, dx, dy }` |
| `snap` | Snapshot 20Hz durante la simulazione |
| `goal` | `{ team, score }` |

Client → server:

| Tipo | Payload | Vincoli |
|---|---|---|
| `flick` | `{ disc, dx, dy }` con `|(dx,dy)| ≤ 1` | Solo di turno, solo dischi propri; timeout → flick automatico |

Fisica autoritativa (`shared/subbuteoPhysics`): 60Hz server-side, attrito panno, collisioni elastiche, sponde, bocche porta. Il client interpola tra snapshot.

## Aggiungere un minigioco

1. Logica pura in `shared/src/<game>Logic.ts` (usata da server e offline client).
2. Room in `server/src/rooms/` estendendo `BaseMatchRoom` (auth/bot/riconnessione/payout gratis).
3. `gameServer.define("<game>", Room)` in `server/src/index.ts`.
4. Scena client in `client/src/games/` + card nel hub.
