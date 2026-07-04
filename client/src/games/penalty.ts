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

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; size: number; color: string;
  gravity: number; kind: "rect" | "dot" | "spark";
  rot: number; vr: number;
}

/** Windup before the ball leaves the foot (shooter kick animation). */
const KICK_MS = 260;

const REDUCED_MOTION = typeof matchMedia !== "undefined"
  && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Penalty shootout client — juicy cartoon presentation.
 * Shooter view: behind the ball. Keeper view: behind the goal (x mirrored).
 * The server decides outcomes; this class only collects input and animates.
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

  // animation & FX
  anim: {
    result: PenaltyResultMsg;
    t0: number;
    speed: number;
    replayed: boolean;
    impactDone: boolean;
  } | null = null;
  particles: Particle[] = [];
  trail: { x: number; y: number; r: number; born: number }[] = [];
  shake = 0;
  netImpact: { gx: number; gy: number; t: number } | null = null;
  ballSpin = 0;
  lastT = 0;

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
    this.trail = [];
    this.netImpact = null;

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
    this.trail = [];
    this.anim = { result: msg, t0: performance.now(), speed: 1, replayed: false, impactDone: false };
    if (msg.shot.power > 0.15) setTimeout(() => sfx.kick(), KICK_MS * 0.8);
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
    // Fit by width, but never let the crossbar leave the screen on wide viewports.
    let w = this.role === "keeper" ? this.W * 0.92 : this.W * 0.8;
    let hgt = w / 3;
    const maxH = this.H * (this.role === "keeper" ? 0.44 : 0.36);
    if (hgt > maxH) {
      hgt = maxH;
      w = hgt * 3;
    }
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

  // ---------- Loop ----------

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
    if (this.W !== this.wrap.clientWidth || this.H !== this.wrap.clientHeight) this.resize();
    const dt = Math.min(0.05, (now - this.lastT) / 1000 || 0.016);
    this.lastT = now;
    this.draw(now, dt);
    this.raf = requestAnimationFrame(this.loop);
  };

  // ---------- Scene ----------

  private draw(now: number, dt: number): void {
    const { ctx, W, H } = this;
    const g = this.goalRect();

    ctx.save();
    if (this.shake > 0.3 && !REDUCED_MOTION) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
      this.shake *= Math.pow(0.02, dt); // fast exponential decay
    } else {
      this.shake = 0;
    }

    this.drawSky(now, g);
    this.drawCrowd(now, g);
    this.drawAdBoards(g);
    this.drawPitch(g);
    this.drawGoal(now, g);

    if (this.role === "keeper" && this.phase === "input") this.drawZones(g);

    this.drawShooterFigure(now, g);
    this.drawKeeper(now, g);
    this.drawBall(now);

    if (this.dragging && this.dragPts.length > 1 && this.myShotsTaken < 2) this.drawAim();

    this.stepParticles(dt);
    if (this.anim) this.stepAnim(now);

    // Soft vignette keeps the eye on the goal.
    const vg = ctx.createRadialGradient(W / 2, H * 0.45, H * 0.35, W / 2, H * 0.5, H * 0.85);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(4,20,12,0.42)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    ctx.restore();
  }

  /** Dusk sky, stadium roof and floodlight glows. */
  private drawSky(now: number, g: { bottom: number }): void {
    const { ctx, W, H } = this;
    const sky = ctx.createLinearGradient(0, 0, 0, g.bottom);
    sky.addColorStop(0, "#0d1b3d");
    sky.addColorStop(0.55, "#1d3a6b");
    sky.addColorStop(1, "#2a5a8a");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, g.bottom);

    // Roof silhouette.
    ctx.fillStyle = "#091228";
    ctx.beginPath();
    ctx.moveTo(0, H * 0.09);
    ctx.quadraticCurveTo(W / 2, H * 0.015, W, H * 0.09);
    ctx.lineTo(W, 0);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fill();

    // Floodlight glows (breathing slightly).
    const pulse = REDUCED_MOTION ? 1 : 0.92 + 0.08 * Math.sin(now / 900);
    for (const fx of [W * 0.08, W * 0.92]) {
      const lg = ctx.createRadialGradient(fx, H * 0.07, 0, fx, H * 0.07, W * 0.5);
      lg.addColorStop(0, `rgba(255,244,200,${0.4 * pulse})`);
      lg.addColorStop(1, "rgba(255,244,200,0)");
      ctx.fillStyle = lg;
      ctx.fillRect(0, 0, W, H * 0.55);
      // Lamp cluster.
      ctx.fillStyle = "#fff6cf";
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.arc(fx + i * 9, H * 0.065, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** Two animated crowd tiers with camera flashes. */
  private drawCrowd(now: number, g: { bottom: number }): void {
    const { ctx, W, H } = this;
    const top = H * 0.1;
    const bottom = g.bottom - H * 0.115;
    ctx.fillStyle = "#12213f";
    ctx.fillRect(0, top, W, bottom - top);

    const colors = ["#e6636a", "#5f8fd9", "#e8c05a", "#67b06f", "#b78ad0", "#d9d9e0"];
    const step = Math.max(11, W / 46);
    let row = 0;
    for (let y = top + 8; y < bottom - 4; y += step * 0.82) {
      row++;
      for (let x = (row % 2 ? step / 2 : 4); x < W; x += step) {
        const seed = (x * 13 + row * 71) | 0;
        const bob = REDUCED_MOTION ? 0 : Math.sin(now / 480 + seed) * 1.6;
        ctx.fillStyle = colors[seed % colors.length];
        ctx.beginPath();
        ctx.arc(x, y + bob, step * 0.26, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Camera flashes.
    if (!REDUCED_MOTION) {
      for (let i = 0; i < 3; i++) {
        const s = ((now / 120) | 0) * 7 + i * 131;
        if ((s * 2654435761 % 97) < 6) {
          const fx2 = (s * 48271 % 1000) / 1000 * W;
          const fy = top + ((s * 16807 % 1000) / 1000) * (bottom - top);
          ctx.fillStyle = "rgba(255,255,255,0.9)";
          ctx.beginPath();
          ctx.arc(fx2, fy, 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    // Tier divider.
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    ctx.fillRect(0, (top + bottom) / 2, W, 2);
  }

  /** Sponsor boards under the crowd — colored blocks, no real text needed. */
  private drawAdBoards(g: { bottom: number }): void {
    const { ctx, W, H } = this;
    const bh = H * 0.045;
    const y = g.bottom - H * 0.115;
    const palette: [string, string][] = [
      ["#ff8a1e", "#ffffff"], ["#1d9a4b", "#ffd23e"], ["#2f7ddb", "#ffffff"], ["#e6363c", "#ffffff"],
    ];
    const bw = W / 4;
    for (let i = 0; i < 4; i++) {
      const [bg, fg] = palette[i % palette.length];
      ctx.fillStyle = bg;
      ctx.fillRect(i * bw, y, bw - 3, bh);
      // Fake wordmark bars.
      ctx.fillStyle = fg;
      const cx = i * bw + bw / 2;
      ctx.fillRect(cx - bw * 0.26, y + bh * 0.38, bw * 0.34, bh * 0.24);
      ctx.beginPath();
      ctx.arc(cx - bw * 0.33, y + bh * 0.5, bh * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(0, y + bh, W, 3);
  }

  /** Grass with mow stripes, box lines and penalty spot. */
  private drawPitch(g: { cx: number; w: number; bottom: number }): void {
    const { ctx, W, H } = this;
    const grass = ctx.createLinearGradient(0, g.bottom - H * 0.07, 0, H);
    grass.addColorStop(0, "#2fa457");
    grass.addColorStop(1, "#177a3c");
    ctx.fillStyle = grass;
    ctx.fillRect(0, g.bottom - H * 0.07, W, H);

    // Perspective mow stripes (wider toward the camera).
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    let y = g.bottom;
    let sh = H * 0.028;
    let odd = false;
    while (y < H) {
      if (odd) ctx.fillRect(0, y, W, sh);
      y += sh;
      sh *= 1.35;
      odd = !odd;
    }

    // Box lines in perspective (trapezoid) — shooter side only makes sense both views.
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 3;
    const boxTopW = g.w * 1.15;
    const boxBotW = W * 1.25;
    const boxTopY = g.bottom + H * 0.012;
    const boxBotY = Math.min(H * 0.97, g.bottom + H * 0.34);
    ctx.beginPath();
    ctx.moveTo(g.cx - boxTopW / 2, boxTopY);
    ctx.lineTo(g.cx - boxBotW / 2, boxBotY);
    ctx.moveTo(g.cx + boxTopW / 2, boxTopY);
    ctx.lineTo(g.cx + boxBotW / 2, boxBotY);
    ctx.moveTo(g.cx - boxBotW / 2, boxBotY);
    ctx.lineTo(g.cx + boxBotW / 2, boxBotY);
    ctx.stroke();

    // Goal line.
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, g.bottom);
    ctx.lineTo(W, g.bottom);
    ctx.stroke();

    // Penalty spot (shooter view: under the ball).
    if (this.role !== "keeper") {
      const b = this.ballStart();
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.beginPath();
      ctx.ellipse(b.x, b.y + this.H * 0.035, 7, 3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Goal frame with depth + sagging net that bulges on impact. */
  private drawGoal(now: number, g: { cx: number; w: number; h: number; bottom: number; top: number }): void {
    const { ctx } = this;
    const x0 = g.cx - g.w / 2;
    const postW = Math.max(6, g.w * 0.02);

    // Net shadow area.
    ctx.fillStyle = "rgba(10,30,20,0.25)";
    ctx.fillRect(x0, g.top, g.w, g.h);

    // Net with sag + impact bulge.
    const bulge = this.netImpact && now - this.netImpact.t < 420 ? 1 - (now - this.netImpact.t) / 420 : 0;
    const bp = this.netImpact ? this.goalToScreen(this.netImpact.gx, this.netImpact.gy) : { x: 0, y: 0 };
    const displace = (px: number, py: number): [number, number] => {
      if (!bulge) return [px, py];
      const d = Math.hypot(px - bp.x, py - bp.y);
      const R = g.h * 0.55;
      if (d > R) return [px, py];
      const k = (1 - d / R) * bulge * g.h * 0.13;
      return [px + ((px - bp.x) / (d || 1)) * -k * 0.25, py + k];
    };

    ctx.strokeStyle = "rgba(255,255,255,0.32)";
    ctx.lineWidth = 1.2;
    const COLS = 14, ROWS = 6;
    for (let i = 0; i <= COLS; i++) {
      ctx.beginPath();
      for (let j = 0; j <= ROWS; j++) {
        const sag = Math.sin((i / COLS) * Math.PI) * (j / ROWS) * g.h * 0.05;
        const [px, py] = displace(x0 + (g.w * i) / COLS, g.top + (g.h * j) / ROWS + sag);
        j === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    for (let j = 0; j <= ROWS; j++) {
      ctx.beginPath();
      for (let i = 0; i <= COLS; i++) {
        const sag = Math.sin((i / COLS) * Math.PI) * (j / ROWS) * g.h * 0.05;
        const [px, py] = displace(x0 + (g.w * i) / COLS, g.top + (g.h * j) / ROWS + sag);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // Posts + crossbar with cartoon depth (dark edge behind, light front).
    ctx.lineCap = "round";
    ctx.strokeStyle = "#b9c4bd";
    ctx.lineWidth = postW + 3;
    ctx.beginPath();
    ctx.moveTo(x0, g.bottom);
    ctx.lineTo(x0, g.top);
    ctx.lineTo(x0 + g.w, g.top);
    ctx.lineTo(x0 + g.w, g.bottom);
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = postW;
    ctx.stroke();
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
        const col = (this.flip() * colVal) as -1 | 0 | 1;
        const sel = this.myDive && this.myDive.col === col && this.myDive.row === rowVal;
        ctx.fillStyle = sel ? "rgba(255,210,62,0.42)" : "rgba(255,255,255,0.07)";
        ctx.strokeStyle = sel ? "rgba(255,210,62,0.9)" : "rgba(255,255,255,0.22)";
        ctx.lineWidth = sel ? 3 : 1.5;
        roundRectPath(ctx, zx + 4, zy + 4, g.w / 3 - 8, g.h / 3 - 8, 10);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // ---------- Characters ----------

  /** Cartoon keeper: idle crouch-bounce, then a full dive toward the zone. */
  private drawKeeper(now: number, g: { cx: number; w: number; h: number; bottom: number; top: number }): void {
    const { ctx } = this;
    const s = g.h; // scale unit

    let gx = 0;
    let gy = 0.42;
    let diveP = 0;
    if (this.anim?.result.dive) {
      const zc = zoneCenter(this.anim.result.dive.col, this.anim.result.dive.row);
      const dur = (this.anim.result.flightMs / this.anim.speed) * 0.85;
      diveP = easeOutQuart(Math.min(1, Math.max(0, (now - this.anim.t0 - KICK_MS * 0.6) / dur)));
      gx = zc.x * diveP;
      gy = 0.42 + (Math.max(0.2, zc.y) - 0.42) * diveP;
    }
    const pos = this.goalToScreen(gx, Math.max(0.1, gy - 0.22));
    const idleBob = REDUCED_MOTION || diveP > 0 ? 0 : Math.sin(now / 300) * s * 0.012;
    const sway = REDUCED_MOTION || diveP > 0 ? 0 : Math.sin(now / 700) * s * 0.05;
    const x = pos.x + sway;
    const y = pos.y + idleBob;
    const lean = this.flip() * gx * 0.9 * diveP; // radians toward the dive

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(lean);

    // Shadow (stays under, drawn pre-rotation would be better but ok for cartoon).
    ctx.rotate(-lean);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath();
    ctx.ellipse(0, s * 0.16, s * 0.16 + diveP * s * 0.1, s * 0.045, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(lean);

    // Legs.
    ctx.strokeStyle = "#1c2f52";
    ctx.lineWidth = s * 0.055;
    ctx.lineCap = "round";
    const legSpread = s * (0.07 + 0.1 * diveP);
    ctx.beginPath();
    ctx.moveTo(-s * 0.04, s * 0.02);
    ctx.lineTo(-legSpread, s * 0.14);
    ctx.moveTo(s * 0.04, s * 0.02);
    ctx.lineTo(legSpread * (diveP > 0 ? 1.6 : 1), s * (0.14 - 0.06 * diveP));
    ctx.stroke();
    // Boots.
    ctx.fillStyle = "#222";
    ctx.beginPath();
    ctx.arc(-legSpread, s * 0.145, s * 0.035, 0, Math.PI * 2);
    ctx.arc(legSpread * (diveP > 0 ? 1.6 : 1), s * (0.145 - 0.06 * diveP), s * 0.035, 0, Math.PI * 2);
    ctx.fill();

    // Torso (jersey).
    const grad = ctx.createLinearGradient(0, -s * 0.22, 0, s * 0.05);
    grad.addColorStop(0, "#ffd23e");
    grad.addColorStop(1, "#f0a818");
    ctx.fillStyle = grad;
    roundRectPath(ctx, -s * 0.1, -s * 0.2, s * 0.2, s * 0.24, s * 0.07);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Arms: idle = ready pose out to the sides; dive = both stretched to the ball side.
    ctx.strokeStyle = "#ffd23e";
    ctx.lineWidth = s * 0.05;
    const armReach = s * (0.16 + 0.22 * diveP);
    const armAngle = diveP > 0 ? -0.45 : 0.55; // up when diving
    ctx.beginPath();
    if (diveP > 0) {
      ctx.moveTo(-s * 0.02, -s * 0.14);
      ctx.lineTo(armReach, -s * 0.14 + armReach * armAngle);
      ctx.moveTo(s * 0.02, -s * 0.1);
      ctx.lineTo(armReach * 1.1, -s * 0.1 + armReach * armAngle * 1.1);
    } else {
      ctx.moveTo(-s * 0.09, -s * 0.13);
      ctx.lineTo(-s * 0.09 - armReach * 0.8, -s * 0.13 + armReach * armAngle);
      ctx.moveTo(s * 0.09, -s * 0.13);
      ctx.lineTo(s * 0.09 + armReach * 0.8, -s * 0.13 + armReach * armAngle);
    }
    ctx.stroke();
    // Gloves (oversized — cartoon).
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "rgba(0,0,0,0.2)";
    ctx.lineWidth = 2;
    const gloves = diveP > 0
      ? [[armReach, -s * 0.14 + armReach * armAngle], [armReach * 1.1, -s * 0.1 + armReach * armAngle * 1.1]]
      : [[-s * 0.09 - armReach * 0.8, -s * 0.13 + armReach * armAngle], [s * 0.09 + armReach * 0.8, -s * 0.13 + armReach * armAngle]];
    for (const [gxp, gyp] of gloves) {
      ctx.beginPath();
      ctx.arc(gxp, gyp, s * 0.052, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Big cartoon head.
    ctx.beginPath();
    ctx.arc(0, -s * 0.3, s * 0.105, 0, Math.PI * 2);
    ctx.fillStyle = "#f2c39a";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.15)";
    ctx.stroke();
    // Hair band.
    ctx.beginPath();
    ctx.arc(0, -s * 0.315, s * 0.105, Math.PI * 1.05, Math.PI * 1.95);
    ctx.strokeStyle = "#7a4a2b";
    ctx.lineWidth = s * 0.035;
    ctx.stroke();
    // Eyes track the ball side.
    const eyeShift = this.flip() * gx * s * 0.03 + (diveP > 0 ? this.flip() * s * 0.012 : 0);
    ctx.fillStyle = "#20242a";
    ctx.beginPath();
    ctx.arc(-s * 0.035 + eyeShift, -s * 0.31, s * 0.014, 0, Math.PI * 2);
    ctx.arc(s * 0.035 + eyeShift, -s * 0.31, s * 0.014, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /** Shooter figure: back view next to the ball; kick swing when the shot starts. */
  private drawShooterFigure(now: number, g: { h: number; bottom: number }): void {
    const { ctx, H } = this;
    const isKeeperView = this.role === "keeper";
    const b = this.ballStart();
    // In keeper view the shooter stands beyond the ball (far, small).
    const s = isKeeperView ? g.h * 0.65 : H * 0.34;
    const baseX = b.x + (isKeeperView ? -s * 0.16 : -s * 0.22);
    const baseY = b.y + (isKeeperView ? s * 0.02 : -s * 0.02);

    // Kick swing progress.
    let kick = 0;
    if (this.anim) {
      kick = Math.min(1, (now - this.anim.t0) / (KICK_MS / this.anim.speed));
      if (kick >= 1) kick = Math.max(0, 1 - (now - this.anim.t0 - KICK_MS / this.anim.speed) / 300); // follow-through fades
    }
    const swing = Math.sin(kick * Math.PI) * 1;

    const jersey = "#e6363c";

    ctx.save();
    ctx.translate(baseX, baseY);
    ctx.rotate(-swing * 0.12 * this.flipKick());

    // Shadow.
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.beginPath();
    ctx.ellipse(0, s * 0.15, s * 0.11, s * 0.032, 0, 0, Math.PI * 2);
    ctx.fill();

    // Standing leg.
    ctx.strokeStyle = "#1c2f52";
    ctx.lineCap = "round";
    ctx.lineWidth = s * 0.045;
    ctx.beginPath();
    ctx.moveTo(-s * 0.02, s * 0.0);
    ctx.lineTo(-s * 0.05, s * 0.14);
    ctx.stroke();
    // Kicking leg swings toward the ball.
    const kx = s * (0.06 + swing * 0.2);
    const ky = s * (0.14 - swing * 0.16);
    ctx.beginPath();
    ctx.moveTo(s * 0.02, 0);
    ctx.lineTo(kx, ky);
    ctx.stroke();
    ctx.fillStyle = "#222";
    ctx.beginPath();
    ctx.arc(kx, ky, s * 0.032, 0, Math.PI * 2);
    ctx.arc(-s * 0.05, s * 0.145, s * 0.032, 0, Math.PI * 2);
    ctx.fill();

    // Torso.
    const tg = ctx.createLinearGradient(0, -s * 0.2, 0, 0);
    tg.addColorStop(0, jersey);
    tg.addColorStop(1, "#b91f26");
    ctx.fillStyle = tg;
    roundRectPath(ctx, -s * 0.085, -s * 0.19, s * 0.17, s * 0.21, s * 0.06);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 2;
    ctx.stroke();
    // Number on the back (shooter view shows the back).
    if (!isKeeperView) {
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = `900 ${s * 0.1}px Nunito, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("10", 0, -s * 0.055);
    }

    // Arms (counter-swing).
    ctx.strokeStyle = jersey;
    ctx.lineWidth = s * 0.04;
    ctx.beginPath();
    ctx.moveTo(-s * 0.08, -s * 0.13);
    ctx.lineTo(-s * (0.13 + swing * 0.06), -s * (0.03 - swing * 0.03));
    ctx.moveTo(s * 0.08, -s * 0.13);
    ctx.lineTo(s * (0.13 - swing * 0.03), -s * (0.03 + swing * 0.06));
    ctx.stroke();

    // Head.
    ctx.beginPath();
    ctx.arc(0, -s * 0.27, s * 0.09, 0, Math.PI * 2);
    ctx.fillStyle = "#eab68b";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.15)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -s * 0.285, s * 0.09, Math.PI * 1.02, Math.PI * 1.98);
    ctx.strokeStyle = "#2b2b2b";
    ctx.lineWidth = s * 0.032;
    ctx.stroke();

    ctx.restore();
  }

  private flipKick(): number {
    return this.role === "keeper" ? -1 : 1;
  }

  // ---------- Ball & FX ----------

  private drawBall(now: number): void {
    const { ctx } = this;
    const start = this.ballStart();
    const gRect = this.goalRect();
    let x = start.x;
    let y = start.y;
    let r = this.role === "keeper" ? gRect.h * 0.055 : gRect.h * 0.085;
    let squash = 1;
    let flying = false;

    if (this.anim) {
      const a = this.anim;
      const res = a.result;
      const dur = res.flightMs / a.speed;
      const tFly = now - a.t0 - KICK_MS / a.speed;
      const p = Math.min(1, Math.max(0, tFly / dur));
      flying = tFly > 0 && p < 1;
      const target = this.goalToScreen(
        Math.max(-1.3, Math.min(1.3, res.bx)),
        Math.max(0, Math.min(1.3, res.by)),
      );
      const cxp = (start.x + target.x) / 2 + this.flip() * res.shot.curve * this.W * 0.18;
      const cyp = Math.min(start.y, target.y) - this.H * 0.1;
      const ip = 1 - p;
      x = ip * ip * start.x + 2 * ip * p * cxp + p * p * target.x;
      y = ip * ip * start.y + 2 * ip * p * cyp + p * p * target.y;
      if (this.role === "keeper") r = gRect.h * (0.045 + 0.05 * p);
      else r = gRect.h * (0.085 - 0.03 * p);

      // Kick squash just as the foot connects.
      const kp = (now - a.t0) / (KICK_MS / a.speed);
      if (kp > 0.7 && kp < 1.25) squash = 1 + 0.25 * Math.sin((kp - 0.7) / 0.55 * Math.PI);

      this.ballSpin += (0.12 + res.shot.power * 0.25) * (res.shot.curve >= 0 ? 1 : -1);

      // Trail.
      if (flying && !REDUCED_MOTION) {
        this.trail.push({ x, y, r, born: now });
        if (this.trail.length > 22) this.trail.shift();
      }

      if (p >= 1 && !a.impactDone) {
        a.impactDone = true;
        this.onImpact(res);
      }
    }

    // Trail behind the ball.
    for (const tr of this.trail) {
      const age = (now - tr.born) / 300;
      if (age > 1) continue;
      ctx.beginPath();
      ctx.arc(tr.x, tr.y, tr.r * (1 - age) * 0.75, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${0.22 * (1 - age)})`;
      ctx.fill();
    }

    // Shadow.
    ctx.beginPath();
    ctx.ellipse(x, Math.max(y + r * 1.3, this.goalRect().bottom + r), r * 0.9, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fill();

    // Ball body with skin + rotating cartoon patches.
    const shooterIdx = ((this.anim?.result.kickIndex ?? 0) % 2) as 0 | 1;
    const skin = skinColors(this.start.players[shooterIdx]?.ballSkin);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(squash, 2 - squash);
    ctx.rotate(this.ballSpin);
    const grad = ctx.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.2, 0, 0, r);
    grad.addColorStop(0, skin[0]);
    grad.addColorStop(0.75, skin[0]);
    grad.addColorStop(1, "rgba(0,0,0,0.25)");
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = "#f2f4f1";
    ctx.fill();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.3)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Patches in the skin's secondary color make the spin readable.
    ctx.fillStyle = skin[1];
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(Math.cos(ang) * r * 0.55, Math.sin(ang) * r * 0.55, r * 0.24, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
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
    const power = Math.min(1, Math.hypot(b.x - a.x, a.y - b.y) / (this.H * 0.5));
    ctx.beginPath();
    ctx.arc(a.x, a.y, this.H * 0.03, -Math.PI / 2, -Math.PI / 2 + power * Math.PI * 2);
    ctx.strokeStyle = power > 0.8 ? "#e6363c" : "#ff8a1e";
    ctx.lineWidth = 6;
    ctx.stroke();
  }

  // ---------- Particles ----------

  private burst(x: number, y: number, kind: "goal" | "save" | "post" | "out"): void {
    if (REDUCED_MOTION) return;
    const add = (n: number, mk: () => Partial<Particle>) => {
      for (let i = 0; i < n; i++) {
        this.particles.push({
          x, y, vx: 0, vy: 0, life: 0, maxLife: 0.7, size: 4, color: "#fff",
          gravity: 500, kind: "dot", rot: Math.random() * 6, vr: (Math.random() - 0.5) * 8,
          ...mk(),
        } as Particle);
      }
    };
    if (kind === "goal") {
      const colors = ["#ffd23e", "#ff8a1e", "#27b55c", "#2f7ddb", "#ffffff"];
      add(26, () => ({
        vx: (Math.random() - 0.5) * 420,
        vy: -120 - Math.random() * 320,
        maxLife: 0.9 + Math.random() * 0.5,
        size: 4 + Math.random() * 5,
        color: colors[(Math.random() * colors.length) | 0],
        kind: "rect",
        gravity: 620,
      }));
    } else if (kind === "save") {
      add(14, () => ({
        vx: (Math.random() - 0.5) * 260,
        vy: -60 - Math.random() * 160,
        maxLife: 0.5 + Math.random() * 0.3,
        size: 3 + Math.random() * 4,
        color: "rgba(255,255,255,0.9)",
        gravity: 380,
      }));
    } else if (kind === "post") {
      add(12, () => ({
        vx: (Math.random() - 0.5) * 380,
        vy: (Math.random() - 0.5) * 380,
        maxLife: 0.35 + Math.random() * 0.2,
        size: 2.5 + Math.random() * 2.5,
        color: "#ffd23e",
        kind: "spark",
        gravity: 150,
      }));
    } else {
      add(8, () => ({
        vx: (Math.random() - 0.5) * 160,
        vy: -40 - Math.random() * 90,
        maxLife: 0.45,
        size: 3,
        color: "rgba(200,220,205,0.7)",
        gravity: 300,
      }));
    }
  }

  private stepParticles(dt: number): void {
    const { ctx } = this;
    this.particles = this.particles.filter((p) => (p.life += dt) < p.maxLife);
    for (const p of this.particles) {
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const a = 1 - p.life / p.maxLife;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      if (p.kind === "rect") ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      else if (p.kind === "spark") {
        ctx.fillRect(-p.size, -0.8, p.size * 2, 1.6);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    this.ctx.globalAlpha = 1;
  }

  // ---------- Result staging ----------

  private stepAnim(now: number): void {
    const a = this.anim!;
    const res = a.result;
    const dur = res.flightMs / a.speed + KICK_MS / a.speed;
    const done = now - a.t0 > dur + 600;
    if (!done) return;

    const spectacular = (res.outcome === "goal" || res.outcome === "saved") && res.shot.power > 0.65;
    if (spectacular && !a.replayed && !REDUCED_MOTION) {
      a.replayed = true;
      a.impactDone = true; // no double sfx
      a.speed = 0.45;
      a.t0 = now;
      this.trail = [];
      this.showBanner(t("replay"), (res.flightMs + KICK_MS) / 0.45);
      return;
    }
    this.anim = null;
    this.netImpact = null;
  }

  private onImpact(res: PenaltyResultMsg): void {
    this.score = res.score;
    this.scoreEl.textContent = `${res.score[0]} - ${res.score[1]}`;
    const shooter = (res.kickIndex % 2) as 0 | 1;
    this.history[shooter].push(res.outcome);

    const impact = this.goalToScreen(
      Math.max(-1.3, Math.min(1.3, res.bx)),
      Math.max(0, Math.min(1.3, res.by)),
    );

    const label = res.outcome === "goal" ? t("goal") : res.outcome === "saved" ? t("saved") : res.outcome === "post" ? t("post") : t("out");
    this.showBanner(label, 1600);
    if (res.outcome === "goal") {
      this.netImpact = { gx: res.bx, gy: res.by, t: performance.now() };
      this.burst(impact.x, impact.y, "goal");
      this.shake = 9;
      sfx.goal();
      haptic(shooter === this.youAre ? [50, 30, 100] : 80);
    } else if (res.outcome === "saved") {
      this.burst(impact.x, impact.y, "save");
      this.shake = 5;
      sfx.save();
      haptic(60);
    } else if (res.outcome === "post") {
      this.burst(impact.x, impact.y, "post");
      this.shake = 6;
      sfx.miss();
    } else {
      this.burst(impact.x, impact.y, "out");
      sfx.miss();
    }
  }

  dispose(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
  }
}

function easeOutQuart(p: number): number {
  return 1 - Math.pow(1 - p, 4);
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hgt: number, r: number): void {
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
