import type { Client } from "@colyseus/core";
import { PENALTY } from "../../../shared/src/constants";
import { botDive, botShot, clamp, resolveShot } from "../../../shared/src/penaltyLogic";
import type { Dive, PenaltyPhaseMsg, PenaltyResultMsg, Shot } from "../../../shared/src/types";
import { BaseMatchRoom } from "./BaseMatchRoom";

/**
 * Penalty shootout, authoritative. 5 rounds each (A shoots, then B), sudden
 * death on tie. Keeper commits a dive zone any time before the shot lands;
 * the server resolves the outcome — clients only animate what they are told.
 */
export class PenaltyRoom extends BaseMatchRoom {
  readonly gameId = "penalty" as const;

  kickIndex = 0; // 0-based; shooter = kickIndex % 2
  score: [number, number] = [0, 0];
  kicksTaken: [number, number] = [0, 0];
  pendingDive: Dive | null = null;
  shotReceived = false;
  paused = false;
  private shotTimer: ReturnType<typeof setTimeout> | null = null;

  protected onMatchStart(): void {
    this.clock.setTimeout(() => this.nextKick(), 1500);
  }

  protected currentScore(): [number, number] {
    return this.score;
  }

  private get shooterIdx(): 0 | 1 {
    return (this.kickIndex % 2) as 0 | 1;
  }

  private get round(): number {
    return Math.floor(this.kickIndex / 2) + 1;
  }

  private get suddenDeath(): boolean {
    return this.round > PENALTY.ROUNDS;
  }

  /** "Pressure" rule: decisive kicks get a shorter timer. */
  private shotTimeoutMs(): number {
    const decisive = this.suddenDeath || (this.round >= 4 && Math.abs(this.score[0] - this.score[1]) <= 1);
    return decisive ? PENALTY.SHOT_TIMEOUT_PRESSURE_MS : PENALTY.SHOT_TIMEOUT_MS;
  }

  private nextKick(): void {
    if (this.ended) return;
    this.pendingDive = null;
    this.shotReceived = false;

    const msg: PenaltyPhaseMsg = {
      kickIndex: this.kickIndex,
      round: this.round,
      shooterIdx: this.shooterIdx,
      shotTimeoutMs: this.shotTimeoutMs(),
      suddenDeath: this.suddenDeath,
    };
    this.broadcastMsg("phase", msg);

    const shooter = this.seats[this.shooterIdx];
    const keeper = this.seats[1 - this.shooterIdx];

    // Bot behaviour.
    if (keeper.info.isBot) this.pendingDive = botDive();
    if (shooter.info.isBot) {
      this.clock.setTimeout(() => this.resolve(botShot()), 1800 + Math.random() * 1500);
      return;
    }

    // AFK shooter: auto weak shot at the timeout.
    this.shotTimer = setTimeout(() => {
      if (!this.shotReceived && !this.ended && !this.paused) {
        this.resolve({ tx: 0, ty: 0.2, power: 0.25, curve: 0 });
      }
    }, this.shotTimeoutMs() + 800); // client timer + network slack
  }

  protected handleGameMessage(client: Client, type: string, message: any): void {
    const idx = this.seatIndexOf(client);
    if (idx === -1 || this.paused) return;

    if (type === "dive" && idx !== this.shooterIdx && !this.shotReceived) {
      const col = Number(message?.col), row = Number(message?.row);
      if (![-1, 0, 1].includes(col) || ![0, 1, 2].includes(row)) return;
      this.pendingDive = { col: col as -1 | 0 | 1, row: row as 0 | 1 | 2 };
      return;
    }

    if (type === "shoot" && idx === this.shooterIdx && !this.shotReceived) {
      const shot: Shot = {
        tx: clamp(Number(message?.tx) || 0, -1.5, 1.5),
        ty: clamp(Number(message?.ty) || 0, 0, 1.5),
        power: clamp(Number(message?.power) || 0, 0, 1),
        curve: clamp(Number(message?.curve) || 0, -1, 1),
      };
      this.resolve(shot);
    }
  }

  private resolve(shot: Shot): void {
    if (this.shotReceived || this.ended) return;
    this.shotReceived = true;
    if (this.shotTimer) clearTimeout(this.shotTimer);

    const result = resolveShot(shot, this.pendingDive);
    if (result.outcome === "goal") this.score[this.shooterIdx]++;
    this.kicksTaken[this.shooterIdx]++;

    const msg: PenaltyResultMsg = {
      ...result,
      kickIndex: this.kickIndex,
      score: [...this.score] as [number, number],
      kicksTaken: [...this.kicksTaken] as [number, number],
    };
    this.broadcastMsg("result", msg);

    const spectacular = (result.outcome === "goal" || result.outcome === "saved") && result.shot.power > 0.65;
    const pauseMs = spectacular ? 6500 : PENALTY.RESULT_PAUSE_MS;

    this.clock.setTimeout(() => {
      if (this.isDecided()) {
        const winner = this.score[0] > this.score[1] ? 0 : 1;
        this.endMatch(winner, this.score, "finished");
      } else {
        this.kickIndex++;
        this.nextKick();
      }
    }, result.flightMs + pauseMs);
  }

  /** Standard shootout math: decided early if unreachable, else after even kicks. */
  private isDecided(): boolean {
    const [a, b] = this.score;
    const [ka, kb] = this.kicksTaken;
    if (!this.suddenDeath) {
      const remA = PENALTY.ROUNDS - ka;
      const remB = PENALTY.ROUNDS - kb;
      if (a > b + remB || b > a + remA) return true;
      if (ka === PENALTY.ROUNDS && kb === PENALTY.ROUNDS && a !== b) return true;
      return false;
    }
    // Sudden death: after both kicked in the pair, unequal score ends it.
    return ka === kb && a !== b;
  }

  protected override onOpponentPaused(seat: any): void {
    this.paused = true;
    if (this.shotTimer) clearTimeout(this.shotTimer);
    super.onOpponentPaused(seat);
  }

  protected override onOpponentResumed(seat: any): void {
    this.paused = false;
    super.onOpponentResumed(seat);
    // Restart the current kick cleanly for both.
    this.clock.setTimeout(() => this.nextKick(), 1000);
  }
}
