import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import type { GameId, UserProfile } from "../../shared/src/types";
import {
  SHOP_ITEMS, addFriend, buyItem, createGuest, equipSkin,
  leaderboard, renameUser, userById, userByToken,
} from "./store";

/** Minimal fixed-window rate limiter (swap for Redis-backed limiter in prod). */
function rateLimit(maxPerMinute: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "?";
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now > h.reset) {
      hits.set(key, { n: 1, reset: now + 60_000 });
      return next();
    }
    if (++h.n > maxPerMinute) return res.status(429).json({ error: "rate_limited" });
    next();
  };
}

interface AuthedRequest extends Request {
  user?: UserProfile;
}

function auth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer /i, "");
  const user = userByToken(token);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  req.user = user;
  next();
}

const GAMES: GameId[] = ["penalty", "subbuteo"];

export function mountApi(app: Express): void {
  const api = express.Router();
  api.use(express.json());
  api.use(rateLimit(120));

  api.post("/auth/guest", (req, res) => {
    const { user, token } = createGuest(String(req.body?.name ?? ""));
    res.json({ user, token });
  });

  api.get("/me", auth, (req: AuthedRequest, res) => res.json({ user: req.user }));

  api.patch("/me", auth, (req: AuthedRequest, res) => {
    const user = renameUser(req.user!.id, String(req.body?.name ?? ""));
    res.json({ user });
  });

  api.get("/users/:id", (req, res) => {
    const u = userById(req.params.id);
    if (!u) return res.status(404).json({ error: "not_found" });
    // Public view — never leak the whole profile.
    const { id, name, level, stats } = u;
    res.json({ user: { id, name, level, stats } });
  });

  api.get("/leaderboard/:game", (req, res) => {
    const game = req.params.game as GameId;
    if (!GAMES.includes(game)) return res.status(400).json({ error: "unknown_game" });
    res.json({ entries: leaderboard(game, Number(req.query.limit) || 50) });
  });

  api.get("/friends", auth, (req: AuthedRequest, res) => {
    const friends = req.user!.friends
      .map((id) => userById(id))
      .filter((u): u is UserProfile => !!u)
      .map(({ id, name, level, stats }) => ({ id, name, level, stats }));
    res.json({ friends });
  });

  api.post("/friends/:id", auth, (req: AuthedRequest, res) => {
    const ok = addFriend(req.user!.id, req.params.id);
    if (!ok) return res.status(400).json({ error: "cannot_add" });
    res.json({ ok: true });
  });

  api.get("/shop/items", (_req, res) => res.json({ items: SHOP_ITEMS }));

  api.post("/shop/buy", auth, (req: AuthedRequest, res) => {
    const r = buyItem(req.user!.id, String(req.body?.itemId ?? ""));
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ user: r.user });
  });

  api.post("/shop/equip", auth, (req: AuthedRequest, res) => {
    const ok = equipSkin(req.user!.id, String(req.body?.itemId ?? ""));
    if (!ok) return res.status(400).json({ error: "cannot_equip" });
    res.json({ ok: true });
  });

  api.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

  app.use("/api", api);
}
