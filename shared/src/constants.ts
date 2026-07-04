export const SERVER_PORT = 2567;

// ---------- Penalty ----------
export const PENALTY = {
  ROUNDS: 5,
  SHOT_TIMEOUT_MS: 8000,
  /** Under pressure (sudden death / decisive kick) the timer shrinks. */
  SHOT_TIMEOUT_PRESSURE_MS: 5500,
  RESULT_PAUSE_MS: 2600,
  /** Goal mouth aspect used by both renderers (width/height ratio). */
  GOAL_ASPECT: 3.0,
} as const;

// ---------- Subbuteo ----------
export const SUBBUTEO = {
  FIELD_W: 600,
  FIELD_H: 900,
  GOAL_W: 200,
  BALL_R: 10,
  DISC_R: 17,
  BALL_M: 1,
  DISC_M: 3.2,
  DISCS_PER_TEAM: 4,
  /** Per-frame velocity retain factor at 60fps (cloth friction). */
  FRICTION: 0.982,
  WALL_RESTITUTION: 0.78,
  BODY_RESTITUTION: 0.92,
  STOP_EPS: 3,
  MAX_FLICK_SPEED: 950,
  TURN_MS: 15000,
  MAX_TURNS: 24,
  GOAL_TARGET: 3,
  SIM_MAX_MS: 6500,
  SNAPSHOT_HZ: 20,
} as const;

// ---------- Economy ----------
export const ECONOMY = {
  WIN_COINS: 50,
  WIN_XP: 100,
  LOSS_COINS: 10,
  LOSS_XP: 40,
  DRAW_COINS: 25,
  DRAW_XP: 60,
  ELO_K: 24,
  /** XP needed for level n->n+1 = BASE + STEP*(n-1). */
  XP_BASE: 200,
  XP_STEP: 80,
} as const;

export function xpForLevel(level: number): number {
  return ECONOMY.XP_BASE + ECONOMY.XP_STEP * (level - 1);
}

/** Bot joins if no human opponent within this window. */
export const MATCHMAKING_BOT_FALLBACK_MS = 6000;
export const RECONNECT_GRACE_S = 25;
