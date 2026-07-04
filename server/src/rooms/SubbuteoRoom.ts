import type { Client } from "@colyseus/core";
import { SUBBUTEO } from "../../../shared/src/constants";
import {
  applyFlick, atRest, botFlick, initialState, kickoff, step,
} from "../../../shared/src/subbuteoPhysics";
import type { FlickMsg, SubbuteoSnapshot, SubbuteoState, TurnMsg } from "../../../shared/src/types";
import { BaseMatchRoom } from "./BaseMatchRoom";

/**
 * Table football, authoritative. Alternating flick turns; the server runs the
 * physics at 60Hz and streams 20Hz snapshots while bodies are moving.
 * First to GOAL_TARGET or best score after MAX_TURNS.
 */
export class SubbuteoRoom extends BaseMatchRoom {
  readonly gameId = "subbuteo" as const;

  state2: SubbuteoState = initialState();
  score: [number, number] = [0, 0];
  turnIndex = 0;
  turnTeam: 0 | 1 = 0;
  simulating = false;
  paused = false;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private simInterval: ReturnType<typeof setInterval> | null = null;

  protected onMatchStart(): void {
    this.broadcastMsg("board", this.snapshot(false));
    this.clock.setTimeout(() => this.beginTurn(), 1200);
  }

  protected currentScore(): [number, number] {
    return this.score;
  }

  private beginTurn(): void {
    if (this.ended || this.paused) return;
    const msg: TurnMsg = { team: this.turnTeam, turnIndex: this.turnIndex, turnMs: SUBBUTEO.TURN_MS };
    this.broadcastMsg("turn", msg);

    const seat = this.seats[this.turnTeam];
    if (seat.info.isBot) {
      this.clock.setTimeout(() => {
        if (!this.simulating && !this.ended) this.doFlick(this.turnTeam, botFlick(this.state2, this.turnTeam));
      }, 1200 + Math.random() * 1300);
      return;
    }

    // AFK: pass the turn with a weak bot flick so the match keeps its rhythm.
    this.turnTimer = setTimeout(() => {
      if (!this.simulating && !this.ended && !this.paused) {
        this.doFlick(this.turnTeam, botFlick(this.state2, this.turnTeam));
      }
    }, SUBBUTEO.TURN_MS + 900);
  }

  protected handleGameMessage(client: Client, type: string, message: any): void {
    if (type !== "flick" || this.simulating || this.paused) return;
    const idx = this.seatIndexOf(client);
    if (idx !== this.turnTeam) return;

    const flick: FlickMsg = {
      disc: Math.floor(Number(message?.disc)),
      dx: Number(message?.dx) || 0,
      dy: Number(message?.dy) || 0,
    };
    // Server-side validation: ownership + magnitude are enforced in applyFlick.
    this.doFlick(idx as 0 | 1, flick);
  }

  private doFlick(team: 0 | 1, flick: FlickMsg): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    if (!applyFlick(this.state2, team, flick)) {
      // Invalid flick from a human: burn the turn (anti-stall), notify.
      this.seats[team].client?.send("flick_rejected", {});
      this.endTurn(null);
      return;
    }
    this.broadcastMsg("flick_ok", { team, ...flick });
    this.simulate();
  }

  private simulate(): void {
    this.simulating = true;
    const t0 = Date.now();
    let goal: 0 | 1 | null = null;
    let sinceSnap = 0;
    const DT = 1 / 60;
    const SNAP_EVERY = 1000 / SUBBUTEO.SNAPSHOT_HZ;

    this.simInterval = setInterval(() => {
      if (this.ended) return this.stopSim();
      // 3 physics substeps per 50ms tick ≈ real-time 60Hz.
      for (let i = 0; i < 3 && goal === null; i++) {
        const ev = step(this.state2, DT);
        if (ev.goalFor !== null) goal = ev.goalFor;
      }
      sinceSnap += 50;
      if (sinceSnap >= SNAP_EVERY) {
        sinceSnap = 0;
        this.broadcastMsg("snap", this.snapshot(true));
      }
      const timeUp = Date.now() - t0 > SUBBUTEO.SIM_MAX_MS;
      if (goal !== null || atRest(this.state2) || timeUp) {
        this.stopSim();
        this.finishSim(goal);
      }
    }, 50);
  }

  private stopSim(): void {
    if (this.simInterval) clearInterval(this.simInterval);
    this.simInterval = null;
    this.simulating = false;
  }

  private finishSim(goal: 0 | 1 | null): void {
    if (goal !== null) {
      this.score[goal]++;
      this.broadcastMsg("goal", { team: goal, score: [...this.score] });
      kickoff(this.state2);
      this.clock.setTimeout(() => {
        this.broadcastMsg("board", this.snapshot(false));
        this.endTurn(goal);
      }, 2200);
      return;
    }
    this.broadcastMsg("snap", this.snapshot(false));
    this.endTurn(null);
  }

  private endTurn(goal: 0 | 1 | null): void {
    if (this.ended) return;
    if (this.score[0] >= SUBBUTEO.GOAL_TARGET || this.score[1] >= SUBBUTEO.GOAL_TARGET) {
      return this.endMatch(this.score[0] > this.score[1] ? 0 : 1, this.score, "finished");
    }
    this.turnIndex++;
    if (this.turnIndex >= SUBBUTEO.MAX_TURNS) {
      const w = this.score[0] === this.score[1] ? -1 : this.score[0] > this.score[1] ? 0 : 1;
      return this.endMatch(w as 0 | 1 | -1, this.score, "finished");
    }
    // After a goal the conceding team restarts; otherwise alternate.
    this.turnTeam = goal !== null ? ((1 - goal) as 0 | 1) : ((1 - this.turnTeam) as 0 | 1);
    this.clock.setTimeout(() => this.beginTurn(), 700);
  }

  private snapshot(moving: boolean): SubbuteoSnapshot {
    return {
      t: Date.now(),
      ball: [round1(this.state2.ball.x), round1(this.state2.ball.y)],
      discs: this.state2.discs.map((d) => [round1(d.x), round1(d.y)] as [number, number]),
      moving,
    };
  }

  protected override onOpponentPaused(seat: any): void {
    this.paused = true;
    if (this.turnTimer) clearTimeout(this.turnTimer);
    super.onOpponentPaused(seat);
  }

  protected override onOpponentResumed(seat: any): void {
    this.paused = false;
    super.onOpponentResumed(seat);
    this.broadcastMsg("board", this.snapshot(false));
    if (!this.simulating) this.clock.setTimeout(() => this.beginTurn(), 800);
  }

  override onDispose(): void {
    this.stopSim();
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
