import { SUBBUTEO } from "../../../shared/src/constants";
import {
  applyFlick, atRest, botFlick, initialState, kickoff, step,
} from "../../../shared/src/subbuteoPhysics";
import type { FlickMsg, PlayerInfo, SubbuteoSnapshot, SubbuteoState } from "../../../shared/src/types";
import { session } from "../state";
import { LocalChannelBase } from "../net/channel";

/** Offline subbuteo vs bot — mirrors SubbuteoRoom's protocol with shared physics. */
export class LocalSubbuteoChannel extends LocalChannelBase {
  private state: SubbuteoState = initialState();
  private score: [number, number] = [0, 0];
  private turnIndex = 0;
  private turnTeam: 0 | 1 = 0;
  private simulating = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    const me: PlayerInfo = {
      id: session.user?.id ?? "local",
      name: session.user?.name ?? "Player",
      level: session.user?.level ?? 1,
      rating: session.user?.stats.subbuteo.rating ?? 1000,
      isBot: false,
    };
    const bot: PlayerInfo = { id: "bot", name: "TurboTacco", level: 3, rating: 1000, isBot: true };
    this.emit("match_start", { gameId: "subbuteo", players: [me, bot], youAre: 0 });
    this.emit("board", this.snapshot(false));
    this.after(1200, () => this.beginTurn());
  }

  private beginTurn(): void {
    this.emit("turn", { team: this.turnTeam, turnIndex: this.turnIndex, turnMs: SUBBUTEO.TURN_MS });
    if (this.turnTeam === 1) {
      this.after(1300 + Math.random() * 1200, () => {
        if (!this.simulating) this.doFlick(1, botFlick(this.state, 1));
      });
    } else {
      this.after(SUBBUTEO.TURN_MS + 500, () => {
        if (!this.simulating && this.turnTeam === 0) this.doFlick(0, botFlick(this.state, 0));
      });
    }
  }

  override send(type: string, payload?: any): void {
    if (type !== "flick" || this.simulating || this.turnTeam !== 0) return;
    this.doFlick(0, payload as FlickMsg);
  }

  private doFlick(team: 0 | 1, flick: FlickMsg): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (!applyFlick(this.state, team, flick)) {
      this.endTurn(null);
      return;
    }
    this.emit("flick_ok", { team, ...flick });
    this.simulate();
  }

  private simulate(): void {
    this.simulating = true;
    const t0 = Date.now();
    let goal: 0 | 1 | null = null;
    let sinceSnap = 0;
    this.interval = setInterval(() => {
      for (let i = 0; i < 3 && goal === null; i++) {
        const ev = step(this.state, 1 / 60);
        if (ev.goalFor !== null) goal = ev.goalFor;
      }
      sinceSnap += 50;
      if (sinceSnap >= 1000 / SUBBUTEO.SNAPSHOT_HZ) {
        sinceSnap = 0;
        this.emit("snap", this.snapshot(true));
      }
      if (goal !== null || atRest(this.state) || Date.now() - t0 > SUBBUTEO.SIM_MAX_MS) {
        if (this.interval) clearInterval(this.interval);
        this.interval = null;
        this.simulating = false;
        this.finishSim(goal);
      }
    }, 50);
  }

  private finishSim(goal: 0 | 1 | null): void {
    if (goal !== null) {
      this.score[goal]++;
      this.emit("goal", { team: goal, score: [...this.score] });
      kickoff(this.state);
      this.after(2200, () => {
        this.emit("board", this.snapshot(false));
        this.endTurn(goal);
      });
      return;
    }
    this.emit("snap", this.snapshot(false));
    this.endTurn(null);
  }

  private endTurn(goal: 0 | 1 | null): void {
    if (this.score[0] >= SUBBUTEO.GOAL_TARGET || this.score[1] >= SUBBUTEO.GOAL_TARGET) {
      return this.emit("match_end", {
        winnerIdx: this.score[0] > this.score[1] ? 0 : 1,
        score: this.score, reason: "finished", rewards: null,
      });
    }
    this.turnIndex++;
    if (this.turnIndex >= SUBBUTEO.MAX_TURNS) {
      const w = this.score[0] === this.score[1] ? -1 : this.score[0] > this.score[1] ? 0 : 1;
      return this.emit("match_end", { winnerIdx: w, score: this.score, reason: "finished", rewards: null });
    }
    this.turnTeam = goal !== null ? ((1 - goal) as 0 | 1) : ((1 - this.turnTeam) as 0 | 1);
    this.after(700, () => this.beginTurn());
  }

  private snapshot(moving: boolean): SubbuteoSnapshot {
    return {
      t: Date.now(),
      ball: [this.state.ball.x, this.state.ball.y],
      discs: this.state.discs.map((d) => [d.x, d.y] as [number, number]),
      moving,
    };
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(() => { if (!this.closed) fn(); }, ms));
  }

  protected override dispose(): void {
    this.timers.forEach(clearTimeout);
    if (this.interval) clearInterval(this.interval);
  }
}
