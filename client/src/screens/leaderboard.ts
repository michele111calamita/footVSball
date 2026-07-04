import type { GameId } from "../../../shared/src/types";
import { t } from "../i18n";
import { fetchLeaderboard } from "../net/rest";
import { session } from "../state";
import { register } from "../ui/nav";
import { Screen, h } from "../ui/router";
import { tabbar, topbar } from "../ui/shell";

function leaderboard(): Screen {
  const root = h("div", { style: "display:flex;flex-direction:column;min-height:100dvh" });
  root.appendChild(topbar());
  const screen = h("div", { class: "screen" });
  screen.appendChild(h("h2", { class: "screen__title" }, t("leaderboard")));

  const seg = h("div", { class: "seg" });
  const list = h("div", {});
  let game: GameId = "penalty";

  const tabs: [GameId, () => string][] = [
    ["penalty", () => t("penaltyTitle")],
    ["subbuteo", () => t("subbuteoTitle")],
  ];
  const btns = tabs.map(([id, label]) => {
    const b = h("button", { class: id === game ? "on" : "" }, label());
    b.addEventListener("click", () => {
      game = id;
      btns.forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      load();
    });
    seg.appendChild(b);
    return b;
  });

  async function load(): Promise<void> {
    list.innerHTML = "";
    list.appendChild(h("div", { class: "spinner", style: "margin:30px auto" }));
    try {
      const { entries } = await fetchLeaderboard(game);
      list.innerHTML = "";
      if (!entries.length) list.appendChild(h("p", { class: "muted", style: "text-align:center" }, "—"));
      entries.forEach((e, i) => {
        const row = h("div", { class: `list-row${e.id === session.user?.id ? " me" : ""}` });
        row.appendChild(h("span", { class: "rank" }, `${i + 1}`));
        row.appendChild(h("span", { class: "grow" }, e.name));
        row.appendChild(h("span", { class: "meta" }, `Lv ${e.level} · ${e.wins}W`));
        row.appendChild(h("strong", {}, String(e.rating)));
        list.appendChild(row);
      });
    } catch {
      list.innerHTML = "";
      list.appendChild(h("p", { class: "muted", style: "text-align:center" }, t("connectionLost")));
    }
  }

  screen.append(seg, list);
  root.appendChild(screen);
  root.appendChild(tabbar("leaderboard"));
  load();
  return { el: root };
}

register("leaderboard", leaderboard);
