import { SUBBUTEO as C } from "./constants";
import type { Body2D, Disc, FlickMsg, SubbuteoState } from "./types";

/**
 * Deterministic 2D circle physics for the table-football minigame.
 * Pure functions over plain state: the server room is authoritative,
 * the client reuses the same code for offline vs-bot play.
 * Coordinates: portrait field, (0,0) top-left, team 0 defends y=FIELD_H (bottom),
 * team 1 defends y=0 (top).
 */

export function initialState(): SubbuteoState {
  const W = C.FIELD_W, H = C.FIELD_H;
  const discs: Disc[] = [];
  // 1 back (keeper-ish) + 3 defenders + 3 midfielders + 1 forward per team, mirrored.
  const layout: [number, number][] = [
    [W / 2, H - 60], // Keeper
    [W * 0.2, H - 180], [W * 0.5, H - 180], [W * 0.8, H - 180], // Defenders
    [W * 0.25, H - 300], [W * 0.5, H - 320], [W * 0.75, H - 300], // Midfielders
    [W * 0.5, H - 410], // Striker
  ];
  for (const [x, y] of layout) discs.push(mkDisc(x, y, 0));
  for (const [x, y] of layout) discs.push(mkDisc(W - x, H - y, 1));
  return {
    ball: { x: W / 2, y: H / 2, vx: 0, vy: 0, r: C.BALL_R, m: C.BALL_M },
    discs,
  };
}

function mkDisc(x: number, y: number, team: 0 | 1): Disc {
  return { x, y, vx: 0, vy: 0, r: C.DISC_R, m: C.DISC_M, team };
}

/** Reset to kickoff after a goal; team conceding gets the ball at center anyway (simple). */
export function kickoff(state: SubbuteoState): void {
  const fresh = initialState();
  state.ball = fresh.ball;
  state.discs = fresh.discs;
}

export function applyFlick(state: SubbuteoState, team: 0 | 1, flick: FlickMsg): boolean {
  const d = state.discs[flick.disc];
  if (!d || d.team !== team) return false;
  const len = Math.hypot(flick.dx, flick.dy);
  if (len < 0.02) return false;
  const power = Math.min(1, len);
  d.vx = (flick.dx / len) * power * C.MAX_FLICK_SPEED;
  d.vy = (flick.dy / len) * power * C.MAX_FLICK_SPEED;
  return true;
}

export interface StepEvents {
  goalFor: 0 | 1 | null;
}

/** Advance dt seconds. Returns goal event (scoring team) if the ball crossed a line. */
export function step(state: SubbuteoState, dt: number): StepEvents {
  const bodies: Body2D[] = [state.ball, ...state.discs];
  const frames = dt * 60;
  const friction = Math.pow(C.FRICTION, frames);

  for (const b of bodies) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.vx *= friction;
    b.vy *= friction;
    if (Math.hypot(b.vx, b.vy) < C.STOP_EPS) { b.vx = 0; b.vy = 0; }
  }

  // Pairwise elastic collisions with positional correction.
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      collide(bodies[i], bodies[j]);
    }
  }

  // Walls + goal detection.
  const ev: StepEvents = { goalFor: null };
  for (const b of bodies) {
    const isBall = b === state.ball;
    const inMouth = Math.abs(b.x - C.FIELD_W / 2) < C.GOAL_W / 2 - (isBall ? 0 : b.r);
    // Top goal line (team 1 defends top => team 0 scores there).
    if (isBall && inMouth && b.y < -b.r) { ev.goalFor = 0; continue; }
    if (isBall && inMouth && b.y > C.FIELD_H + b.r) { ev.goalFor = 1; continue; }

    if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx) * C.WALL_RESTITUTION; }
    if (b.x > C.FIELD_W - b.r) { b.x = C.FIELD_W - b.r; b.vx = -Math.abs(b.vx) * C.WALL_RESTITUTION; }
    if (!(isBall && inMouth)) {
      if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * C.WALL_RESTITUTION; }
      if (b.y > C.FIELD_H - b.r) { b.y = C.FIELD_H - b.r; b.vy = -Math.abs(b.vy) * C.WALL_RESTITUTION; }
    }
  }
  return ev;
}

function collide(a: Body2D, b: Body2D): void {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const minDist = a.r + b.r;
  if (dist === 0 || dist >= minDist) return;

  const nx = dx / dist, ny = dy / dist;
  // Positional correction (split by inverse mass).
  const overlap = minDist - dist;
  const invA = 1 / a.m, invB = 1 / b.m;
  const total = invA + invB;
  a.x -= nx * overlap * (invA / total);
  a.y -= ny * overlap * (invA / total);
  b.x += nx * overlap * (invB / total);
  b.y += ny * overlap * (invB / total);

  // Impulse along the normal.
  const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
  const velAlongNormal = rvx * nx + rvy * ny;
  if (velAlongNormal > 0) return;
  const impulse = (-(1 + C.BODY_RESTITUTION) * velAlongNormal) / total;
  a.vx -= impulse * invA * nx;
  a.vy -= impulse * invA * ny;
  b.vx += impulse * invB * nx;
  b.vy += impulse * invB * ny;
}

export function atRest(state: SubbuteoState): boolean {
  if (state.ball.vx !== 0 || state.ball.vy !== 0) return false;
  return state.discs.every((d) => d.vx === 0 && d.vy === 0);
}

// ---------- Bot brain ----------

/** Flick the own disc best placed to push the ball toward the opponent goal. */
export function botFlick(state: SubbuteoState, team: 0 | 1, rng: () => number = Math.random): FlickMsg {
  const goalY = team === 0 ? 0 : C.FIELD_H; // where this team scores
  const ball = state.ball;
  let best = -1;
  let bestScore = -Infinity;
  state.discs.forEach((d, i) => {
    if (d.team !== team) return;
    const toBall = Math.hypot(ball.x - d.x, ball.y - d.y);
    // Prefer discs behind the ball relative to the target goal.
    const behind = team === 0 ? d.y > ball.y : d.y < ball.y;
    const score = (behind ? 300 : 0) - toBall;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  const d = state.discs[best];
  // Aim: through the ball toward a jittered point in the goal mouth.
  const targetX = C.FIELD_W / 2 + (rng() - 0.5) * C.GOAL_W * 0.7;
  const dx = ball.x - d.x + (targetX - ball.x) * 0.15 + (rng() - 0.5) * 30;
  const dy = ball.y - d.y + (goalY - ball.y) * 0.15 + (rng() - 0.5) * 30;
  const len = Math.hypot(dx, dy) || 1;
  const power = 0.55 + rng() * 0.45;
  return { disc: best, dx: (dx / len) * power, dy: (dy / len) * power };
}
