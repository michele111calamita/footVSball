import type { ShopItem } from "../../../shared/src/types";
import { t } from "../i18n";
import { buy, equip, fetchShop } from "../net/rest";
import { session } from "../state";
import { confetti, confirmModal, sfx, toast } from "../ui/fx";
import { go, register } from "../ui/nav";
import { Screen, h } from "../ui/router";
import { tabbar, topbar } from "../ui/shell";

function shop(): Screen {
  const root = h("div", { style: "display:flex;flex-direction:column;min-height:100dvh" });
  root.appendChild(topbar());
  const screen = h("div", { class: "screen" });
  screen.appendChild(h("h2", { class: "screen__title" }, t("shop")));
  const grid = h("div", { class: "shop-grid" });
  screen.appendChild(grid);

  async function load(): Promise<void> {
    grid.innerHTML = "";
    try {
      const { items } = await fetchShop();
      items.forEach((item) => grid.appendChild(itemCard(item)));
    } catch {
      grid.appendChild(h("p", { class: "muted" }, t("connectionLost")));
    }
  }

  function itemCard(item: ShopItem): HTMLElement {
    const u = session.user;
    const owned = u?.ownedSkins.includes(item.id) ?? false;
    const equipped = u?.ballSkin === item.id;
    const card = h("div", { class: `shop-item${owned ? " owned" : ""}${equipped ? " equipped" : ""}` });
    const sw = h("div", { class: "swatch" });
    sw.style.background = `radial-gradient(circle at 35% 30%, ${item.colors[0]}, ${item.colors[1]})`;
    card.appendChild(sw);
    card.appendChild(h("div", { class: "name" }, item.name));
    const price = item.costGems > 0 ? `💎 ${item.costGems}` : item.costCoins > 0 ? `🪙 ${item.costCoins}` : "—";
    card.appendChild(h("div", { class: "price" }, owned ? t("owned") : price));

    const btn = h("button", { class: "btn" + (equipped ? " btn--ghost" : owned ? " btn--secondary" : "") });
    btn.textContent = equipped ? t("equipped") : owned ? t("equip") : t("buy");
    if (equipped) btn.setAttribute("disabled", "true");
    btn.addEventListener("click", async () => {
      sfx.tap();
      try {
        if (owned) {
          await equip(item.id);
        } else {
          const ok = await confirmModal(t("confirmBuyTitle"), t("confirmBuy", { name: item.name, price }), t("confirm"), t("cancel"));
          if (!ok) return;
          await buy(item.id);
          confetti(1200);
          toast(t("purchased"));
        }
        go("shop");
      } catch (e) {
        toast((e as Error).message === "insufficient_funds" ? t("notEnough") : t("connectionLost"), "error");
      }
    });
    card.appendChild(btn);
    return card;
  }

  root.appendChild(screen);
  root.appendChild(tabbar("shop"));
  load();
  return { el: root };
}

register("shop", shop);
