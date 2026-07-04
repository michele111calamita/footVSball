import type { GameId, LeaderboardEntry, ShopItem, UserProfile } from "../../../shared/src/types";
import { saveSession, session, updateUser } from "../state";

/** Empty in web builds (same origin); set VITE_SERVER_URL for Capacitor/native builds. */
const BASE = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/$/, "") ?? "";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch(`${BASE}/api${path}`, { ...init, headers });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `http_${res.status}`);
  return res.json() as Promise<T>;
}

export async function guestLogin(name: string): Promise<UserProfile> {
  const { user, token } = await req<{ user: UserProfile; token: string }>("/auth/guest", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  saveSession(token, user);
  return user;
}

export async function refreshMe(): Promise<UserProfile> {
  const { user } = await req<{ user: UserProfile }>("/me");
  updateUser(user);
  session.offline = false;
  return user;
}

export async function rename(name: string): Promise<UserProfile> {
  const { user } = await req<{ user: UserProfile }>("/me", { method: "PATCH", body: JSON.stringify({ name }) });
  updateUser(user);
  return user;
}

export function fetchLeaderboard(game: GameId): Promise<{ entries: LeaderboardEntry[] }> {
  return req(`/leaderboard/${game}`);
}

export function fetchShop(): Promise<{ items: ShopItem[] }> {
  return req("/shop/items");
}

export async function buy(itemId: string): Promise<UserProfile> {
  const { user } = await req<{ user: UserProfile }>("/shop/buy", { method: "POST", body: JSON.stringify({ itemId }) });
  updateUser(user);
  return user;
}

export async function equip(itemId: string): Promise<void> {
  await req("/shop/equip", { method: "POST", body: JSON.stringify({ itemId }) });
  if (session.user) updateUser({ ...session.user, ballSkin: itemId });
}

export function fetchFriends(): Promise<{ friends: { id: string; name: string; level: number; stats: UserProfile["stats"] }[] }> {
  return req("/friends");
}

export function addFriendReq(id: string): Promise<{ ok: boolean }> {
  return req(`/friends/${encodeURIComponent(id)}`, { method: "POST" });
}
