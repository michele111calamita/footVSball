import type { UserProfile } from "../../shared/src/types";

/** Client session: guest token + cached profile (cloud-save friendly: the
 *  profile lives server-side; localStorage is only a cache + offline fallback). */

export interface Session {
  token: string | null;
  user: UserProfile | null;
  /** True when the server is unreachable — only bot/offline play allowed. */
  offline: boolean;
}

export const session: Session = {
  token: localStorage.getItem("fvb_token"),
  user: readCachedUser(),
  offline: false,
};

function readCachedUser(): UserProfile | null {
  try {
    const raw = localStorage.getItem("fvb_user");
    return raw ? (JSON.parse(raw) as UserProfile) : null;
  } catch {
    return null;
  }
}

export function saveSession(token: string | null, user: UserProfile | null): void {
  session.token = token;
  session.user = user;
  if (token) localStorage.setItem("fvb_token", token);
  else localStorage.removeItem("fvb_token");
  if (user) localStorage.setItem("fvb_user", JSON.stringify(user));
  else localStorage.removeItem("fvb_user");
}

export function updateUser(user: UserProfile): void {
  session.user = user;
  localStorage.setItem("fvb_user", JSON.stringify(user));
}
