import type { Dive, Shot, ShotResult } from "./types";

/**
 * Authoritative shot resolution. Pure + injectable RNG so the server room,
 * the client offline mode and tests all share the exact same rules.
 *
 * Goal space: x in [-1,1] (posts at +-1), y in [0,1] (crossbar at 1).
 */
export function resolveShot(shot: Shot, dive: Dive | null, rng: () => number = Math.random): ShotResult {
  const power = clamp(shot.power, 0, 1);
  const curve = clamp(shot.curve, -1, 1);

  // Accuracy degrades with power (risk/reward) — gaussian noise on target.
  const sigma = 0.05 + 0.13 * power * power;
  let bx = clamp(shot.tx, -1.35, 1.35) + gaussian(rng) * sigma + curve * 0.12;
  let by = clamp(shot.ty, 0, 1.35) + gaussian(rng) * sigma * 0.8;

  // Weak shots sag toward the ground.
  by = Math.max(0.02, by - (1 - power) * 0.15 * rng());

  const flightMs = Math.round(1050 - 550 * power);

  // Off target / woodwork.
  const POST = 0.06;
  if (Math.abs(bx) > 1 + POST || by > 1 + POST) {
    return finish("out", bx, by, flightMs, shot, dive);
  }
  if (Math.abs(bx) > 1 - POST || by > 1 - POST) {
    // Woodwork band: 45% it stays out.
    if (rng() < 0.45) return finish("post", bx, by, flightMs, shot, dive);
    bx = clamp(bx, -0.98, 0.98);
    by = clamp(by, 0.02, 0.98);
  }

  if (!dive) return finish("goal", bx, by, flightMs, shot, dive);

  // Keeper reach: distance between dive zone center and ball, in goal space.
  const dz = zoneCenter(dive.col, dive.row);
  const dist = Math.hypot(dz.x - bx, (dz.y - by) * 1.35);
  // Base save chance by proximity, reduced by shot power.
  let saveP = 0;
  if (dist < 0.28) saveP = 0.94 - 0.38 * power;
  else if (dist < 0.62) saveP = 0.55 - 0.35 * power;
  else if (dist < 0.95) saveP = 0.16 - 0.12 * power;
  // Shots into the exact corners are harder to hold.
  const cornerness = Math.min(1, Math.hypot(Math.abs(bx), by) / 1.2);
  saveP -= cornerness * 0.08;

  const outcome = rng() < Math.max(0, saveP) ? "saved" : "goal";
  return finish(outcome, bx, by, flightMs, shot, dive);
}

export function zoneOf(bx: number, by: number): { col: -1 | 0 | 1; row: 0 | 1 | 2 } {
  const col = bx < -0.33 ? -1 : bx > 0.33 ? 1 : 0;
  const row = by < 0.34 ? 0 : by < 0.67 ? 1 : 2;
  return { col, row };
}

export function zoneCenter(col: -1 | 0 | 1, row: 0 | 1 | 2): { x: number; y: number } {
  return { x: col * 0.66, y: 0.17 + row * 0.33 };
}

function finish(
  outcome: ShotResult["outcome"],
  bx: number,
  by: number,
  flightMs: number,
  shot: Shot,
  dive: Dive | null,
): ShotResult {
  const z = zoneOf(bx, by);
  return { outcome, bx, by, zoneCol: z.col, zoneRow: z.row, flightMs, shot, dive };
}

/** Box-Muller. */
function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ---------- Bot brains (shared by server bots and offline mode) ----------

export function botShot(rng: () => number = Math.random): Shot {
  const corners = [
    { tx: -0.8, ty: 0.15 }, { tx: 0.8, ty: 0.15 },
    { tx: -0.75, ty: 0.8 }, { tx: 0.75, ty: 0.8 },
    { tx: 0, ty: 0.9 }, { tx: -0.5, ty: 0.4 }, { tx: 0.5, ty: 0.4 },
  ];
  const c = corners[Math.floor(rng() * corners.length)];
  return { tx: c.tx, ty: c.ty, power: 0.55 + rng() * 0.4, curve: (rng() - 0.5) * 0.6 };
}

export function botDive(rng: () => number = Math.random): Dive {
  const cols: (-1 | 0 | 1)[] = [-1, -1, 0, 1, 1]; // keepers favour the corners
  const rows: (0 | 1 | 2)[] = [0, 0, 1, 1, 2];
  return { col: cols[Math.floor(rng() * cols.length)], row: rows[Math.floor(rng() * rows.length)] };
}
