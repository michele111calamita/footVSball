import { zoneCenter, zoneOf } from "../../../shared/src/penaltyLogic";
import type {
  MatchEndMsg, MatchStartMsg, PenaltyPhaseMsg, PenaltyResultMsg, ShotOutcome,
} from "../../../shared/src/types";
import { t } from "../i18n";
import type { GameChannel } from "../net/channel";
import { confirmModal, haptic, sfx, toast } from "../ui/fx";
import { go, register } from "../ui/nav";
import { Screen, h } from "../ui/router";
import { showResult } from "../screens/resultOverlay";
import { skinColors } from "./skins";
import type { Mode } from "../screens/pregame";

type Role = "shooter" | "keeper" | "idle";
type Phase = "waiting" | "input" | "anim";

interface Params {
  channel: GameChannel;
  start: MatchStartMsg;
  mode?: Mode;
}

/**
 * Penalty shootout client. Shooter view: behind the ball (FIFA-style).
 * Keeper view: behind the goal (x mirrored). The server decides outcomes;
 * this class only collects input and animates results.
 */
class PenaltyGame {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  raf = 0;
  W = 0;
  H = 0;

  role: Role = "idle";
  phase: Phase = "waiting";
  youAre: 0 | 1;
  score: [number, number] = [0, 0];
  history: [ShotOutcome[], ShotOutcome[]] = [[], []];
  myShotsTaken = 0;
  suddenDeath = false;

  // input
  dragging = false;
  dragPts: { x: number; y: number }[] = [];
  myDive: { col: -1 | 0 | 1; row: 0 | 1 | 2 } | null = null;

  // animation
  anim: {
    result: PenaltyResultMsg;
    t0: number;
    speed: number;
    replayed: boolean;
    impactDone: boolean;
  } | null = null;
  keeperLerp = { x: 0, y: 0.5 }; // goal-space keeper position

  banner: HTMLElement;
  scoreEl: HTMLElement;
  timerFill: HTMLElement;
  hintEl: HTMLElement;
  destroyed = false;

  constructor(
    public wrap: HTMLElement,
    public channel: GameChannel,
    public start: MatchStartMsg,
    public mode: Mode,
  ) {
    this.youAre = start.youAre;
    this.canvas = h("canvas", { class: "game-canvas" });
    wrap.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    // HUD
    const hud = h("div", { class: "hud-top" });
    const p0 = h("span", { class: "hud-name" }, start.players[0].name);
    this.scoreEl = h("span", { class: "hud-score" }, "0 - 0");
    const p1 = h("span", { class: "hud-name" }, start.players[1].name);
    hud.append(p0, this.scoreEl, p1);
    wrap.appendChild(hud);

    this.banner = h("div", { class: "hud-banner" });
    this.banner.style.display = "none";
    wrap.appendChild(this.banner);

    this.hintEl = h("div", { class: "hud-banner", style: "top:auto;bottom:12%;font-size:1rem;font-family:var(--font-body);font-weight:700;opacity:.85" });
    this.hintEl.style.display = "none";
    wrap.appendChild(this.hintEl);

    const timerWrap = h("div", { class: "progress", style: "position:absolute;top:calc(64px + var(--safe-top));left:14%;right:14%;height:8px" });
    this.timerFill = h("div", { class: "progress__fill" });
    timerWrap.appendChild(this.timerFill);
    wrap.appendChild(timerWrap);

    const quit = h("button", { class: "hud-quit" }, t("quit"));
    quit.addEventListener("click", async () => {
      if (await confirmModal(t("quit"), t("quitConfirm"), t("confirm"), t("cancel"))) {
        this.channel.leave();
        go("home");
      }
    });
    wrap.appendChild(quit);

    this.bindNet();
    this.bindInput();
    this.resize();
    window.addEventListener("resize", this.resize);
    this.loop(performance.now());
    sfx.whistle();
  }

  // ---------- Net ----------

  private bindNet(): void {
    this.channel.on("phase", (msg: PenaltyPhaseMsg) => this.onPhase(msg));
    this.channel.on("result", (msg: PenaltyResultMsg) => this.onResult(msg));
    this.channel.on("match_end", (msg: MatchEndMsg) => this.onEnd(msg));
    this.channel.on("opponent_paused", () => this.showBanner(t("opponentPaused"), 0));
    this.channel.on("opponent_resumed", () => this.hideBanner());
    this.channel.onLeave(() => {
      if (!this.destroyed) {
        toast(t("connectionLost"), "error");
        this.dispose();
        go("home");
      }
    });
  }

  private onPhase(msg: PenaltyPhaseMsg): void {
    this.suddenDeath = msg.suddenDeath;
    this.role = msg.shooterIdx === this.youAre ? "shooter" : "keeper";
    this.phase = "input";
    this.anim = null;
    this.myDive = null;
    this.dragPts = [];
    this.keeperLerp = { x: 0, y: 0.45 };

    const label = this.role === "shooter" ? t("youShoot") : t("youSave");
    this.showBanner(msg.suddenDeath ? `${t("suddenDeath")} ${label}` : label, 1400);
    this.hintEl.textContent = this.role === "shooter" ? t("dragToShoot") : t("tapToDive");
    this.hintEl.style.display = "";
    this.startTimer(msg.shotTimeoutMs);
  }

  private onResult(msg: PenaltyResultMsg): void {
    this.phase = "anim";
    this.hintEl.style.display = "none";
    this.timerFill.style.transition = "none";
    this.timerFill.style.width = "0%";
    this.anim = { result: msg, t0: performance.now(), speed: 1, replayed: false, impactDone: false };
    if (msg.shot.power > 0.15) sfx.kick();
  }

  private onEnd(msg: MatchEndMsg): void {
    this.dispose();
    showResult(msg, this.youAre, () => {
      go("pregame", { gameId: "penalty", auto: this.mode });
    }, () => go("home"));
  }

  // ---------- Input ----------

  private bindInput(): void {
    this.canvas.addEventListener("pointerdown", (e) => {
      if (this.phase !== "input") return;
      if (this.role === "shooter") {
        const p = this.pt(e);
        const b = this.ballStart();
        if (Math.hypot(p.x - b.x, p.y - b.y) < this.H * 0.12) {
          this.dragging = true;
          this.dragPts = [p];
        }
      } else if (this.role === "keeper") {
        const g = this.screenToGoal(this.pt(e));
        if (g.x >= -1.25 && g.x <= 1.25 && g.y >= -0.15 && g.y <= 1.2) {
          const z = zoneOf(Math.max(-1, Math.min(1, g.x)), Math.max(0, Math.min(1, g.y)));
          this.myDive = z;
          this.channel.send("dive", z);
          sfx.tap();
          haptic(15);
        }
      }
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (this.dragging) this.dragPts.push(this.pt(e));
    });
    const up = () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.releaseShot();
    };
    this.canvas.addEventListener("pointerup", up);
    this.canvas.addEventListener("pointercancel", up);
  }

  private releaseShot(): void {
    if (this.phase !== "input" || this.role !== "shooter" || this.dragPts.length < 3) return;
    const a = this.dragPts[0];
    const b = this.dragPts[this.dragPts.length - 1];
    const dx = b.x - a.x;
    const dy = a.y - b.y; // upward positive
    if (dy < this.H * 0.04) return; // too short — not a shot

    const f = this.flip();
    const goalW = this.goalRect().w;
    const tx = (f * dx) / (goalW * 0.45);
    const ty = Math.min(1.3, (dy - this.H * 0.04) / (this.H * 0.34));
    const power = Math.min(1, Math.hypot(dx, dy) / (this.H * 0.5));
    // Curve: lateral bow of the drag path vs its straight chord.
    const mid = this.dragPts[Math.floor(this.dragPts.length / 2)];
    const bow = mid.x - (a.x + b.x) / 2;
    const curve = Math.max(-1, Math.min(1, (f * bow) / (this.W * 0.12)));

    this.phase = "waiting";
    this.channel.send("shoot", { tx, ty, power, curve });
    this.myShotsTaken++;
    haptic(25);
  }

  // ---------- Geometry ----------

  private flip(): 1 | -1 {
    return this.role === "keeper" ? -1 : 1;
  }

  private goalRect() {
    const w = this.role === "keeper" ? this.W * 0.92 : this.W * 0.8;
    const hgt = w / 3;
    const bottom = this.role === "keeper" ? this.H * 0.62 : this.H * 0.5;
    return { cx: this.W / 2, w, h: hgt, bottom, top: bottom - hgt };
  }

  private goalToScreen(gx: number, gy: number): { x: number; y: number } {
    const g = this.goalRect();
    return { x: g.cx + this.flip() * gx * (g.w / 2), y: g.bottom - gy * g.h };
  }

  private screenToGoal(p: { x: number; y: number }): { x: number; y: number } {
    const g = this.goalRect();
    return { x: (this.flip() * (p.x - g.cx)) / (g.w / 2), y: (g.bottom - p.y) / g.h };
  }

  private ballStart(): { x: number; y: number } {
    const g = this.goalRect();
    return this.role === "keeper"
      ? { x: this.W / 2, y: Math.min(this.H * 0.9, g.bottom + this.H * 0.22) }
      : { x: this.W / 2, y: this.H * 0.84 };
  }

  private pt(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---------- Timer / banner ----------

  private startTimer(ms: number): void {
    this.timerFill.style.transition = "none";
    this.timerFill.style.width = "100%";
    requestAnimationFrame(() => {
      this.timerFill.style.transition = `width ${ms}ms linear`;
      this.timerFill.style.width = "0%";
    });
  }

  private showBanner(text: string, ms: number): void {
    this.banner.textContent = text;
    this.banner.style.display = "";
    if (ms > 0) setTimeout(() => this.hideBanner(), ms);
  }

  private hideBanner(): void {
    this.banner.style.display = "none";
  }

  // ---------- Render ----------

  resize = (): void => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.W = this.wrap.clientWidth;
    this.H = this.wrap.clientHeight;
    this.canvas.width = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  private loop = (now: number): void => {
    if (this.destroyed) return;
    // The wrap is attached after construction; keep the canvas in sync.
    if (this.W !== this.wrap.clientWidth || this.H !== this.wrap.clientHeight) this.resize();
    this.draw(now);
    this.raf = requestAnimationFrame(this.loop);
  };

  private draw(now: number): void {
    const { ctx, W, H } = this;
    const g = this.goalRect();

    // Stadium backdrop.
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#071e30");
    sky.addColorStop(0.42, "#123a54");
    sky.addColorStop(0.42, "#1d7a3e");
    sky.addColorStop(1, "#15602f");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // Crowd strip.
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    for (let y = H * 0.12; y < H * 0.4; y += 10) {
      for (let x = (y % 20 === 0 ? 5 : 12); x < W; x += 14) {
        ctx.fillRect(x, y, 3, 3);
      }
    }

    // Pitch stripes.
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    for (let i = 0; i < 5; i++) {
      const y = g.bottom + (H - g.bottom) * (i / 5);
      ctx.fillRect(0, y, W, (H - g.bottom) / 10);
    }

    this.drawGoal(g);

    // Zone grid hint for the keeper.
    if (this.role === "keeper" && this.phase === "input") this.drawZones(g);

    this.drawKeeper(now);
    this.drawBall(now);

    // Aim arrow while dragging (assist fades after 2 own kicks — increasing difficulty).
    if (this.dragging && this.dragPts.length > 1 && this.myShotsTaken < 2) this.drawAim();

    if (this.anim) this.stepAnim(now);
  }

  private drawGoal(g: { cx: number; w: number; h: number; bottom: number; top: number }): void {
    const { ctx } = this;
    const x0 = g.cx - g.w / 2;
    // Net.
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 12; i++) {
      const x = x0 + (g.w * i) / 12;
      ctx.beginPath(); ctx.moveTo(x, g.top); ctx.lineTo(x, g.bottom); ctx.stroke();
    }
    for (let i = 0; i <= 5; i++) {
      const y = g.top + (g.h * i) / 5;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + g.w, y); ctx.stroke();
    }
    // Posts + crossbar.
    ctx.strokeStyle = "#f4f6f5";
    ctx.lineWidth = Math.max(5, g.w * 0.018);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x0, g.bottom);
    ctx.lineTo(x0, g.top);
    ctx.lineTo(x0 + g.w, g.top);
    ctx.lineTo(x0 + g.w, g.bottom);
    ctx.stroke();
    // Goal line.
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, g.bottom); ctx.lineTo(this.W, g.bottom); ctx.stroke();
  }

  private drawZones(g: { cx: number; w: number; h: number; bottom: number; top: number }): void {
    const { ctx } = this;
    const x0 = g.cx - g.w / 2;
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 3; r++) {
        const zx = x0 + (g.w * c) / 3;
        const zy = g.bottom - (g.h * (r + 1)) / 3;
        const colVal = ([-1, 0, 1] as const)[c];
        const rowVal = ([0, 1, 2] as const)[r];
        // Column value in shooter space depends on the mirror.
        const col = (this.flip() * colVal) as -1 | 0 | 1;
        const sel = this.myDive && this.myDive.col === col && this.myDive.row === rowVal;
        ctx.fillStyle = sel ? "rgba(255,210,62,0.4)" : "rgba(255,255,255,0.07)";
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.fillRect(zx + 2, zy + 2, g.w / 3 - 4, g.h / 3 - 4);
        ctx.strokeRect(zx + 2, zy + 2, g.w / 3 - 4, g.h / 3 - 4);
      }
    }
  }

  private drawKeeper(now: number): void {
    const { ctx } = this;
    const g = this.goalRect();
    let kx = this.keeperLerp.x;
    let ky = this.keeperLerp.y;

    if (this.anim?.result.dive) {
      const zc = zoneCenter(this.anim.result.dive.col, this.anim.result.dive.row);
      const p = Math.min(1, (now - this.anim.t0) / (this.anim.result.flightMs / this.anim.speed));
      kx = this.keeperLerp.x + (zc.x - this.keeperLerp.x) * ease(p);
      ky = this.keeperLerp.y + (zc.y * 0.85 - this.keeperLerp.y) * ease(p);
    }
    const pos = this.goalToScreen(kx, Math.max(0.12, ky - 0.25));
    const s = g.h; // scale
    // Body.
    ctx.fillStyle = "#ffd23e";
    ctx.strokeStyle = "#8a6a00";
    ctx.lineWidth = 2;
    roundRect(ctx, pos.x - s * 0.09, pos.y - s * 0.3, s * 0.18, s * 0.36, s * 0.08);
    ctx.fill();
    // Head.
    ctx.beginPath();
    ctx.arc(pos.x, pos.y - s * 0.38, s * 0.08, 0, Math.PI * 2);
    ctx.fillStyle = "#e8b88a";
    ctx.fill();
    // Gloves toward dive direction.
    const gx = kx * s * 0.35;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(pos.x - s * 0.14 + gx * 0.4, pos.y - s * 0.22, s * 0.05, 0, Math.PI * 2);
    ctx.arc(pos.x + s * 0.14 + gx * 0.4, pos.y - s * 0.22, s * 0.05, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawBall(now: number): void {
    const { ctx } = this;
    const start = this.ballStart();
    let x = start.x;
    let y = start.y;
    let r = this.role === "keeper" ? this.H * 0.014 : this.H * 0.022;

    if (this.anim) {
      const a = this.anim;
      const res = a.result;
      const dur = res.flightMs / a.speed;
      const p = Math.min(1, (now - a.t0) / dur);
      const target = this.goalToScreen(
        Math.max(-1.3, Math.min(1.3, res.bx)),
        Math.max(0, Math.min(1.3, res.by)),
      );
      // Curved flight: quadratic bezier with lateral control offset.
      const cxp = (start.x + target.x) / 2 + this.flip() * res.shot.curve * this.W * 0.18;
      const cyp = Math.min(start.y, target.y) - this.H * 0.1;
      const ip = 1 - p;
      x = ip * ip * start.x + 2 * ip * p * cxp + p * p * target.x;
      y = ip * ip * start.y + 2 * ip * p * cyp + p * p * target.y;
      if (this.role === "keeper") r = this.H * (0.012 + 0.014 * p);
      else r = this.H * (0.022 - 0.008 * p);

      if (p >= 1 && !a.impactDone) {
        a.impactDone = true;
        this.onImpact(res);
      }
    }

    const skin = skinColors(this.start.players[(this.anim?.result.kickIndex ?? 0) % 2 === 0 ? 0 : 1]?.ballSkin);
    const grad = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, r * 0.2, x, y, r);
    grad.addColorStop(0, skin[0]);
    grad.addColorStop(1, skin[1]);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Shadow.
    ctx.beginPath();
    ctx.ellipse(x, y + r * 1.3, r * 0.9, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fill();
  }

  private drawAim(): void {
    const { ctx } = this;
    const a = this.dragPts[0];
    const b = this.dragPts[this.dragPts.length - 1];
    ctx.strokeStyle = "rgba(255,210,62,0.9)";
    ctx.lineWidth = 4;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    // Power ring.
    const power = Math.min(1, Math.hypot(b.x - a.x, a.y - b.y) / (this.H * 0.5));
    ctx.beginPath();
    ctx.arc(a.x, a.y, this.H * 0.03, -Math.PI / 2, -Math.PI / 2 + power * Math.PI * 2);
    ctx.strokeStyle = power > 0.8 ? "#e6363c" : "#ff8a1e";
    ctx.lineWidth = 6;
    ctx.stroke();
  }

  private stepAnim(now: number): void {
    const a = this.anim!;
    const res = a.result;
    const dur = res.flightMs / a.speed;
    const done = now - a.t0 > dur + 600;
    if (!done) return;

    // Slow-mo replay for spectacular finishes.
    const spectacular = (res.outcome === "goal" || res.outcome === "saved") && res.shot.power > 0.65;
    if (spectacular && !a.replayed) {
      a.replayed = true;
      a.impactDone = true; // no double sfx
      a.speed = 0.45;
      a.t0 = now;
      this.showBanner(t("replay"), res.flightMs / 0.45);
      return;
    }
    this.anim = null;
  }

  private onImpact(res: PenaltyResultMsg): void {
    this.score = res.score;
    this.scoreEl.textContent = `${res.score[0]} - ${res.score[1]}`;
    const shooter = (res.kickIndex % 2) as 0 | 1;
    this.history[shooter].push(res.outcome);

    const label = res.outcome === "goal" ? t("goal") : res.outcome === "saved" ? t("saved") : res.outcome === "post" ? t("post") : t("out");
    this.showBanner(label, 1600);
    if (res.outcome === "goal") {
      sfx.goal();
      haptic(shooter === this.youAre ? [50, 30, 100] : 80);
    } else if (res.outcome === "saved") {
      sfx.save();
      haptic(60);
    } else {
      sfx.miss();
    }
  }

  dispose(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
  }
}

function ease(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hgt: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hgt, r);
  ctx.arcTo(x + w, y + hgt, x, y + hgt, r);
  ctx.arcTo(x, y + hgt, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function penaltyScreen(params: Params): Screen {
  const wrap = h("div", { class: "game-wrap" });
  const game = new PenaltyGame(wrap, params.channel, params.start, params.mode ?? "online");
  return {
    el: wrap,
    destroy: () => {
      game.dispose();
      params.channel.leave();
    },
  };
}

register("game-penalty", penaltyScreen);
