import { t } from "../i18n";
import { guestLogin } from "../net/rest";
import { toast } from "../ui/fx";
import { go, register } from "../ui/nav";
import { Screen, h } from "../ui/router";

/** 3 onboarding slides + guest login (social login: see docs/ARCHITECTURE notes). */
function splash(): Screen {
  const el = h("div", { class: "splash" });
  const slides = [
    { emoji: "⚽", title: () => t("onboard1Title"), text: () => t("onboard1Text") },
    { emoji: "🏆", title: () => t("onboard2Title"), text: () => t("onboard2Text") },
    { emoji: "✨", title: () => t("onboard3Title"), text: () => t("onboard3Text") },
  ];
  let idx = 0;

  function render(): void {
    el.innerHTML = "";
    const logo = h("div", { class: "splash__logo" }, "foot", h("em", {}, "VS"), "ball");
    el.appendChild(logo);

    if (idx < slides.length) {
      const s = slides[idx];
      el.appendChild(h("div", { class: "splash__slide-emoji" }, s.emoji));
      el.appendChild(h("h2", {}, s.title()));
      el.appendChild(h("p", { class: "muted" }, s.text()));
      const dots = h("div", { class: "dots" });
      slides.forEach((_, i) => dots.appendChild(h("span", { class: i === idx ? "on" : "" })));
      el.appendChild(dots);
      const next = h("button", { class: "btn btn--block" }, t("next"));
      next.addEventListener("click", () => { idx++; render(); });
      el.appendChild(next);
      return;
    }

    // Login step.
    el.appendChild(h("h2", {}, t("chooseName")));
    const input = h("input", { class: "input", placeholder: t("namePlaceholder"), maxlength: "20" });
    el.appendChild(input);
    const start = h("button", { class: "btn btn--block" }, t("start"));
    start.addEventListener("click", async () => {
      start.classList.add("btn--loading");
      try {
        await guestLogin(input.value.trim());
        go("home");
      } catch {
        toast(t("connectionLost"), "error");
        start.classList.remove("btn--loading");
      }
    });
    el.appendChild(start);
  }

  render();
  return { el };
}

register("splash", splash);
