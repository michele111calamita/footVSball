import "./styles/main.css";

// Screen registrations (side-effect imports).
import "./screens/splash";
import "./screens/hub";
import "./screens/pregame";
import "./screens/leaderboard";
import "./screens/friends";
import "./screens/shop";
import "./screens/profile";
import "./games/penalty";
import "./games/subbuteo";

import { refreshMe } from "./net/rest";
import { session } from "./state";
import { go } from "./ui/nav";

async function boot(): Promise<void> {
  if (!session.token) {
    go("splash");
    return;
  }
  try {
    await refreshMe();
  } catch {
    // Server unreachable: keep the cached profile, offline vs-bot only.
    session.offline = true;
    if (!session.user) {
      go("splash");
      return;
    }
  }
  go("home");
}

boot();
