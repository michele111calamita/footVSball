/** Juicy feedback helpers: toast, modal, confetti, haptics, synth audio. */

export function toast(msg: string, kind: "info" | "error" = "info"): void {
  let wrap = document.querySelector(".toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "toast-wrap";
    document.body.appendChild(wrap);
  }
  const el = document.createElement("div");
  el.className = `toast${kind === "error" ? " toast--error" : ""}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

export function confirmModal(title: string, body: string, okLabel: string, cancelLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `
      <div class="modal">
        <h3></h3>
        <p></p>
        <div class="row">
          <button class="btn btn--ghost" data-a="no" style="color:var(--ink);border-color:rgba(0,0,0,.25)"></button>
          <button class="btn" data-a="ok"></button>
        </div>
      </div>`;
    back.querySelector("h3")!.textContent = title;
    back.querySelector("p")!.textContent = body;
    (back.querySelector('[data-a="no"]') as HTMLElement).textContent = cancelLabel;
    (back.querySelector('[data-a="ok"]') as HTMLElement).textContent = okLabel;
    back.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("[data-a]")?.getAttribute("data-a");
      if (!a && e.target !== back) return;
      back.remove();
      resolve(a === "ok");
    });
    document.body.appendChild(back);
  });
}

export function haptic(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch { /* unsupported */ }
}

// ---------- Confetti ----------

export function confetti(durationMs = 1800): void {
  const canvas = document.createElement("canvas");
  canvas.className = "confetti-canvas";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  const colors = ["#ffd23e", "#ff8a1e", "#27b55c", "#2f7ddb", "#ffffff", "#e6363c"];
  const parts = Array.from({ length: 130 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.4,
    vx: (Math.random() - 0.5) * 3,
    vy: 2.5 + Math.random() * 4,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    w: 6 + Math.random() * 6,
    h: 4 + Math.random() * 5,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const t0 = performance.now();
  (function frame(now: number) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (now - t0 < durationMs) requestAnimationFrame(frame);
    else canvas.remove();
  })(t0);
}

// ---------- Synth audio (no assets needed) ----------

let actx: AudioContext | null = null;

function ctx2(): AudioContext | null {
  try {
    actx ??= new AudioContext();
    if (actx.state === "suspended") actx.resume();
    return actx;
  } catch {
    return null;
  }
}

function tone(freq: number, dur: number, type: OscillatorType, gain = 0.15, when = 0): void {
  const ac = ctx2();
  if (!ac) return;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(gain, ac.currentTime + when);
  g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + when + dur);
  o.connect(g).connect(ac.destination);
  o.start(ac.currentTime + when);
  o.stop(ac.currentTime + when + dur + 0.02);
}

function noise(dur: number, gain = 0.2, when = 0): void {
  const ac = ctx2();
  if (!ac) return;
  const len = Math.floor(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const g = ac.createGain();
  g.gain.value = gain;
  const f = ac.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = 900;
  src.connect(f).connect(g).connect(ac.destination);
  src.start(ac.currentTime + when);
}

export const sfx = {
  whistle(): void {
    tone(2100, 0.12, "square", 0.08);
    tone(2100, 0.3, "square", 0.08, 0.18);
  },
  kick(): void {
    tone(110, 0.12, "sine", 0.3);
  },
  goal(): void {
    noise(0.9, 0.25);
    tone(523, 0.15, "triangle", 0.15, 0.1);
    tone(659, 0.15, "triangle", 0.15, 0.25);
    tone(784, 0.35, "triangle", 0.18, 0.4);
  },
  save(): void {
    tone(220, 0.15, "sine", 0.25);
    noise(0.25, 0.12);
  },
  miss(): void {
    tone(180, 0.3, "sawtooth", 0.1);
  },
  tap(): void {
    tone(600, 0.05, "sine", 0.08);
  },
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, "triangle", 0.16, i * 0.14));
    noise(1.2, 0.18, 0.2);
  },
  lose(): void {
    [392, 330, 262].forEach((f, i) => tone(f, 0.3, "sine", 0.14, i * 0.18));
  },
};
