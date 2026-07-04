import { PENALTY } from "../../../shared/src/constants";
import { botDive, botShot, resolveShot } from "../../../shared/src/penaltyLogic";
import type { Dive, PenaltyPhaseMsg, PenaltyResultMsg, PlayerInfo, Shot } from "../../../shared/src/types";
import { session } from "../state";
import { LocalChannelBase } from "../net/channel";

/** Offline penalty vs bot — mirrors PenaltyRoom's protocol with shared rules. */
export class LocalPenaltyChannel extends LocalChannelBase {
  private kickIndex = 0;
  private score: [number, number] = [0, 0];
  private kicksTaken: [number, number] = [0, 0];
  private pendingDive: Dive | null = null;
  private shotReceived = false;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor() {
    super();
    const me: PlayerInfo = {
      id: session.user?.id ?? "local",
      name: session.user?.name ?? "Player",
      level: session.user?.level ?? 1,
      rating: session.user?.stats.penalty.rating ?? 1000,
      isBot: false,
      ballSkin: session.user?.ballSkin,
    };
    const bot: PlayerInfo = { id: "bot", name: "CalcioBot", level: 3, rating: 1000, isBot: true };
    this.emit("match_start", { gameId: "penalty", players: [me, bot], youAre: 0 });
    this.after(1500, () => this.nextKick());
  }

  private get shooterIdx(): 0 | 1 {
    return (this.kickIndex % 2) as 0 | 1;
  }

  private get suddenDeath(): boolean {
    return Math.floor(this.kickIndex / 2) + 1 > PENALTY.ROUNDS;
  }

  private nextKick(): void {
    this.pendingDive = null;
    this.shotReceived = false;
    const msg: PenaltyPhaseMsg = {
      kickIndex: this.kickIndex,
      round: Math.floor(this.kickIndex / 2) + 1,
      shooterIdx: this.shooterIdx,
      shotTimeoutMs: this.suddenDeath ? PENALTY.SHOT_TIMEOUT_PRESSURE_MS : PENALTY.SHOT_TIMEOUT_MS,
      suddenDeath: this.suddenDeath,
    };
    this.emit("phase", msg);

    if (this.shooterIdx === 1) {
      // Bot shoots, human keeps.
      this.after(2000 + Math.random() * 1500, () => this.resolve(botShot()));
    } else {
      this.pendingDive = botDive();
      this.after(PENALTY.SHOT_TIMEOUT_MS + 800, () => {
        if (!this.shotReceived) this.resolve({ tx: 0, ty: 0.2, power: 0.25, curve: 0 });
      });
    }
  }

  override send(type: string, payload?: any): void {
    if (type === "shoot" && this.shooterIdx === 0 && !this.shotReceived) {
      this.resolve(payload as Shot);
    } else if (type === "dive" && this.shooterIdx === 1 && !this.shotReceived) {
      this.pendingDive = payload as Dive;
    }
  }

  private resolve(shot: Shot): void {
    if (this.shotReceived || this.closed) return;
    this.shotReceived = true;
    const result = resolveShot(shot, this.pendingDive);
    if (result.outcome === "goal") this.score[this.shooterIdx]++;
    this.kicksTaken[this.shooterIdx]++;
    const msg: PenaltyResultMsg = {
      ...result,
      kickIndex: this.kickIndex,
      score: [...this.score] as [number, number],
      kicksTaken: [...this.kicksTaken] as [number, number],
    };
    this.emit("result", msg);
    this.after(result.flightMs + PENALTY.RESULT_PAUSE_MS, () => {
      if (this.isDecided()) {
        const winnerIdx = this.score[0] > this.score[1] ? 0 : 1;
        this.emit("match_end", { winnerIdx, score: this.score, reason: "finished", rewards: null });
      } else {
        this.kickIndex++;
        this.nextKick();
      }
    });
  }

  private isDecided(): boolean {
    const [a, b] = this.score;
    const [ka, kb] = this.kicksTaken;
    if (!this.suddenDeath) {
      if (a > b + (PENALTY.ROUNDS - kb) || b > a + (PENALTY.ROUNDS - ka)) return true;
      return ka === PENALTY.ROUNDS && kb === PENALTY.ROUNDS && a !== b;
    }
    return ka === kb && a !== b;
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(() => { if (!this.closed) fn(); }, ms));
  }

  protected override dispose(): void {
    this.timers.forEach(clearTimeout);
  }
}
