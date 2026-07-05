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
  gravity: number; kind: "rect" | "dot" | "spark" | "smoke";
  rot: number; vr: number;
}

interface Celebration {
  outcome: ShotOutcome;
  t0: number;
  x: number;
  y: number;
  shooterIdx: 0 | 1;
}

/** Run-up + kick swing before the ball leaves the foot. */
const KICK_MS = 680;

const REDUCED_MOTION = typeof matchMedia !== "undefined"
  && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Penalty shootout client — cartoon presentation with TV-style direction:
 * dynamic camera (push-in, punch on impact, letterboxed slow-mo replay),
 * volumetric floodlights, living characters (run-up, dives, celebrations)
 * and outcome VFX. The server decides outcomes; this renders them.
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
  celebration: Celebration | null = null;
  particles: Particle[] = [];
  trail: { x: number; y: number; r: number; born: number }[] = [];
  shake = 0;
  netImpact: { gx: number; gy: number; t: number } | null = null;
  ballSpin = 0;
  ballPos = { x: 0, y: 0 };
  gloveAnchor: { x: number; y: number } | null = null;
  lastT = 0;
  phaseT0 = 0;
  inReplay = false;

  // camera (world = untransformed layout coordinates)
  cam = { x: 0, y: 0, zoom: 1 };
  zoomKick = 0;
  grassPattern: CanvasPattern | null = null;

  banner: HTMLElement;
  scoreEl: HTMLElement;
  timerFill: HTMLElement;
  hintEl: HTMLElement;
  tvBanner: HTMLElement;
  letterbox: HTMLElement;
  replayTag: HTMLElement;
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

    // Broadcast lower-third for outcomes.
    this.tvBanner = h("div", { class: "tv-banner" });
    this.tvBanner.style.display = "none";
    wrap.appendChild(this.tvBanner);

    this.letterbox = h("div", { class: "letterbox" });
    wrap.appendChild(this.letterbox);
    this.replayTag = h("div", { class: "replay-tag" }, t("replay"));
    wrap.appendChild(this.replayTag);

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
    this.phaseT0 = performance.now();
    this.anim = null;
    this.celebration = null;
    this.myDive = null;
    this.dragPts = [];
    this.trail = [];
    this.netImpact = null;
    this.gloveAnchor = null;
    this.setReplayUI(false);

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
    if (msg.shot.power > 0.15) setTimeout(() => sfx.kick(), KICK_MS * 0.85);
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

  /** Pointer -> world coordinates (inverse of the camera transform). */
  private pt(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const z = this.cam.zoom + this.zoomKick;
    return {
      x: this.cam.x + (sx - this.W / 2) / z,
      y: this.cam.y + (sy - this.H / 2) / z,
    };
  }

  // ---------- Timer / banners ----------

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

  /** Broadcast lower-third: outcome + shooter name. */
  private showTv(label: string, sub: string, bad: boolean): void {
    this.tvBanner.className = `tv-banner${bad ? " tv-banner--out" : ""}`;
    this.tvBanner.innerHTML = "";
    const card = h("div", { class: "tv-banner__card" });
    card.appendChild(h("div", { class: "tv-banner__accent" }));
    card.appendChild(h("div", { class: "tv-banner__main" }, label));
    card.appendChild(h("div", { class: "tv-banner__sub" }, sub));
    this.tvBanner.appendChild(card);
    this.tvBanner.style.display = "";
    setTimeout(() => {
      this.tvBanner.classList.add("hide");
      setTimeout(() => { this.tvBanner.style.display = "none"; }, 320);
    }, 1900);
  }

  private setReplayUI(on: boolean): void {
    this.inReplay = on;
    this.letterbox.classList.toggle("on", on);
    this.replayTag.classList.toggle("on", on);
  }

  // ---------- Loop / camera ----------

  resize = (): void => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.W = this.wrap.clientWidth;
    this.H = this.wrap.clientHeight;
    this.canvas.width = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cam.x = this.W / 2;
    this.cam.y = this.H / 2;
    this.buildGrassPattern();
  };

  private buildGrassPattern(): void {
    const c = document.createElement("canvas");
    c.width = c.height = 56;
    const g = c.getContext("2d")!;
    for (let i = 0; i < 46; i++) {
      g.fillStyle = i % 2 ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.045)";
      g.fillRect(Math.random() * 56, Math.random() * 56, 1.6, 3.2);
    }
    this.grassPattern = this.ctx.createPattern(c, "repeat");
  }

  private loop = (now: number): void => {
    if (this.destroyed) return;
    if (this.W !== this.wrap.clientWidth || this.H !== this.wrap.clientHeight) this.resize();
    const dt = Math.min(0.05, (now - this.lastT) / 1000 || 0.016);
    this.lastT = now;
    this.updateCamera(now, dt);
    this.draw(now, dt);
    this.raf = requestAnimationFrame(this.loop);
  };

  private updateCamera(now: number, dt: number): void {
    let tx = this.W / 2;
    let ty = this.H / 2;
    let tz = 1;

    if (!REDUCED_MOTION) {
      if (this.phase === "input" && this.role === "shooter") {
        // Slow TV push-in while aiming.
        tz = 1 + Math.min(0.05, ((now - this.phaseT0) / 4000) * 0.05);
        ty = this.H * 0.52;
      } else if (this.anim && !this.anim.impactDone) {
        // Follow the ball during run-up and flight.
        tz = this.inReplay ? 1.17 : 1.08;
        tx = this.W / 2 + (this.ballPos.x - this.W / 2) * 0.3;
        ty = this.H / 2 + (this.ballPos.y - this.H / 2) * 0.18;
      } else if (this.celebration) {
        tz = 1.1;
        tx = this.W / 2 + (this.celebration.x - this.W / 2) * 0.3;
      }
    }

    const k = 1 - Math.exp(-dt * 5);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
    this.cam.zoom += (tz - this.cam.zoom) * k;
    this.zoomKick *= Math.exp(-dt * 7);
  }

  // ---------- Scene ----------

  private draw(now: number, dt: number): void {
    const { ctx, W, H } = this;
    const g = this.goalRect();

    ctx.clearRect(0, 0, W, H);
    ctx.save();

    // Camera.
    const z = this.cam.zoom + this.zoomKick;
    ctx.translate(W / 2, H / 2);
    ctx.scale(z, z);
    ctx.translate(-this.cam.x, -this.cam.y);
    if (this.shake > 0.3 && !REDUCED_MOTION) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
      this.shake *= Math.pow(0.02, dt);
    } else {
      this.shake = 0;
    }
    // Overdraw margin so zoom-out never shows canvas edges.
    const M = Math.max(W, H) * 0.2;

    this.drawSky(now, g, M);
    this.drawCrowd(now, g, M);
    this.drawAdBoards(g, M);
    this.drawPitch(g, M);
    this.drawBeams(now, g, M);
    this.drawGoal(now, g);

    if (this.role === "keeper" && this.phase === "input") this.drawZones(g);

    this.drawShooterFigure(now, g);
    this.drawKeeper(now, g);
    this.drawBall(now);

    if (this.dragging && this.dragPts.length > 1 && this.myShotsTaken < 2) this.drawAim();

    this.stepParticles(dt);
    this.drawImpactFlash(now);

    ctx.restore();

    // Screen-space vignette (unaffected by camera).
    const vg = ctx.createRadialGradient(W / 2, H * 0.45, H * 0.35, W / 2, H * 0.5, H * 0.85);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(4,20,12,0.42)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    if (this.anim) this.stepAnim(now);
  }

  /** Dusk sky, stadium roof and floodlight lamps. */
  private drawSky(now: number, g: { bottom: number }, M: number): void {
    const { ctx, W, H } = this;
    const sky = ctx.createLinearGradient(0, -M, 0, g.bottom);
    sky.addColorStop(0, "#0d1b3d");
    sky.addColorStop(0.55, "#1d3a6b");
    sky.addColorStop(1, "#2a5a8a");
    ctx.fillStyle = sky;
    ctx.fillRect(-M, -M, W + M * 2, g.bottom + M);

    ctx.fillStyle = "#091228";
    ctx.beginPath();
    ctx.moveTo(-M, H * 0.09);
    ctx.quadraticCurveTo(W / 2, H * 0.015, W + M, H * 0.09);
    ctx.lineTo(W + M, -M);
    ctx.lineTo(-M, -M);
    ctx.closePath();
    ctx.fill();

    const pulse = REDUCED_MOTION ? 1 : 0.92 + 0.08 * Math.sin(now / 900);
    for (const fx of [W * 0.08, W * 0.92]) {
      const lg = ctx.createRadialGradient(fx, H * 0.07, 0, fx, H * 0.07, W * 0.5);
      lg.addColorStop(0, `rgba(255,244,200,${0.4 * pulse})`);
      lg.addColorStop(1, "rgba(255,244,200,0)");
      ctx.fillStyle = lg;
      ctx.fillRect(-M, -M, W + M * 2, H * 0.55 + M);
      ctx.fillStyle = "#fff6cf";
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.arc(fx + i * 9, H * 0.065, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** Volumetric light shafts falling on the pitch; they flare on a goal. */
  private drawBeams(now: number, g: { bottom: number }, M: number): void {
    if (REDUCED_MOTION) return;
    const { ctx, W, H } = this;
    const goalGlow = this.celebration?.outcome === "goal"
      ? Math.max(0, 1 - (now - this.celebration.t0) / 1500) : 0;
    const alpha = 0.055 + goalGlow * 0.09;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const [lx, dir] of [[W * 0.08, 1], [W * 0.92, -1]] as [number, number][]) {
      const sway = Math.sin(now / 2600 + dir) * W * 0.02;
      const grad = ctx.createLinearGradient(lx, H * 0.06, lx + dir * W * 0.2, H);
      grad.addColorStop(0, `rgba(255,246,210,${alpha * 1.6})`);
      grad.addColorStop(1, "rgba(255,246,210,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(lx, H * 0.06);
      ctx.lineTo(lx + dir * W * 0.14 + sway, H + M);
      ctx.lineTo(lx + dir * W * 0.52 + sway, H + M);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /** Two crowd tiers; on a goal they do the wave with smoke and flashes. */
  private drawCrowd(now: number, g: { bottom: number }, M: number): void {
    const { ctx, W, H } = this;
    const top = H * 0.1;
    const bottom = g.bottom - H * 0.115;
    ctx.fillStyle = "#12213f";
    ctx.fillRect(-M, top, W + M * 2, bottom - top);

    const celebrating = this.celebration?.outcome === "goal";
    const waveT = celebrating ? (now - this.celebration!.t0) / 1000 : 0;

    const colors = ["#e6636a", "#5f8fd9", "#e8c05a", "#67b06f", "#b78ad0", "#d9d9e0"];
    const step = Math.max(11, W / 46);
    let row = 0;
    for (let y = top + 8; y < bottom - 4; y += step * 0.82) {
      row++;
      for (let x = (row % 2 ? step / 2 : 4) - step; x < W + step; x += step) {
        const seed = (x * 13 + row * 71) | 0;
        let bob = REDUCED_MOTION ? 0 : Math.sin(now / 480 + seed) * 1.6;
        if (celebrating && !REDUCED_MOTION) {
          // Travelling wave: arms-up ripple sweeping the stands.
          bob -= Math.max(0, Math.sin(x / W * Math.PI * 2 - waveT * 5)) * step * 0.5;
        }
        ctx.fillStyle = colors[seed % colors.length];
        ctx.beginPath();
        ctx.arc(x, y + bob, step * 0.26, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (!REDUCED_MOTION) {
      const flashN = celebrating ? 9 : 3;
      for (let i = 0; i < flashN; i++) {
        const s = ((now / 120) | 0) * 7 + i * 131;
        if ((s * 2654435761 % 97) < (celebrating ? 22 : 6)) {
          const fx2 = (s * 48271 % 1000) / 1000 * W;
          const fy = top + ((s * 16807 % 1000) / 1000) * (bottom - top);
          ctx.fillStyle = "rgba(255,255,255,0.9)";
          ctx.beginPath();
          ctx.arc(fx2, fy, 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    ctx.fillRect(-M, (top + bottom) / 2, W + M * 2, 2);
  }

  private drawAdBoards(g: { bottom: number }, M: number): void {
    const { ctx, W, H } = this;
    const bh = H * 0.045;
    const y = g.bottom - H * 0.115;
    const palette: [string, string][] = [
      ["#ff8a1e", "#ffffff"], ["#1d9a4b", "#ffd23e"], ["#2f7ddb", "#ffffff"], ["#e6363c", "#ffffff"],
    ];
    const bw = W / 4;
    for (let i = -1; i < 5; i++) {
      const [bg, fg] = palette[((i % 4) + 4) % 4];
      ctx.fillStyle = bg;
      ctx.fillRect(i * bw, y, bw - 3, bh);
      ctx.fillStyle = fg;
      const cx = i * bw + bw / 2;
      ctx.fillRect(cx - bw * 0.26, y + bh * 0.38, bw * 0.34, bh * 0.24);
      ctx.beginPath();
      ctx.arc(cx - bw * 0.33, y + bh * 0.5, bh * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(-M, y + bh, W + M * 2, 3);
  }

  private drawPitch(g: { cx: number; w: number; bottom: number }, M: number): void {
    const { ctx, W, H } = this;
    const grass = ctx.createLinearGradient(0, g.bottom - H * 0.07, 0, H);
    grass.addColorStop(0, "#2fa457");
    grass.addColorStop(1, "#177a3c");
    ctx.fillStyle = grass;
    ctx.fillRect(-M, g.bottom - H * 0.07, W + M * 2, H + M * 2);

    ctx.fillStyle = "rgba(255,255,255,0.06)";
    let y = g.bottom;
    let sh = H * 0.028;
    let odd = false;
    while (y < H + M) {
      if (odd) ctx.fillRect(-M, y, W + M * 2, sh);
      y += sh;
      sh *= 1.35;
      odd = !odd;
    }
    // Blade texture.
    if (this.grassPattern) {
      ctx.fillStyle = this.grassPattern;
      ctx.fillRect(-M, g.bottom, W + M * 2, H - g.bottom + M);
    }

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

    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-M, g.bottom);
    ctx.lineTo(W + M, g.bottom);
    ctx.stroke();

    if (this.role !== "keeper") {
      const b = this.ballStart();
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.beginPath();
      ctx.ellipse(b.x, b.y + this.H * 0.035, 7, 3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawGoal(now: number, g: { cx: number; w: number; h: number; bottom: number; top: number }): void {
    const { ctx } = this;
    const x0 = g.cx - g.w / 2;
    const postW = Math.max(6, g.w * 0.02);

    ctx.fillStyle = "rgba(10,30,20,0.25)";
    ctx.fillRect(x0, g.top, g.w, g.h);

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

    // Posts: dark back edge, white body, glossy highlight.
    ctx.lineCap = "round";
    const frame = () => {
      ctx.beginPath();
      ctx.moveTo(x0, g.bottom);
      ctx.lineTo(x0, g.top);
      ctx.lineTo(x0 + g.w, g.top);
      ctx.lineTo(x0 + g.w, g.bottom);
      ctx.stroke();
    };
    ctx.strokeStyle = "#9aa69f";
    ctx.lineWidth = postW + 3;
    frame();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = postW;
    frame();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = postW * 0.3;
    ctx.beginPath();
    ctx.moveTo(x0 - postW * 0.22, g.bottom);
    ctx.lineTo(x0 - postW * 0.22, g.top - postW * 0.22);
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

  /** Character ground shadow, stretched away from the nearest floodlight. */
  private groundShadow(x: number, y: number, w: number, hgt: number): void {
    const { ctx } = this;
    const away = x < this.W / 2 ? 1 : -1;
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath();
    ctx.ellipse(x + away * w * 0.35, y, w, hgt, away * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Cartoon keeper: idle crouch, full dive, then a held save (ball in gloves)
   * or floored despair after conceding.
   */
  private drawKeeper(now: number, g: { cx: number; w: number; h: number; bottom: number; top: number }): void {
    const { ctx } = this;
    const s = g.h;
    const cel = this.celebration;
    const afterSave = cel?.outcome === "saved" && (now - cel.t0) > 250;
    const afterGoal = cel?.outcome === "goal";

    let gx = 0;
    let gy = 0.42;
    let diveP = 0;
    if (this.anim?.result.dive) {
      const zc = zoneCenter(this.anim.result.dive.col, this.anim.result.dive.row);
      const dur = (this.anim.result.flightMs / this.anim.speed) * 0.85;
      diveP = easeOutQuart(Math.min(1, Math.max(0, (now - this.anim.t0 - KICK_MS * 0.55 / this.anim.speed) / dur)));
      gx = zc.x * diveP;
      gy = 0.42 + (Math.max(0.2, zc.y) - 0.42) * diveP;
    }
    if (afterSave) {
      // Get up in the middle holding the ball.
      const up = easeOutQuart(Math.min(1, (now - cel!.t0 - 250) / 600));
      gx = gx * (1 - up);
      gy = 0.42;
      diveP *= (1 - up);
    }

    const pos = this.goalToScreen(gx, Math.max(0.1, gy - 0.22));
    const idleBob = REDUCED_MOTION || diveP > 0 ? 0 : Math.sin(now / 300) * s * 0.012;
    const sway = REDUCED_MOTION || diveP > 0 ? 0 : Math.sin(now / 700) * s * 0.05;
    const x = pos.x + sway;
    let y = pos.y + idleBob;
    let lean = this.flip() * gx * 0.9 * diveP;

    // Conceded: lying flat on the grass.
    let floorP = 0;
    if (afterGoal) {
      floorP = easeOutQuart(Math.min(1, (now - cel!.t0) / 550));
      lean = lean * (1 - floorP) + (lean >= 0 ? 1 : -1) * (Math.PI / 2) * floorP;
      y += s * 0.16 * floorP;
    }

    this.groundShadow(x, this.goalRect().bottom + s * 0.02, s * (0.16 + diveP * 0.1 + floorP * 0.12), s * 0.045);

    ctx.save();
    ctx.translate(x, y);
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
    ctx.fillStyle = "#222";
    ctx.beginPath();
    ctx.arc(-legSpread, s * 0.145, s * 0.035, 0, Math.PI * 2);
    ctx.arc(legSpread * (diveP > 0 ? 1.6 : 1), s * (0.145 - 0.06 * diveP), s * 0.035, 0, Math.PI * 2);
    ctx.fill();

    // Torso.
    const grad = ctx.createLinearGradient(0, -s * 0.22, 0, s * 0.05);
    grad.addColorStop(0, "#ffd23e");
    grad.addColorStop(1, "#f0a818");
    ctx.fillStyle = grad;
    roundRectPath(ctx, -s * 0.1, -s * 0.2, s * 0.2, s * 0.24, s * 0.07);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Arms + gloves.
    ctx.strokeStyle = "#ffd23e";
    ctx.lineWidth = s * 0.05;
    let gloves: [number, number][];
    if (afterSave) {
      // Ball held high above the head.
      const gy2 = -s * 0.52;
      ctx.beginPath();
      ctx.moveTo(-s * 0.07, -s * 0.15);
      ctx.lineTo(-s * 0.05, gy2 + s * 0.06);
      ctx.moveTo(s * 0.07, -s * 0.15);
      ctx.lineTo(s * 0.05, gy2 + s * 0.06);
      ctx.stroke();
      gloves = [[-s * 0.05, gy2 + s * 0.04], [s * 0.05, gy2 + s * 0.04]];
      this.gloveAnchor = { x: x + 0 * Math.cos(lean), y: y + gy2 };
    } else if (diveP > 0) {
      const armReach = s * (0.16 + 0.22 * diveP);
      const armAngle = -0.45;
      ctx.beginPath();
      ctx.moveTo(-s * 0.02, -s * 0.14);
      ctx.lineTo(armReach, -s * 0.14 + armReach * armAngle);
      ctx.moveTo(s * 0.02, -s * 0.1);
      ctx.lineTo(armReach * 1.1, -s * 0.1 + armReach * armAngle * 1.1);
      ctx.stroke();
      gloves = [[armReach, -s * 0.14 + armReach * armAngle], [armReach * 1.1, -s * 0.1 + armReach * armAngle * 1.1]];
      const tip = gloves[1];
      this.gloveAnchor = {
        x: x + tip[0] * Math.cos(lean) - tip[1] * Math.sin(lean),
        y: y + tip[0] * Math.sin(lean) + tip[1] * Math.cos(lean),
      };
    } else {
      const armReach = s * 0.16;
      const armAngle = 0.55;
      ctx.beginPath();
      ctx.moveTo(-s * 0.09, -s * 0.13);
      ctx.lineTo(-s * 0.09 - armReach * 0.8, -s * 0.13 + armReach * armAngle);
      ctx.moveTo(s * 0.09, -s * 0.13);
      ctx.lineTo(s * 0.09 + armReach * 0.8, -s * 0.13 + armReach * armAngle);
      ctx.stroke();
      gloves = [[-s * 0.09 - armReach * 0.8, -s * 0.13 + armReach * armAngle], [s * 0.09 + armReach * 0.8, -s * 0.13 + armReach * armAngle]];
      this.gloveAnchor = null;
    }
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "rgba(0,0,0,0.2)";
    ctx.lineWidth = 2;
    for (const [gxp, gyp] of gloves) {
      ctx.beginPath();
      ctx.arc(gxp, gyp, s * 0.052, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Head + face.
    ctx.beginPath();
    ctx.arc(0, -s * 0.3, s * 0.105, 0, Math.PI * 2);
    ctx.fillStyle = "#f2c39a";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.15)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -s * 0.315, s * 0.105, Math.PI * 1.05, Math.PI * 1.95);
    ctx.strokeStyle = "#7a4a2b";
    ctx.lineWidth = s * 0.035;
    ctx.stroke();
    const flying = !!this.anim && !this.anim.impactDone;
    const eyeR = s * (flying ? 0.02 : 0.014);
    const eyeShift = this.flip() * gx * s * 0.03;
    ctx.fillStyle = "#20242a";
    ctx.beginPath();
    ctx.arc(-s * 0.035 + eyeShift, -s * 0.31, eyeR, 0, Math.PI * 2);
    ctx.arc(s * 0.035 + eyeShift, -s * 0.31, eyeR, 0, Math.PI * 2);
    ctx.fill();
    // Mouth: smile after a save, dismay after conceding.
    ctx.strokeStyle = "#5a3a28";
    ctx.lineWidth = s * 0.012;
    ctx.beginPath();
    if (afterSave) ctx.arc(eyeShift, -s * 0.275, s * 0.032, 0.15 * Math.PI, 0.85 * Math.PI);
    else if (afterGoal) ctx.arc(eyeShift, -s * 0.25, s * 0.02, 0, Math.PI * 2);
    else ctx.arc(eyeShift, -s * 0.29, s * 0.045, 0.3 * Math.PI, 0.7 * Math.PI);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Shooter: real run-up (steps in from behind the spot), kick with
   * follow-through, then knee-slide celebration or hands-on-head despair.
   */
  private drawShooterFigure(now: number, g: { h: number; bottom: number }): void {
    const { ctx, H } = this;
    const isKeeperView = this.role === "keeper";
    const b = this.ballStart();
    const s = isKeeperView ? g.h * 0.65 : H * 0.34;
    const cel = this.celebration;

    // Run-up progress.
    let k = 0;
    if (this.anim) k = Math.min(1, (now - this.anim.t0) / (KICK_MS / this.anim.speed));
    const runP = Math.min(1, k / 0.82);
    const swingP = k < 0.82 ? 0 : (k - 0.82) / 0.18;
    const swing = Math.sin(Math.min(1, swingP) * Math.PI);

    // Base position: approaches the ball during the run-up.
    const dir = this.flipKick();
    const startOff = { x: -dir * s * 0.7, y: s * 0.22 };
    const restOff = { x: -dir * s * 0.22, y: -s * 0.02 };
    let px = b.x + startOff.x + (restOff.x - startOff.x) * easeOutQuart(runP || (this.anim ? 0 : 1));
    let py = b.y + startOff.y + (restOff.y - startOff.y) * easeOutQuart(runP || (this.anim ? 0 : 1));
    if (!this.anim) { px = b.x + restOff.x; py = b.y + restOff.y; }
    const stepBob = this.anim && runP < 1 && !REDUCED_MOTION ? Math.abs(Math.sin(runP * Math.PI * 3)) * s * 0.03 : 0;
    py -= stepBob;

    // Celebration displacement: knee slide toward the camera-left.
    let slideP = 0;
    let despair = false;
    if (cel && (!isKeeperView || true)) {
      const isGoal = cel.outcome === "goal";
      if (isGoal) {
        slideP = easeOutQuart(Math.min(1, (now - cel.t0) / 1100));
        px += -dir * s * 0.5 * slideP;
        py += s * 0.1 * slideP;
      } else {
        despair = (now - cel.t0) > 150;
      }
    }

    const legCycle = this.anim && runP < 1 && !REDUCED_MOTION ? Math.sin(runP * Math.PI * 6) : 0;

    this.groundShadow(px, py + s * 0.15, s * 0.11, s * 0.032);

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-swing * 0.12 * dir - slideP * 0.35 * dir);

    // Legs: cycle during the run, swing on the kick, kneel on the slide.
    ctx.strokeStyle = "#1c2f52";
    ctx.lineCap = "round";
    ctx.lineWidth = s * 0.045;
    if (slideP > 0.15) {
      // Knee slide: both legs folded back.
      ctx.beginPath();
      ctx.moveTo(-s * 0.02, 0);
      ctx.lineTo(-dir * s * 0.14, s * 0.12);
      ctx.moveTo(s * 0.02, 0);
      ctx.lineTo(-dir * s * 0.08, s * 0.14);
      ctx.stroke();
    } else {
      const kx = s * (0.06 + swing * 0.2) * dir + legCycle * s * 0.05;
      const ky = s * (0.14 - swing * 0.16);
      ctx.beginPath();
      ctx.moveTo(-s * 0.02 * dir, 0);
      ctx.lineTo(-s * 0.05 * dir - legCycle * s * 0.05, s * 0.14);
      ctx.moveTo(s * 0.02 * dir, 0);
      ctx.lineTo(kx, ky);
      ctx.stroke();
      ctx.fillStyle = "#222";
      ctx.beginPath();
      ctx.arc(kx, ky, s * 0.032, 0, Math.PI * 2);
      ctx.arc(-s * 0.05 * dir - legCycle * s * 0.05, s * 0.145, s * 0.032, 0, Math.PI * 2);
      ctx.fill();
    }

    // Torso.
    const jersey = "#e6363c";
    const tg = ctx.createLinearGradient(0, -s * 0.2, 0, 0);
    tg.addColorStop(0, jersey);
    tg.addColorStop(1, "#b91f26");
    ctx.fillStyle = tg;
    roundRectPath(ctx, -s * 0.085, -s * 0.19, s * 0.17, s * 0.21, s * 0.06);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 2;
    ctx.stroke();
    if (!isKeeperView) {
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = `900 ${s * 0.1}px Nunito, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("10", 0, -s * 0.055);
    }

    // Arms: pumping in the run, wide on the slide, on the head in despair.
    ctx.strokeStyle = jersey;
    ctx.lineWidth = s * 0.04;
    ctx.beginPath();
    if (slideP > 0.15) {
      ctx.moveTo(-s * 0.08, -s * 0.13);
      ctx.lineTo(-s * 0.22, -s * 0.22);
      ctx.moveTo(s * 0.08, -s * 0.13);
      ctx.lineTo(s * 0.22, -s * 0.22);
    } else if (despair) {
      ctx.moveTo(-s * 0.08, -s * 0.13);
      ctx.lineTo(-s * 0.05, -s * 0.3);
      ctx.moveTo(s * 0.08, -s * 0.13);
      ctx.lineTo(s * 0.05, -s * 0.3);
    } else {
      const pump = legCycle * s * 0.06;
      ctx.moveTo(-s * 0.08, -s * 0.13);
      ctx.lineTo(-s * (0.13 + swing * 0.06), -s * 0.03 + pump);
      ctx.moveTo(s * 0.08, -s * 0.13);
      ctx.lineTo(s * (0.13 - swing * 0.03), -s * 0.03 - pump);
    }
    ctx.stroke();

    // Head + face.
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
    if (isKeeperView || cel) {
      ctx.fillStyle = "#20242a";
      ctx.beginPath();
      ctx.arc(-s * 0.028, -s * 0.275, s * 0.012, 0, Math.PI * 2);
      ctx.arc(s * 0.028, -s * 0.275, s * 0.012, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#7a4a2b";
      ctx.lineWidth = s * 0.011;
      ctx.beginPath();
      if (cel?.outcome === "goal") ctx.arc(0, -s * 0.25, s * 0.028, 0.15 * Math.PI, 0.85 * Math.PI);
      else if (despair) ctx.arc(0, -s * 0.235, s * 0.016, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();

    // Grass spray behind the knee slide.
    if (slideP > 0.1 && slideP < 0.85 && !REDUCED_MOTION && Math.random() < 0.5) {
      this.particles.push({
        x: px + dir * s * 0.15, y: py + s * 0.14,
        vx: dir * (40 + Math.random() * 80), vy: -60 - Math.random() * 80,
        life: 0, maxLife: 0.45, size: 2.5 + Math.random() * 2,
        color: "#1f8f47", gravity: 500, kind: "dot", rot: 0, vr: 0,
      });
    }
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
    let groundY = start.y;

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
      groundY = start.y + (gRect.bottom - start.y) * p;
      if (this.role === "keeper") r = gRect.h * (0.045 + 0.05 * p);
      else r = gRect.h * (0.085 - 0.03 * p);

      const kp = (now - a.t0) / (KICK_MS / a.speed);
      if (kp > 0.82 && kp < 1.2) squash = 1 + 0.25 * Math.sin((kp - 0.82) / 0.38 * Math.PI);

      this.ballSpin += (0.12 + res.shot.power * 0.25) * (res.shot.curve >= 0 ? 1 : -1);

      if (flying && !REDUCED_MOTION) {
        this.trail.push({ x, y, r, born: now });
        if (this.trail.length > 22) this.trail.shift();
      }

      if (p >= 1 && !a.impactDone) {
        a.impactDone = true;
        this.onImpact(res);
      }
      // A held save: the ball lives in the keeper's gloves.
      if (a.impactDone && this.celebration?.outcome === "saved" && this.gloveAnchor) {
        x = this.gloveAnchor.x;
        y = this.gloveAnchor.y;
        groundY = gRect.bottom;
      }
    }
    this.ballPos = { x, y };

    for (const tr of this.trail) {
      const age = (now - tr.born) / 300;
      if (age > 1) continue;
      ctx.beginPath();
      ctx.arc(tr.x, tr.y, tr.r * (1 - age) * 0.75, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${0.22 * (1 - age)})`;
      ctx.fill();
    }

    // Height-aware shadow: shrinks and fades while the ball is airborne.
    const height = Math.max(0, groundY - y);
    const sc = Math.max(0.35, 1 - height / (this.H * 0.55));
    ctx.beginPath();
    ctx.ellipse(x, Math.max(groundY, gRect.bottom * 0.99) + r * 0.6, r * 0.9 * sc, r * 0.3 * sc, 0, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0,0,0,${0.28 * sc})`;
    ctx.fill();

    const shooterIdx = ((this.anim?.result.kickIndex ?? 0) % 2) as 0 | 1;
    const skin = skinColors(this.start.players[shooterIdx]?.ballSkin);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(squash, 2 - squash);
    ctx.rotate(this.ballSpin);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = "#f2f4f1";
    ctx.fill();
    const grad = ctx.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.2, 0, 0, r);
    grad.addColorStop(0, skin[0]);
    grad.addColorStop(0.75, skin[0]);
    grad.addColorStop(1, "rgba(0,0,0,0.25)");
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.3)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = skin[1];
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(Math.cos(ang) * r * 0.55, Math.sin(ang) * r * 0.55, r * 0.24, 0, Math.PI * 2);
      ctx.fill();
    }
    // Specular glint from the floodlights.
    ctx.rotate(-this.ballSpin);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.beginPath();
    ctx.ellipse(-r * 0.35, -r * 0.42, r * 0.22, r * 0.13, -0.6, 0, Math.PI * 2);
    ctx.fill();
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

  /** Additive bloom flash right at the impact moment. */
  private drawImpactFlash(now: number): void {
    const cel = this.celebration;
    if (!cel || REDUCED_MOTION) return;
    const p = (now - cel.t0) / 260;
    if (p > 1) return;
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const r = this.H * 0.22 * (0.4 + p);
    const grad = ctx.createRadialGradient(cel.x, cel.y, 0, cel.x, cel.y, r);
    grad.addColorStop(0, `rgba(255,255,240,${0.5 * (1 - p)})`);
    grad.addColorStop(1, "rgba(255,255,240,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cel.x, cel.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
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
      add(38, () => ({
        vx: (Math.random() - 0.5) * 460,
        vy: -120 - Math.random() * 340,
        maxLife: 0.9 + Math.random() * 0.6,
        size: 4 + Math.random() * 5,
        color: colors[(Math.random() * colors.length) | 0],
        kind: "rect",
        gravity: 620,
      }));
      // Smoke flares rising from the stands.
      const smokeColors = ["rgba(230,54,60,0.16)", "rgba(255,210,62,0.14)", "rgba(255,255,255,0.1)"];
      add(7, () => ({
        x: Math.random() * this.W,
        y: this.H * (0.14 + Math.random() * 0.2),
        vx: (Math.random() - 0.5) * 25,
        vy: -18 - Math.random() * 22,
        maxLife: 2.4,
        size: 26 + Math.random() * 26,
        color: smokeColors[(Math.random() * smokeColors.length) | 0],
        kind: "smoke",
        gravity: -6,
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
      else if (p.kind === "spark") ctx.fillRect(-p.size, -0.8, p.size * 2, 1.6);
      else if (p.kind === "smoke") {
        const grow = 1 + p.life / p.maxLife;
        ctx.beginPath();
        ctx.arc(0, 0, p.size * grow, 0, Math.PI * 2);
        ctx.fill();
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
    const dur = (res.flightMs + KICK_MS) / a.speed;
    const done = now - a.t0 > dur + 650;
    if (!done) return;

    const spectacular = (res.outcome === "goal" || res.outcome === "saved") && res.shot.power > 0.65;
    if (spectacular && !a.replayed && !REDUCED_MOTION) {
      a.replayed = true;
      a.impactDone = true; // no double sfx
      a.speed = 0.45;
      a.t0 = now;
      this.trail = [];
      this.celebration = null;
      this.setReplayUI(true);
      return;
    }
    this.anim = null;
    this.netImpact = null;
    this.setReplayUI(false);
  }

  private onImpact(res: PenaltyResultMsg): void {
    this.score = res.score;
    this.scoreEl.textContent = `${res.score[0]} - ${res.score[1]}`;
    const shooter = (res.kickIndex % 2) as 0 | 1;
    // Only push history on the live pass, not on the replay.
    if (!this.inReplay) this.history[shooter].push(res.outcome);

    const impact = this.goalToScreen(
      Math.max(-1.3, Math.min(1.3, res.bx)),
      Math.max(0, Math.min(1.3, res.by)),
    );
    this.celebration = {
      outcome: res.outcome,
      t0: performance.now(),
      x: impact.x,
      y: impact.y,
      shooterIdx: shooter,
    };

    const label = res.outcome === "goal" ? t("goal") : res.outcome === "saved" ? t("saved") : res.outcome === "post" ? t("post") : t("out");
    const shooterName = this.start.players[shooter].name;
    const bad = res.outcome === "out" || res.outcome === "post";
    if (!this.inReplay) this.showTv(label, shooterName, bad);

    if (res.outcome === "goal") {
      this.netImpact = { gx: res.bx, gy: res.by, t: performance.now() };
      this.burst(impact.x, impact.y, "goal");
      this.shake = 9;
      this.zoomKick = 0.1;
      if (!this.inReplay) {
        sfx.goal();
        haptic(shooter === this.youAre ? [50, 30, 100] : 80);
      }
    } else if (res.outcome === "saved") {
      this.burst(impact.x, impact.y, "save");
      this.shake = 5;
      this.zoomKick = 0.07;
      if (!this.inReplay) {
        sfx.save();
        haptic(60);
      }
    } else if (res.outcome === "post") {
      this.burst(impact.x, impact.y, "post");
      this.shake = 6;
      this.zoomKick = 0.05;
      if (!this.inReplay) sfx.miss();
    } else {
      this.burst(impact.x, impact.y, "out");
      if (!this.inReplay) sfx.miss();
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
