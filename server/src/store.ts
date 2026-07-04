import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { ECONOMY, xpForLevel } from "../../shared/src/constants";
import type { GameId, LeaderboardEntry, Rewards, ShopItem, UserProfile } from "../../shared/src/types";

/**
 * Persistence layer. JSON-file backed for the MVP; the exported functions are
 * the contract — swap the internals for PostgreSQL (users/stats/economy) and
 * Redis (sessions/leaderboard cache) in production without touching rooms/API.
 */

interface DB {
  users: Record<string, UserProfile>;
  tokens: Record<string, string>; // token -> userId
}

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const DB_FILE = join(DATA_DIR, "db.json");

let db: DB = { users: {}, tokens: {} };
let saveTimer: NodeJS.Timeout | null = null;

export function loadStore(): void {
  if (existsSync(DB_FILE)) {
    db = JSON.parse(readFileSync(DB_FILE, "utf8")) as DB;
  }
}

function persist(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }, 500);
}

function freshStats() {
  return {
    penalty: { wins: 0, losses: 0, draws: 0, rating: 1000 },
    subbuteo: { wins: 0, losses: 0, draws: 0, rating: 1000 },
  };
}

export function createGuest(name: string): { user: UserProfile; token: string } {
  const id = nanoid(10);
  const user: UserProfile = {
    id,
    name: name.slice(0, 20) || `Player_${id.slice(0, 4)}`,
    level: 1,
    xp: 0,
    coins: 100,
    gems: 0,
    ballSkin: "classic",
    ownedSkins: ["classic"],
    friends: [],
    stats: freshStats(),
    createdAt: Date.now(),
  };
  const token = nanoid(24);
  db.users[id] = user;
  db.tokens[token] = id;
  persist();
  return { user, token };
}

export function userByToken(token: string | undefined): UserProfile | null {
  if (!token) return null;
  const id = db.tokens[token];
  return id ? db.users[id] ?? null : null;
}

export function userById(id: string): UserProfile | null {
  return db.users[id] ?? null;
}

export function renameUser(id: string, name: string): UserProfile | null {
  const u = db.users[id];
  if (!u) return null;
  u.name = name.slice(0, 20) || u.name;
  persist();
  return u;
}

/**
 * Apply end-of-match economy + Elo. `result`: 1 win, 0 loss, 0.5 draw.
 * opponentRating may belong to a bot (bots have fixed rating, no profile update).
 */
export function applyMatchResult(
  userId: string,
  game: GameId,
  result: 0 | 0.5 | 1,
  opponentRating: number,
  ranked: boolean,
): Rewards | null {
  const u = db.users[userId];
  if (!u) return null;
  const s = u.stats[game];

  let ratingDelta = 0;
  if (ranked) {
    const expected = 1 / (1 + 10 ** ((opponentRating - s.rating) / 400));
    ratingDelta = Math.round(ECONOMY.ELO_K * (result - expected));
    s.rating += ratingDelta;
  }
  if (result === 1) s.wins++;
  else if (result === 0) s.losses++;
  else s.draws++;

  const coins = result === 1 ? ECONOMY.WIN_COINS : result === 0 ? ECONOMY.LOSS_COINS : ECONOMY.DRAW_COINS;
  const xp = result === 1 ? ECONOMY.WIN_XP : result === 0 ? ECONOMY.LOSS_XP : ECONOMY.DRAW_XP;
  u.coins += coins;
  u.xp += xp;
  while (u.xp >= xpForLevel(u.level)) {
    u.xp -= xpForLevel(u.level);
    u.level++;
  }
  persist();
  return { coins, xp, ratingDelta };
}

export function leaderboard(game: GameId, limit = 50): LeaderboardEntry[] {
  return Object.values(db.users)
    .map((u) => ({ id: u.id, name: u.name, level: u.level, rating: u.stats[game].rating, wins: u.stats[game].wins }))
    .sort((a, b) => b.rating - a.rating)
    .slice(0, limit);
}

export function addFriend(userId: string, friendId: string): boolean {
  const u = db.users[userId];
  const f = db.users[friendId];
  if (!u || !f || userId === friendId || u.friends.includes(friendId)) return false;
  u.friends.push(friendId);
  persist();
  return true;
}

// ---------- Shop ----------

export const SHOP_ITEMS: ShopItem[] = [
  { id: "classic", name: "Classic", kind: "ballSkin", costCoins: 0, costGems: 0, emojiFallback: "⚽", colors: ["#ffffff", "#222222"] },
  { id: "fire", name: "Fireball", kind: "ballSkin", costCoins: 250, costGems: 0, emojiFallback: "🔥", colors: ["#ff7a1a", "#7a1500"] },
  { id: "neon", name: "Neon", kind: "ballSkin", costCoins: 400, costGems: 0, emojiFallback: "💚", colors: ["#39ff88", "#0a5c2e"] },
  { id: "gold", name: "Gold Cup", kind: "ballSkin", costCoins: 800, costGems: 0, emojiFallback: "🏆", colors: ["#ffd23e", "#8a6a00"] },
  { id: "galaxy", name: "Galaxy", kind: "ballSkin", costCoins: 0, costGems: 20, emojiFallback: "🌌", colors: ["#7b5bff", "#1a1040"] },
];

export function buyItem(userId: string, itemId: string): { ok: boolean; error?: string; user?: UserProfile } {
  const u = db.users[userId];
  const item = SHOP_ITEMS.find((i) => i.id === itemId);
  if (!u || !item) return { ok: false, error: "not_found" };
  if (u.ownedSkins.includes(itemId)) return { ok: false, error: "already_owned" };
  if (u.coins < item.costCoins || u.gems < item.costGems) return { ok: false, error: "insufficient_funds" };
  u.coins -= item.costCoins;
  u.gems -= item.costGems;
  u.ownedSkins.push(itemId);
  persist();
  return { ok: true, user: u };
}

export function equipSkin(userId: string, itemId: string): boolean {
  const u = db.users[userId];
  if (!u || !u.ownedSkins.includes(itemId)) return false;
  u.ballSkin = itemId;
  persist();
  return true;
}
