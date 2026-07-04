import type { GameId } from "../../../shared/src/types";
import { t } from "../i18n";
import { refreshMe } from "../net/rest";
import { session } from "../state";
import { sfx } from "../ui/fx";
import { go, register } from "../ui/nav";
import { Screen, h } from "../ui/router";
import { tabbar, topbar } from "../ui/shell";

/** Home hub: minigame carousel + persistent currency/level + tab bar. */
function hub(): Screen {
  const root = h("div", { style: "display:flex;flex-direction:column;min-height:100dvh" });
  root.appendChild(topbar());

  const screen = h("div", { class: "screen" });
  screen.appendChild(h("h2", { class: "screen__title" }, t("home")));

  const games: { id: GameId; cls: string; emoji: string; title: () => string; sub: () => string; badge: () => string; badgeCls: string }[] = [
    { id: "penalty", cls: "game-card--penalty", emoji: "🥅", title: () => t("penaltyTitle"), sub: () => t("penaltySub"), badge: () => t("badgeNew"), badgeCls: "badge" },
    { id: "subbuteo", cls: "game-card--subbuteo", emoji: "🎯", title: () => t("subbuteoTitle"), sub: () => t("subbuteoSub"), badge: () => t("badgeHot"), badgeCls: "badge badge--hot" },
  ];

  for (const g of games) {
    const card = h("div", { class: `game-card ${g.cls}` });
    card.appendChild(h("span", { class: g.badgeCls }, g.badge()));
    card.appendChild(h("span", { class: "game-card__emoji" }, g.emoji));
    card.appendChild(h("div", { class: "game-card__title" }, g.title()));
    card.appendChild(h("div", { class: "game-card__sub" }, g.sub()));
    card.style.marginBottom = "14px";
    card.addEventListener("click", () => {
      sfx.tap();
      go("pregame", { gameId: g.id });
    });
    screen.appendChild(card);
  }

  if (session.offline) {
    screen.appendChild(h("p", { class: "muted", style: "text-align:center" }, t("offlineMode")));
  }

  root.appendChild(screen);
  root.appendChild(tabbar("home"));

  // Silent profile refresh (cloud save source of truth).
  refreshMe().then(() => {
    const fresh = topbar();
    root.replaceChild(fresh, root.firstChild!);
  }).catch(() => { session.offline = true; });

  return { el: root };
}

register("home", hub);
