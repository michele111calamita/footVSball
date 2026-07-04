import type { GameId, MatchStartMsg } from "../../../shared/src/types";
import { t } from "../i18n";
import { ColyseusChannel, GameChannel } from "../net/channel";
import { LocalPenaltyChannel } from "../local/localPenalty";
import { LocalSubbuteoChannel } from "../local/localSubbuteo";
import { session } from "../state";
import { toast } from "../ui/fx";
import { go, register } from "../ui/nav";
import { Screen, h } from "../ui/router";

export type Mode = "online" | "bot" | "offline";

/** Matchmaking screen: shows the queue, offers the bot fallback, launches the game. */
function pregame(params: { gameId: GameId; auto?: Mode }): Screen {
  const { gameId } = params;
  const el = h("div", { class: "screen" });
  const box = h("div", { class: "center" });
  el.appendChild(box);

  let channel: GameChannel | null = null;
  let done = false;

  function renderIdle(): void {
    box.innerHTML = "";
    box.appendChild(h("div", { class: "splash__slide-emoji" }, gameId === "penalty" ? "🥅" : "🎯"));
    box.appendChild(h("h2", {}, gameId === "penalty" ? t("penaltyTitle") : t("subbuteoTitle")));
    const online = h("button", { class: "btn btn--block" }, t("playOnline"));
    online.addEventListener("click", () => start("online"));
    const bot = h("button", { class: "btn btn--secondary btn--block" }, t("playVsBot"));
    bot.addEventListener("click", () => start(session.offline ? "offline" : "bot"));
    const back = h("button", { class: "btn btn--ghost btn--block" }, t("cancel"));
    back.addEventListener("click", () => go("home"));
    box.append(online, bot, back);
    if (session.offline) online.setAttribute("disabled", "true");
  }

  function renderSearching(): void {
    box.innerHTML = "";
    box.appendChild(h("div", { class: "spinner" }));
    box.appendChild(h("h2", {}, t("searching")));
    box.appendChild(h("p", { class: "muted" }, t("botFallback")));
    const cancel = h("button", { class: "btn btn--ghost" }, t("cancel"));
    cancel.addEventListener("click", () => {
      channel?.leave();
      channel = null;
      renderIdle();
    });
    box.appendChild(cancel);
  }

  async function start(mode: Mode): Promise<void> {
    renderSearching();
    let usedMode = mode;
    try {
      if (mode === "offline") {
        channel = gameId === "penalty" ? new LocalPenaltyChannel() : new LocalSubbuteoChannel();
      } else {
        channel = await ColyseusChannel.join(gameId, mode === "bot");
      }
    } catch {
      // Server unreachable: degrade to the local bot (offline handling).
      session.offline = true;
      toast(t("offlineMode"));
      usedMode = "offline";
      channel = gameId === "penalty" ? new LocalPenaltyChannel() : new LocalSubbuteoChannel();
    }
    channel.on("match_start", (msg: MatchStartMsg) => {
      if (done) return;
      done = true;
      go(gameId === "penalty" ? "game-penalty" : "game-subbuteo", { channel, start: msg, mode: usedMode });
    });
    channel.onLeave(() => {
      if (!done) {
        toast(t("connectionLost"), "error");
        renderIdle();
      }
    });
  }

  if (params.auto) start(params.auto);
  else renderIdle();

  return {
    el,
    destroy: () => {
      if (!done) channel?.leave();
    },
  };
}

register("pregame", pregame);
