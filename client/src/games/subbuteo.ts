import { SUBBUTEO as C } from "../../../shared/src/constants";
import type {
  MatchEndMsg, MatchStartMsg, SubbuteoSnapshot, TurnMsg,
} from "../../../shared/src/types";
import { t } from "../i18n";
import type { GameChannel } from "../net/channel";
import { confetti, confirmModal, haptic, sfx, toast } from "../ui/fx";
import { go, register } from "../ui/nav";
import { Screen, h } from "../ui/router";
import { showResult } from "../screens/resultOverlay";
import type { Mode } from "../screens/pregame";

interface Params {
  channel: GameChannel;
  start: MatchStartMsg;
  mode?: Mode;
}

const TEAM_COLORS: [string, string][] = [
  ["#e6363c", "#7a0d10"], // team 0
  ["#2f7ddb", "#123a75"], // team 1
];

/**
 * Subbuteo client: top-down cloth pitch, flick your discs on your turn.
 * Physics run on the server (or the local emulator); this class renders
 * interpolated snapshots and captures flick input.
 */
class SubbuteoGame {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  raf = 0;
  W = 0;
  H = 0;
  scale = 1;
  ox = 0;
  oy = 0;

  youAre: 0 | 1;
  myTurn = false;
  moving = false;
  score: [number, number] = [0, 0];
  turnIndex = 0;

  prev: SubbuteoSnapshot | null = null;
  next: SubbuteoSnapshot | null = null;
  recvAt = 0;

  dragging = false;
  dragDisc = -1;
  dragStart = { x: 0, y: 0 };
  dragNow = { x: 0, y: 0 };

  banner: HTMLElement;
  scoreEl: HTMLElement;
  turnsEl: HTMLElement;
  timerFill: HTMLElement;
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

    const hud = h("div", { class: "hud-top" });
    const p0 = h("span", { class: "hud-name" }, start.players[0].name);
    this.scoreEl = h("span", { class: "hud-score" }, "0 - 0");
    const p1 = h("span", { class: "hud-name" }, start.players[1].name);
    hud.append(p0, this.scoreEl, p1);
    wrap.appendChild(hud);

    this.turnsEl = h("div", { style: "position:absolute;top:calc(48px + var(--safe-top));left:0;right:0;text-align:center;color:#fff;font-size:.7rem;font-weight:700;opacity:.75;pointer-events:none" });
    wrap.appendChild(this.turnsEl);

    this.banner = h("div", { class: "hud-banner" });
    this.banner.style.display = "none";
    wrap.appendChild(this.banner);

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
    this.loop();
    sfx.whistle();
  }

  // ---------- Net ----------

  private bindNet(): void {
    this.channel.on("board", (s: SubbuteoSnapshot) => {
      this.prev = this.next = s;
      this.moving = false;
    });
    this.channel.on("snap", (s: SubbuteoSnapshot) => {
      this.prev = this.next ?? s;
      this.next = s;
      this.recvAt = performance.now();
      this.moving = s.moving;
    });
    this.channel.on("turn", (msg: TurnMsg) => {
      this.turnIndex = msg.turnIndex;
      this.myTurn = msg.team === this.youAre;
      this.moving = false;
      this.turnsEl.textContent = t("turnsLeft", { n: C.MAX_TURNS - msg.turnIndex });
      this.showBanner(this.myTurn ? t("yourTurn") : t("opponentTurn"), 1300);
      this.startTimer(msg.turnMs);
    });
    this.channel.on("flick_ok", () => {
      this.myTurn = false;
      sfx.kick();
    });
    this.channel.on("goal", (msg: { team: 0 | 1; score: [number, number] }) => {
      this.score = msg.score;
      this.scoreEl.textContent = `${msg.score[0]} - ${msg.score[1]}`;
      this.showBanner(t("goal"), 1800);
      sfx.goal();
      haptic(msg.team === this.youAre ? [50, 30, 100] : 80);
      if (msg.team === this.youAre) confetti(1200);
    });
    this.channel.on("match_end", (msg: MatchEndMsg) => {
      this.dispose();
      showResult(msg, this.youAre, () => {
        go("pregame", { gameId: "subbuteo", auto: this.mode });
      }, () => go("home"));
    });
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

  // ---------- Input ----------

  private bindInput(): void {
    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.myTurn || this.moving || !this.next) return;
      const p = this.screenToField(this.pt(e));
      let best = -1;
      let bestD = C.DISC_R * 2.4;
      this.next.discs.forEach(([x, y], i) => {
        const mine = this.discTeam(i) === this.youAre;
        if (!mine) return;
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best >= 0) {
        this.dragging = true;
        this.dragDisc = best;
        this.dragStart = p;
        this.dragNow = p;
        sfx.tap();
      }
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (this.dragging) this.dragNow = this.screenToField(this.pt(e));
    });
    const up = () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.releaseFlick();
    };
    this.canvas.addEventListener("pointerup", up);
    this.canvas.addEventListener("pointercancel", up);
  }

  private releaseFlick(): void {
    if (!this.myTurn || this.moving || this.dragDisc < 0) return;
    const MAX_DRAG = 220; // field units
    let dx = (this.dragNow.x - this.dragStart.x) / MAX_DRAG;
    let dy = (this.dragNow.y - this.dragStart.y) / MAX_DRAG;
    const len = Math.hypot(dx, dy);
    if (len < 0.06) return; // tap, not a flick
    if (len > 1) { dx /= len; dy /= len; }
    this.channel.send("flick", { disc: this.dragDisc, dx, dy });
    this.dragDisc = -1;
    haptic(25);
  }

  /** Disc index -> team, per the shared initial layout (first half team 0). */
  private discTeam(i: number): 0 | 1 {
    return i < C.DISCS_PER_TEAM ? 0 : 1;
  }

  // ---------- Geometry ----------

  /** Team 1 sees the board rotated 180° so their goal is always at the far end. */
  private flipped(): boolean {
    return this.youAre === 1;
  }

  private fieldToScreen(x: number, y: number): { x: number; y: number } {
    if (this.flipped()) { x = C.FIELD_W - x; y = C.FIELD_H - y; }
    return { x: this.ox + x * this.scale, y: this.oy + y * this.scale };
  }

  private screenToField(p: { x: number; y: number }): { x: number; y: number } {
    let x = (p.x - this.ox) / this.scale;
    let y = (p.y - this.oy) / this.scale;
    if (this.flipped()) { x = C.FIELD_W - x; y = C.FIELD_H - y; }
    return { x, y };
  }

  private pt(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  resize = (): void => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.W = this.wrap.clientWidth;
    this.H = this.wrap.clientHeight;
    this.canvas.width = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const margin = 0.92;
    this.scale = Math.min((this.W * margin) / C.FIELD_W, (this.H * 0.82) / C.FIELD_H);
    this.ox = (this.W - C.FIELD_W * this.scale) / 2;
    this.oy = (this.H - C.FIELD_H * this.scale) / 2 + this.H * 0.02;
  };

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

  private loop = (): void => {
    if (this.destroyed) return;
    // The wrap is attached after construction; keep the canvas in sync.
    if (this.W !== this.wrap.clientWidth || this.H !== this.wrap.clientHeight) this.resize();
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  };

  /** Interpolated positions between the last two snapshots. */
  private lerped(): SubbuteoSnapshot | null {
    if (!this.next) return null;
    if (!this.prev || !this.moving) return this.next;
    const interval = 1000 / C.SNAPSHOT_HZ;
    const p = Math.min(1, (performance.now() - this.recvAt) / interval);
    const lp = (a: [number, number], b: [number, number]): [number, number] =>
      [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p];
    return {
      t: this.next.t,
      ball: lp(this.prev.ball, this.next.ball),
      discs: this.next.discs.map((d, i) => lp(this.prev!.discs[i] ?? d, d)),
      moving: this.moving,
    };
  }

  private draw(): void {
    const { ctx, W, H } = this;
    // Table backdrop.
    ctx.fillStyle = "#3b2a1c";
    ctx.fillRect(0, 0, W, H);

    this.drawPitch();

    const s = this.lerped();
    if (!s) return;

    // Discs.
    s.discs.forEach(([x, y], i) => {
      const team = this.discTeam(i);
      const pos = this.fieldToScreen(x, y);
      const r = C.DISC_R * this.scale;
      const [c1, c2] = TEAM_COLORS[team];
      const mine = team === this.youAre;
      // Base.
      ctx.beginPath();
      ctx.arc(pos.x, pos.y + r * 0.15, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fill();
      const grad = ctx.createRadialGradient(pos.x - r * 0.3, pos.y - r * 0.3, r * 0.2, pos.x, pos.y, r);
      grad.addColorStop(0, c1);
      grad.addColorStop(1, c2);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = mine && this.myTurn && !this.moving ? "#ffd23e" : "rgba(255,255,255,0.7)";
      ctx.stroke();
      // Figurine dot.
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fill();
    });

    // Ball.
    const bp = this.fieldToScreen(s.ball[0], s.ball[1]);
    const br = C.BALL_R * this.scale;
    ctx.beginPath();
    ctx.arc(bp.x, bp.y + br * 0.2, br, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fill();
    const bg = ctx.createRadialGradient(bp.x - br * 0.3, bp.y - br * 0.3, br * 0.2, bp.x, bp.y, br);
    bg.addColorStop(0, "#ffffff");
    bg.addColorStop(1, "#c9ccc9");
    ctx.beginPath();
    ctx.arc(bp.x, bp.y, br, 0, Math.PI * 2);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Flick aim arrow.
    if (this.dragging && this.dragDisc >= 0 && this.next) {
      const [dx0, dy0] = this.next.discs[this.dragDisc];
      const from = this.fieldToScreen(dx0, dy0);
      const to = { x: from.x + (this.fieldToScreen(this.dragNow.x, this.dragNow.y).x - this.fieldToScreen(this.dragStart.x, this.dragStart.y).x), y: from.y + (this.fieldToScreen(this.dragNow.x, this.dragNow.y).y - this.fieldToScreen(this.dragStart.x, this.dragStart.y).y) };
      ctx.strokeStyle = "rgba(255,210,62,0.95)";
      ctx.lineWidth = 4;
      ctx.setLineDash([9, 7]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // Arrowhead.
      const ang = Math.atan2(to.y - from.y, to.x - from.x);
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - 12 * Math.cos(ang - 0.4), to.y - 12 * Math.sin(ang - 0.4));
      ctx.lineTo(to.x - 12 * Math.cos(ang + 0.4), to.y - 12 * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fillStyle = "rgba(255,210,62,0.95)";
      ctx.fill();
    }
  }

  private drawPitch(): void {
    const { ctx } = this;
    const p0 = this.fieldToScreenRaw(0, 0);
    const fw = C.FIELD_W * this.scale;
    const fh = C.FIELD_H * this.scale;

    // Cloth.
    const grad = ctx.createLinearGradient(p0.x, p0.y, p0.x, p0.y + fh);
    grad.addColorStop(0, "#1f8f47");
    grad.addColorStop(1, "#157136");
    ctx.fillStyle = grad;
    ctx.fillRect(p0.x, p0.y, fw, fh);
    // Mowing stripes.
    ctx.fillStyle = "rgba(255,255,255,0.045)";
    for (let i = 0; i < 9; i += 2) ctx.fillRect(p0.x, p0.y + (fh * i) / 9, fw, fh / 9);

    // Lines.
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 2;
    ctx.strokeRect(p0.x, p0.y, fw, fh);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y + fh / 2);
    ctx.lineTo(p0.x + fw, p0.y + fh / 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p0.x + fw / 2, p0.y + fh / 2, 60 * this.scale, 0, Math.PI * 2);
    ctx.stroke();
    // Boxes.
    const boxW = 260 * this.scale;
    const boxH = 110 * this.scale;
    ctx.strokeRect(p0.x + (fw - boxW) / 2, p0.y, boxW, boxH);
    ctx.strokeRect(p0.x + (fw - boxW) / 2, p0.y + fh - boxH, boxW, boxH);

    // Goals (mouth + net behind the line).
    const gw = C.GOAL_W * this.scale;
    const gd = 26 * this.scale;
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.fillRect(p0.x + (fw - gw) / 2, p0.y - gd, gw, gd);
    ctx.fillRect(p0.x + (fw - gw) / 2, p0.y + fh, gw, gd);
    ctx.strokeStyle = "#f4f6f5";
    ctx.lineWidth = 3;
    ctx.strokeRect(p0.x + (fw - gw) / 2, p0.y - gd, gw, gd);
    ctx.strokeRect(p0.x + (fw - gw) / 2, p0.y + fh, gw, gd);
  }

  /** Screen position of field origin ignoring the 180° flip (static pitch drawing). */
  private fieldToScreenRaw(x: number, y: number): { x: number; y: number } {
    return { x: this.ox + x * this.scale, y: this.oy + y * this.scale };
  }

  dispose(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
  }
}

function subbuteoScreen(params: Params): Screen {
  const wrap = h("div", { class: "game-wrap" });
  const game = new SubbuteoGame(wrap, params.channel, params.start, params.mode ?? "online");
  return {
    el: wrap,
    destroy: () => {
      game.dispose();
      params.channel.leave();
    },
  };
}

register("game-subbuteo", subbuteoScreen);
