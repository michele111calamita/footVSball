import { Client, Room } from "@colyseus/core";
import { MATCHMAKING_BOT_FALLBACK_MS, RECONNECT_GRACE_S } from "../../../shared/src/constants";
import type { GameId, MatchEndMsg, PlayerInfo, Rewards } from "../../../shared/src/types";
import { applyMatchResult, userById, userByToken } from "../store";

export interface Seat {
  info: PlayerInfo;
  client: Client | null; // null = bot or disconnected
  connected: boolean;
}

/**
 * Common 1v1 machinery: token auth on join, bot fallback when matchmaking
 * finds no human in time, reconnection grace, forfeit handling, and
 * economy/Elo payout on match end. Game rules live in the subclasses.
 */
export abstract class BaseMatchRoom extends Room {
  abstract readonly gameId: GameId;
  maxClients = 2;

  seats: Seat[] = [];
  started = false;
  ended = false;
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private msgCount = new Map<string, { n: number; reset: number }>();

  override async onAuth(_client: Client, options: { token?: string }) {
    const user = userByToken(options?.token);
    if (!user) throw new Error("unauthorized");
    return user;
  }

  override onCreate(options: { vsBot?: boolean; privateMatch?: boolean }): void {
    this.setSeatReservationTime(10);
    if (options?.vsBot || options?.privateMatch) this.setPrivate(true);

    this.onMessage("*", (client, type, message) => {
      if (!this.throttle(client)) return;
      if (this.ended) return;
      this.handleGameMessage(client, String(type), message);
    });

    if (options?.privateMatch) {
      // Friend challenge: no bot — wait for the invited player, but don't
      // keep the room alive forever if nobody shows up.
      this.botTimer = setTimeout(() => {
        if (!this.started) this.disconnect();
      }, 10 * 60_000);
      return;
    }

    // Bot fallback so nobody waits forever in the queue.
    const wait = options?.vsBot ? 400 : MATCHMAKING_BOT_FALLBACK_MS;
    this.botTimer = setTimeout(() => {
      if (!this.started && this.seats.length === 1) {
        this.lock();
        this.addBot();
        this.startMatch();
      }
    }, wait);
  }

  override onJoin(client: Client, _options: unknown, user: any): void {
    const info: PlayerInfo = {
      id: user.id,
      name: user.name,
      level: user.level,
      rating: user.stats[this.gameId].rating,
      isBot: false,
      ballSkin: user.ballSkin,
    };
    this.seats.push({ info, client, connected: true });
    if (this.seats.length === 2 && !this.started) {
      this.lock();
      this.startMatch();
    }
  }

  override async onLeave(client: Client, consented: boolean): Promise<void> {
    const seat = this.seats.find((s) => s.client?.sessionId === client.sessionId);
    if (!seat) return;
    seat.connected = false;
    seat.client = null;

    if (this.ended || !this.started) return;

    if (!consented) {
      try {
        // Match pauses; the game loop subclasses check seat.connected.
        this.onOpponentPaused(seat);
        const re = await this.allowReconnection(client, RECONNECT_GRACE_S);
        seat.client = re;
        seat.connected = true;
        this.onOpponentResumed(seat);
        return;
      } catch {
        /* grace expired */
      }
    }
    // Forfeit: the remaining human wins.
    const winnerIdx = this.seats.indexOf(seat) === 0 ? 1 : 0;
    this.endMatch(winnerIdx as 0 | 1, this.currentScore(), consented ? "forfeit" : "disconnect");
  }

  protected addBot(): void {
    const rating = 900 + Math.floor(Math.random() * 250);
    this.seats.push({
      info: { id: `bot_${Math.random().toString(36).slice(2, 8)}`, name: randomBotName(), level: 1 + Math.floor(Math.random() * 9), rating, isBot: true },
      client: null,
      connected: true,
    });
  }

  protected startMatch(): void {
    if (this.started) return;
    this.started = true;
    if (this.botTimer) clearTimeout(this.botTimer);
    this.seats.forEach((s, i) => {
      s.client?.send("match_start", {
        gameId: this.gameId,
        players: [this.seats[0].info, this.seats[1].info] as [PlayerInfo, PlayerInfo],
        youAre: i as 0 | 1,
      });
    });
    this.onMatchStart();
  }

  protected endMatch(winnerIdx: 0 | 1 | -1, score: [number, number], reason: MatchEndMsg["reason"]): void {
    if (this.ended) return;
    this.ended = true;

    const ranked = !this.seats.some((s) => s.info.isBot);
    this.seats.forEach((seat, i) => {
      let rewards: Rewards | null = null;
      if (!seat.info.isBot && userById(seat.info.id)) {
        const result = winnerIdx === -1 ? 0.5 : winnerIdx === i ? 1 : 0;
        const opp = this.seats[1 - i].info.rating;
        rewards = applyMatchResult(seat.info.id, this.gameId, result as 0 | 0.5 | 1, opp, ranked);
      }
      const msg: MatchEndMsg = { winnerIdx, score, reason, rewards };
      seat.client?.send("match_end", msg);
    });
    this.clock.setTimeout(() => this.disconnect(), 3000);
  }

  /** 30 msg/sec per client — flick/dive spam cannot flood the room. */
  private throttle(client: Client): boolean {
    const now = Date.now();
    const e = this.msgCount.get(client.sessionId);
    if (!e || now > e.reset) {
      this.msgCount.set(client.sessionId, { n: 1, reset: now + 1000 });
      return true;
    }
    return ++e.n <= 30;
  }

  protected seatIndexOf(client: Client): number {
    return this.seats.findIndex((s) => s.client?.sessionId === client.sessionId);
  }

  protected broadcastMsg(type: string, payload: unknown): void {
    for (const s of this.seats) s.client?.send(type, payload);
  }

  protected abstract onMatchStart(): void;
  protected abstract handleGameMessage(client: Client, type: string, message: any): void;
  protected abstract currentScore(): [number, number];
  protected onOpponentPaused(_seat: Seat): void {
    this.broadcastMsg("opponent_paused", { graceS: RECONNECT_GRACE_S });
  }
  protected onOpponentResumed(_seat: Seat): void {
    this.broadcastMsg("opponent_resumed", {});
  }
}

const BOT_NAMES = ["RoboKeeper", "CalcioBot", "Bot Baggio", "Panna Cotta", "Golazo AI", "Il Muro", "TurboTacco", "Bot Zoff"];
function randomBotName(): string {
  return BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
}
