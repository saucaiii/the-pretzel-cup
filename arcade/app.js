/* pretzels.fun client. Talks to the single /api/house RPC endpoint and
   keeps the UI in sync with the server's view of credits, tickets,
   inventory, boards.

   The arcade is served two ways: standalone at `/` on the worker's
   *.workers.dev URL, and sub-mounted at `/arcade` on the-pretzel-cup's
   Vercel deploy (which proxies `/arcade/api/*` → the same worker).
   API_BASE below strips the current file name and uses the directory as
   the prefix so the same build works in both places. */
const API_BASE = location.pathname.replace(/\/[^/]*$/, "").replace(/\/$/, "");

const fmt = (n) => Math.round(n ?? 0).toLocaleString("en-US");

async function call(op, args = {}) {
  const res = await fetch(API_BASE + "/api/house", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, args }),
    credentials: "same-origin",
  });
  if (!res.ok && res.status !== 400) return { ok: false, error: "The booth is down. Try again." };
  return res.json();
}

/* ---------- state ---------- */
const state = {
  handle: "",
  credits: 0,
  tickets: 0,
  seedHash: "",
  clientSeed: "",
  nonce: 0,
  bestMph: 0,
  inventory: [],
  plays: [],
  revealed: [],
  prizes: [],
};

function apply(patch) {
  Object.assign(state, patch);
  for (const el of document.querySelectorAll("[data-bind]")) {
    const k = el.dataset.bind;
    if (!(k in state)) continue;
    const v = state[k];
    el.textContent = typeof v === "number" ? fmt(v) : (v ?? "");
  }
  renderPrizes();
  renderShelf();
}

async function refresh() {
  const r = await call("state");
  if (r.ok) apply(r.data);
  const b = await call("boards");
  if (b.ok) renderBoards(b.data);
}

/* ---------- redeem ---------- */
document.getElementById("redeem-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("redeem-code");
  const msg = document.getElementById("redeem-msg");
  const code = input.value.trim();
  if (!code) return;
  msg.textContent = "Redeeming…";
  msg.removeAttribute("data-ok");
  const r = await call("redeem", { code });
  if (r.ok) {
    apply({ credits: r.data.credits, tickets: r.data.balance ?? state.tickets });
    msg.textContent = `+${fmt(r.data.redeemed)} credits.`;
    msg.dataset.ok = "1";
    input.value = "";
  } else {
    msg.textContent = r.error;
  }
});

/* ---------- handle ---------- */
document.getElementById("handle-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("handle-input");
  const msg = document.getElementById("handle-msg");
  const handle = input.value.trim();
  if (!handle) return;
  msg.textContent = "Saving…";
  msg.removeAttribute("data-ok");
  const r = await call("handle", { handle });
  if (r.ok) {
    apply({ handle: r.data.handle });
    msg.textContent = `You're ${r.data.handle}.`;
    msg.dataset.ok = "1";
  } else {
    msg.textContent = r.error;
  }
});

/* ---------- prizes ---------- */
// Visual stand-in until real product shots land. Each prize gets a
// glyph and a background tint so the counter reads without photography.
const PRIZE_ART = {
  single:       { icon: "🥨", tint: "#F7C948" },
  double:       { icon: "🥨", tint: "#E8A935" },
  sixpack:      { icon: "🥨", tint: "#C77A1A" },
  rivets:       { icon: "🍩", tint: "#B5651D" },
  bites:        { icon: "🥔", tint: "#C8A456" },
  delivery:     { icon: "🛵", tint: "#146B47" },
  tenpack:      { icon: "📦", tint: "#8A5A2B" },
  pinset:       { icon: "🔖", tint: "#D4B662" },
  tee:          { icon: "👕", tint: "#0D5237" },
  partytray:    { icon: "🧺", tint: "#B2872F" },
  hoodie:       { icon: "🧥", tint: "#083521" },
  subscription: { icon: "🏆", tint: "#D4B662" },
};

function renderPrizes() {
  const host = document.getElementById("prize-list");
  if (!host) return;
  if (!state.prizes.length) {
    host.innerHTML = "<p class='row-sub'>No prizes stocked yet.</p>";
    return;
  }
  host.innerHTML = "";
  for (const p of state.prizes) {
    const card = document.createElement("div");
    card.className = "prize";
    const canAfford = state.tickets >= p.tickets;
    const art = PRIZE_ART[p.id] || { icon: "🎁", tint: "#D4B662" };
    card.innerHTML = `
      <div class="prize-art" style="background:${art.tint}"><span>${art.icon}</span></div>
      <span class="prize-name">${p.name}</span>
      <span class="prize-tickets">${fmt(p.tickets)} tickets</span>
      <span class="prize-msrp">MSRP $${p.msrp.toFixed(2)}</span>
    `;
    const btn = document.createElement("button");
    btn.textContent = canAfford ? "Claim" : `Need ${fmt(p.tickets - state.tickets)}`;
    btn.disabled = !canAfford;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const r = await call("claim", { prize: p.id });
      if (r.ok) { apply({ credits: r.data.credits, tickets: r.data.balance }); await refreshInventory(); }
      else alert(r.error);
    });
    card.appendChild(btn);
    host.appendChild(card);
  }
}

function renderShelf() {
  const host = document.getElementById("shelf");
  if (!host) return;
  if (!state.inventory.length) {
    host.innerHTML = "<p class='shelf-empty'>Your shelf is empty. Win something at a booth.</p>";
    return;
  }
  host.innerHTML = "";
  for (const row of state.inventory) {
    const p = state.prizes.find((x) => x.id === row.prize);
    const div = document.createElement("div");
    div.className = "shelf-item";
    div.innerHTML = `
      <div>
        <div>${p ? p.name : row.prize}</div>
        <div class="status">${row.status} · ${row.source}</div>
      </div>
    `;
    if (row.status === "On your shelf") {
      const ship = document.createElement("button");
      ship.textContent = "Pickup";
      ship.addEventListener("click", async () => {
        ship.disabled = true;
        const r = await call("ship", { inv: row.id });
        if (r.ok) await refreshInventory();
        else { alert(r.error); ship.disabled = false; }
      });
      div.appendChild(ship);
    }
    host.appendChild(div);
  }
}

async function refreshInventory() {
  const r = await call("state");
  if (r.ok) apply(r.data);
}

/* ---------- boards ---------- */
function renderBoards(b) {
  const host = document.getElementById("boards");
  if (!host) return;
  host.innerHTML = "";
  const pot = document.createElement("div");
  pot.className = "board";
  pot.innerHTML = `<h4>Weekly pot</h4><div class="pot">$${(b.pot ?? 0).toFixed(2)}<small>5% of redeemed value, week of ${b.week}</small></div>`;
  host.appendChild(pot);

  const race = document.createElement("div");
  race.className = "board";
  race.innerHTML = `<h4>Weekly ticket race</h4>` + (b.race.length
    ? `<ol>${b.race.map((r) => `<li>${r.handle} <span class="v">${fmt(r.v)}</span></li>`).join("")}</ol>`
    : "<p class='row-sub'>Be the first to earn tickets this week.</p>");
  host.appendChild(race);

  const slap = document.createElement("div");
  slap.className = "board";
  slap.innerHTML = `<h4>Slap speed</h4>` + (b.slap.length
    ? `<ol>${b.slap.map((r) => `<li>${r.handle} <span class="v">${fmt(r.v)} mph</span></li>`).join("")}</ol>`
    : "<p class='row-sub'>No swings on record yet.</p>");
  host.appendChild(slap);
}

/* ---------- Claw game ---------- */
const clawModal = document.getElementById("claw-modal");
const clawTable = document.getElementById("claw-table");
const clawResult = document.getElementById("claw-result");
const clawGrab = document.getElementById("claw-grab");

const CLAW_ODDS = [
  ["1-Year Pretzel Sub", "0.05%"],
  ["20-Pretzel Party Tray", "0.15%"],
  ["PPF Tee", "0.60%"],
  ["Enamel Pin Set", "3.00%"],
  ["Big Twist Capsule (400 tickets)", "12.0%"],
  ["Pretzel Capsule (150 tickets)", "35.0%"],
  ["Slipped Off the Rack (25 tickets)", "49.2%"],
];
clawTable.innerHTML = CLAW_ODDS.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join("");

document.querySelector('[data-play="claw"]').addEventListener("click", () => {
  clawResult.textContent = "";
  clawModal.showModal();
});

clawGrab.addEventListener("click", async () => {
  clawResult.textContent = "The claw drops…";
  clawGrab.disabled = true;
  const r = await call("claw");
  await new Promise((res) => setTimeout(res, 800));
  if (r.ok) {
    apply({ credits: r.data.credits, tickets: r.data.balance });
    await refreshInventory();
    if (r.data.prize) clawResult.textContent = `🎁 ${r.data.summary} — on your shelf.`;
    else clawResult.textContent = `+${fmt(r.data.tickets)} tickets — ${r.data.summary}`;
  } else {
    clawResult.textContent = r.error;
  }
  clawGrab.disabled = false;
});

/* ---------- Wheel game ---------- */
const WHEEL_SPOTS = [
  { k: "1", label: "1", sub: "pays 2x" },
  { k: "2", label: "2", sub: "pays 3.2x" },
  { k: "5", label: "5", sub: "pays 6x" },
  { k: "10", label: "10", sub: "pays 10.5x" },
  { k: "flip", label: "Mustard Flip", sub: "2x–100x" },
  { k: "drop", label: "Salt Drop", sub: "5x–500x" },
  { k: "scratch", label: "Scratch-Off", sub: "5x–500x" },
  { k: "bigtop", label: "Big Pretzel", sub: "10x–1000x" },
];
const wheelModal = document.getElementById("wheel-modal");
const wheelSpots = document.getElementById("wheel-spots");
const wheelYour = document.getElementById("wheel-your");
const wheelResult = document.getElementById("wheel-result");
const wheelChip = document.getElementById("wheel-chip");
const wheelSpin = document.getElementById("wheel-spin");
const wheelBets = {};

function renderWheelBets() {
  for (const el of wheelSpots.children) {
    const k = el.dataset.k;
    const bet = wheelBets[k] ?? 0;
    el.classList.toggle("on", bet > 0);
    el.querySelector(".bet").textContent = bet ? `${bet}` : "";
  }
  const total = Object.values(wheelBets).reduce((s, v) => s + v, 0);
  wheelYour.textContent = total ? `Chips in: ${fmt(total)} credits` : "Tap a spot to place a chip.";
}

wheelSpots.innerHTML = WHEEL_SPOTS.map((s) => `
  <div class="wheel-spot" data-k="${s.k}">
    <b>${s.label}</b>
    <small>${s.sub}</small>
    <span class="bet"></span>
  </div>
`).join("");

for (const el of wheelSpots.children) {
  el.addEventListener("click", () => {
    const k = el.dataset.k;
    const chip = Number(wheelChip.value);
    wheelBets[k] = (wheelBets[k] ?? 0) + chip;
    renderWheelBets();
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const k = el.dataset.k;
    delete wheelBets[k];
    renderWheelBets();
  });
}

document.querySelector('[data-play="wheel"]').addEventListener("click", () => {
  for (const k of Object.keys(wheelBets)) delete wheelBets[k];
  wheelResult.textContent = "";
  renderWheelBets();
  wheelModal.showModal();
});

wheelSpin.addEventListener("click", async () => {
  const bets = { ...wheelBets };
  const total = Object.values(bets).reduce((s, v) => s + v, 0);
  if (!total) { wheelResult.textContent = "Place a chip first."; return; }
  if (total < 10) { wheelResult.textContent = "Minimum bet is 10 credits."; return; }
  wheelSpin.disabled = true;
  wheelResult.textContent = "Spinning…";
  const r = await call("wheel", { bets });
  await new Promise((res) => setTimeout(res, 900));
  if (r.ok) {
    apply({ credits: r.data.credits, tickets: r.data.balance });
    wheelResult.textContent = r.data.tickets > 0 ? `+${fmt(r.data.tickets)} tickets — ${r.data.summary}` : `No chips won — ${r.data.summary}`;
  } else {
    wheelResult.textContent = r.error;
  }
  wheelSpin.disabled = false;
});

/* ---------- Slap game ---------- */
const slapModal = document.getElementById("slap-modal");
const slapField = document.getElementById("slap-field");
const slapPretzel = document.getElementById("slap-pretzel");
const slapResult = document.getElementById("slap-result");

document.querySelector('[data-play="slap"]').addEventListener("click", () => {
  slapResult.textContent = "Drag the pretzel. Swing with purpose.";
  slapField.classList.remove("flying");
  slapPretzel.style.transform = "translateY(-50%)";
  slapModal.showModal();
});

let slapPts = [];
let slapDragging = false;
function slapAddPt(x, trusted) {
  slapPts.push({ x: Math.round(x), t: Date.now(), tr: !!trusted });
}
slapPretzel.addEventListener("pointerdown", (e) => {
  slapDragging = true;
  slapPts = [];
  slapAddPt(e.clientX, e.isTrusted);
  slapPretzel.setPointerCapture(e.pointerId);
});
slapPretzel.addEventListener("pointermove", (e) => {
  if (!slapDragging) return;
  slapAddPt(e.clientX, e.isTrusted);
});
slapPretzel.addEventListener("pointerup", async (e) => {
  if (!slapDragging) return;
  slapDragging = false;
  slapAddPt(e.clientX, e.isTrusted);
  slapField.classList.add("flying");
  const r = await call("slap", { pts: slapPts });
  if (r.ok) {
    apply({ credits: r.data.credits, tickets: r.data.balance, bestMph: Math.max(state.bestMph, r.data.mph) });
    slapResult.textContent = `${r.data.label} · ${r.data.mph} mph · +${fmt(r.data.tickets)} tickets`;
  } else {
    slapResult.textContent = r.error;
    slapField.classList.remove("flying");
  }
  setTimeout(() => slapField.classList.remove("flying"), 1200);
});

/* ---------- Seed rotate ---------- */
document.getElementById("rotate-seed").addEventListener("click", async () => {
  const r = await call("rotate");
  if (r.ok) {
    apply({ seedHash: r.data.seedHash, nonce: 0 });
    alert("Seed rotated. Previous seed revealed in your play history.");
  } else alert(r.error);
});

/* ---------- boot ---------- */
refresh();
