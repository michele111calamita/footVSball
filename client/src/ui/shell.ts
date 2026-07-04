import { xpForLevel } from "../../../shared/src/constants";
import { t } from "../i18n";
import { session } from "../state";
import { sfx } from "./fx";
import { go } from "./nav";
import { h } from "./router";

/** Top bar: avatar + level, XP bar, currencies. */
export function topbar(): HTMLElement {
  const u = session.user;
  const xpNeed = u ? xpForLevel(u.level) : 1;
  const pct = u ? Math.min(100, Math.round((u.xp / xpNeed) * 100)) : 0;

  const bar = h("div", { class: "topbar" });
  const av = h("div", { class: "avatar" }, "🧑");
  av.appendChild(h("span", { class: "avatar__level" }, String(u?.level ?? 1)));
  const info = h("div", {});
  info.appendChild(h("div", { class: "topbar__name" }, u?.name ?? "—"));
  const prog = h("div", { class: "progress topbar__xp" });
  const fill = h("div", { class: "progress__fill" });
  fill.style.width = `${pct}%`;
  prog.appendChild(fill);
  info.appendChild(prog);
  const cur = h("div", { class: "currency" });
  cur.appendChild(h("div", { class: "pill" }, "🪙 ", String(u?.coins ?? 0)));
  cur.appendChild(h("div", { class: "pill" }, "💎 ", String(u?.gems ?? 0)));
  bar.append(av, info, cur);
  return bar;
}

const TABS: [string, string, () => string][] = [
  ["home", "🏠", () => t("home")],
  ["leaderboard", "🏆", () => t("leaderboard")],
  ["friends", "👥", () => t("friends")],
  ["shop", "🛒", () => t("shop")],
  ["profile", "👤", () => t("profile")],
];

export function tabbar(active: string): HTMLElement {
  const bar = h("nav", { class: "tabbar" });
  for (const [name, ico, label] of TABS) {
    const b = h("button", { class: `tabbar__item${name === active ? " active" : ""}` });
    b.appendChild(h("span", { class: "ico" }, ico));
    b.appendChild(h("span", {}, label()));
    b.addEventListener("click", () => {
      if (name !== active) {
        sfx.tap();
        go(name);
      }
    });
    bar.appendChild(b);
  }
  return bar;
}
