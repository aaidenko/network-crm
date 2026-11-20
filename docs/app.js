// Network dashboard: a read-only view of the CRM. Data comes from the MCP
// server's /data route; the connector URL (which contains the secret) is kept
// in this browser's localStorage and never in this repo.

const STORE_KEY = "crm_url";
const app = document.getElementById("app");
const state = { data: null, url: null, q: "", tag: null, group: "none", graphGroup: "tag", sel: null, loadedAt: 0 };

// ---------- utils ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

function fmtDate(iso, withYear = false) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z");
  const sameYear = state.data && iso.slice(0, 4) === state.data.today.slice(0, 4);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: withYear ? undefined : "numeric",
    year: withYear || !sameYear ? "numeric" : undefined,
    timeZone: "UTC",
  });
}

const store = {
  get() { try { return localStorage.getItem(STORE_KEY); } catch { return state.url; } },
  set(v) { state.url = v; try { localStorage.setItem(STORE_KEY, v); } catch { /* memory only */ } },
  clear() { state.url = null; try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ } },
};

const ICON_SEARCH = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>';
const ICON_BACK = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"></path></svg>';

// ---------- data ----------

async function load() {
  const base = state.url.replace(/\/+$/, "");
  const res = await fetch(base + "/data", { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  const raw = await res.json();

  const byId = new Map();
  for (const p of raw.people) {
    p.over = daysBetween(p.next_due, raw.today);
    p.tags = p.tags || [];
    p.knows = [];
    p.history = [];
    p.followUps = [];
    p.haystack = [p.name, p.company, p.role, p.location, p.how_met, p.introduced_by, p.email, p.notes, ...p.tags]
      .filter(Boolean).join(" ").toLowerCase();
    byId.set(p.id, p);
  }
  for (const r of raw.relationships) {
    const a = byId.get(r.person_a), b = byId.get(r.person_b);
    if (!a || !b) continue;
    a.knows.push({ person: b, note: r.note });
    b.knows.push({ person: a, note: r.note });
  }
  for (const i of raw.interactions) byId.get(i.person_id)?.history.push(i);
  for (const f of raw.follow_ups) byId.get(f.person_id)?.followUps.push(f);

  state.data = {
    today: raw.today,
    people: raw.people,
    byId,
    links: raw.relationships.filter((r) => byId.has(r.person_a) && byId.has(r.person_b)),
    followUps: raw.follow_ups.filter((f) => byId.has(f.person_id)).map((f) => ({ ...f, person: byId.get(f.person_id) })),
  };
  state.loadedAt = Date.now();
  state.layout = null;
}

function matches(p) {
  if (state.tag && !p.tags.includes(state.tag)) return false;
  const q = state.q.trim().toLowerCase();
  return !q || q.split(/\s+/).every((w) => p.haystack.includes(w));
}

// ---------- shared pieces ----------

function header(active) {
  return `
  <header class="top">
    <div class="brand">
      <h1>Network</h1>
      <nav class="seg" aria-label="View">
        <a href="#/" ${active === "list" ? 'aria-current="page"' : ""}>List</a>
        <a href="#/graph" ${active === "graph" ? 'aria-current="page"' : ""}>Graph</a>
      </nav>
    </div>
    <label class="search">${ICON_SEARCH}<span class="sr">Search</span>
      <input id="q" type="search" placeholder="Search anything" autocomplete="off" value="${esc(state.q)}">
    </label>
  </header>`;
}

function bindSearch(onChange) {
  const input = document.getElementById("q");
  input.addEventListener("input", () => { state.q = input.value; onChange(); });
}

const lastLabel = (p) => (p.last_contact ? fmtDate(p.last_contact) : "Never");
const overLabel = (p) => (p.over === 0 ? "today" : `${p.over}d`);

// ---------- list ----------

function renderList() {
  const tags = [...new Set(state.data.people.flatMap((p) => p.tags))].sort();
  app.innerHTML = `
  <div class="wrap">
    ${header("list")}
    <div class="filters">
      <div class="chips" role="group" aria-label="Tags">
        ${[null, ...tags].map((t) => `<button type="button" class="chip" data-tag="${esc(t ?? "")}" aria-pressed="${state.tag === t}">${esc(t ?? "All")}</button>`).join("")}
      </div>
      <label class="groupby">Group by
        <select id="groupby">
          ${[["none", "Nothing"], ["company", "Company"], ["tag", "Tag"], ["met", "How we met"]]
            .map(([v, l]) => `<option value="${v}" ${state.group === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
    </div>
    <div id="body" style="display:contents"></div>
  </div>`;

  bindSearch(renderListBody);
  app.querySelector(".chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tag]");
    if (!b) return;
    state.tag = b.dataset.tag || null;
    app.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String((c.dataset.tag || null) === state.tag)));
    renderListBody();
  });
  document.getElementById("groupby").addEventListener("change", (e) => { state.group = e.target.value; renderListBody(); });
  renderListBody();
}

function renderListBody() {
  const shown = state.data.people.filter(matches);
  const shownIds = new Set(shown.map((p) => p.id));
  const due = shown.filter((p) => p.over >= 0).sort((a, b) => b.over - a.over);
  const followUps = state.data.followUps.filter((f) => shownIds.has(f.person_id));
  const today = state.data.today;

  let html = "";
  if (due.length) {
    html += `<section><h2 class="label">Reach out <span>${due.length}</span></h2>
      ${due.map((p) => `
        <a class="row" href="#/p/${p.id}">
          <span class="main"><span class="name">${esc(p.name)}</span> <span class="dim sub">${esc(p.company ?? "")}<span class="sub-sep">${p.company ? " · " : ""}${lastLabel(p)}</span></span></span>
          <span class="dim num last-col">${lastLabel(p)}</span>
          <span class="over num days">${overLabel(p)}</span>
        </a>`).join("")}
    </section>`;
  }
  if (followUps.length) {
    html += `<section><h2 class="label">Follow-ups <span>${followUps.length}</span></h2>
      ${followUps.map((f) => `
        <a class="row" href="#/p/${f.person_id}">
          <span class="main"><span>${esc(f.description)}</span> <span class="dim sub"><span class="sub-dot">· </span>${esc(f.person.name)}</span></span>
          <span class="num ${f.due_on && f.due_on <= today ? "over" : "dim"}">${fmtDate(f.due_on)}</span>
        </a>`).join("")}
    </section>`;
  }

  html += `<section style="gap:24px"><h2 class="label" style="margin:0">Everyone <span>${shown.length}</span></h2>`;
  if (!state.data.people.length) html += `<p class="empty">No one yet. Tell Claude about someone.</p>`;
  else if (!shown.length) html += `<p class="empty">No matches</p>`;
  else {
    html += `<div class="groups">${groupPeople(shown).map((g) => `
      <div class="group">
        ${g.label !== null ? `<h3>${esc(g.label)} <span>${g.rows.length}</span></h3>` : ""}
        ${g.rows.map((p) => `
          <a class="person-row" href="#/p/${p.id}">
            <span class="name">${esc(p.name)}</span>
            <span class="company">${esc(p.company ?? "")}</span>
            <span class="tags dim">${esc(p.tags.join(", "))}</span>
            <span class="last dim num">${lastLabel(p)}</span>
          </a>`).join("")}
      </div>`).join("")}</div>`;
  }
  html += `</section>`;
  document.getElementById("body").innerHTML = html;
}

function groupPeople(people) {
  if (state.group === "none") return [{ label: null, rows: people }];
  const map = new Map();
  for (const p of people) {
    const keys = state.group === "tag" ? (p.tags.length ? p.tags : ["untagged"])
      : [state.group === "company" ? p.company || "No company" : p.how_met || "Unknown"];
    for (const k of keys) {
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([label, rows]) => ({ label, rows }));
}

// ---------- person ----------

function renderPerson(id) {
  const p = state.data.byId.get(id);
  if (!p) { location.hash = "#/"; return; }
  const linkedin = p.linkedin && (/^https?:\/\//.test(p.linkedin) ? p.linkedin : `https://www.linkedin.com/in/${p.linkedin.replace(/^@/, "")}`);
  const contact = [
    p.email && `<a class="u" href="mailto:${esc(p.email)}"><span class="full">${esc(p.email)}</span><span class="short">Email</span></a>`,
    p.phone && `<a class="u" href="sms:${esc(p.phone.replace(/[^\d+]/g, ""))}"><span class="full">${esc(p.phone)}</span><span class="short">Text</span></a>`,
    linkedin && `<a class="u" href="${esc(linkedin)}" target="_blank" rel="noopener">LinkedIn</a>`,
  ].filter(Boolean);
  const subtitle = [[p.role, p.company].filter(Boolean).join(", "), p.location].filter(Boolean).join(" · ");
  const met = [p.how_met, p.met_on && fmtDate(p.met_on, true)].filter(Boolean).join(", ");
  const today = state.data.today;

  const facts = [
    met && ["Met", esc(met)],
    p.introduced_by && ["Introduced by", esc(p.introduced_by)],
    ["Last talked", `${lastLabel(p)}${p.over >= 0 ? ` <span class="over">· ${p.over === 0 ? "due today" : `${p.over}d overdue`}</span>` : ""}`],
    ["Every", `${p.cadence_days} days`],
    p.tags.length && ["Tags", esc(p.tags.join(", "))],
    p.knows.length && ["Knows", `<span class="knows">${p.knows.map((k) =>
      `<span><a class="u" href="#/p/${k.person.id}">${esc(k.person.name)}</a>${k.note ? ` <span class="dim">· ${esc(k.note)}</span>` : ""}</span>`).join("")}</span>`],
  ].filter(Boolean);

  app.innerHTML = `
  <div class="wrap">
    <a class="back" href="#/">${ICON_BACK} Network</a>
    <header class="who">
      <h1>${esc(p.name)}</h1>
      ${subtitle ? `<p class="dim">${esc(subtitle)}</p>` : ""}
      ${contact.length ? `<p class="contact">${contact.join("")}</p>` : ""}
    </header>
    <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    ${p.notes ? `<p class="notes">${esc(p.notes)}</p>` : ""}
    ${p.followUps.length ? `<section><h2 class="label">Follow-ups</h2>
      ${p.followUps.map((f) => `<div class="row"><span class="main">${esc(f.description)}</span>
        <span class="num ${f.due_on && f.due_on <= today ? "over" : "dim"}">${fmtDate(f.due_on)}</span></div>`).join("")}
    </section>` : ""}
    ${p.history.length ? `<section><h2 class="label">History</h2>
      ${p.history.map((h) => `<div class="hist">
        <div class="when"><span>${fmtDate(h.occurred_on)}</span>${h.channel ? `<small>${esc(h.channel)}</small>` : ""}</div>
        <p>${esc(h.summary)}</p></div>`).join("")}
    </section>` : ""}
  </div>`;
  window.scrollTo(0, 0);
}

// ---------- graph ----------

const W = 840, H = 560;

function graphLayout() {
  const key = state.graphGroup;
  if (state.layout?.key === key) return state.layout;

  const groupOf = (p) => key === "tag" ? p.tags[0] || "untagged" : p.company || "No company";
  const nodes = state.data.people.map((p) => ({ id: p.id, p, g: groupOf(p) }));
  const counts = d3.rollup(nodes, (v) => v.length, (d) => d.g);
  const groups = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
  const ring = groups.length > 1 ? Math.min(W, H) * 0.34 : 0;
  const centers = new Map(groups.map((g, i) => {
    const t = (i / groups.length) * 2 * Math.PI - Math.PI / 2;
    return [g, { x: W / 2 + ring * 1.25 * Math.cos(t), y: H / 2 + ring * Math.sin(t) }];
  }));
  const links = state.data.links.map((l) => ({ source: l.person_a, target: l.person_b }));

  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((d) => d.id).distance(90).strength(0.02))
    .force("charge", d3.forceManyBody().strength(-160).distanceMax(220))
    .force("x", d3.forceX((d) => centers.get(d.g).x).strength(0.12))
    .force("y", d3.forceY((d) => centers.get(d.g).y).strength(0.12))
    // Labels are wider than tall, so keep nodes apart by roughly a label's width.
    .force("collide", d3.forceCollide(46).strength(1).iterations(3))
    .stop();
  for (let i = 0; i < 400; i++) sim.tick();

  const bubbles = groups.map((g) => {
    const members = nodes.filter((n) => n.g === g);
    const cx = d3.mean(members, (n) => n.x), cy = d3.mean(members, (n) => n.y);
    const r = (d3.max(members, (n) => Math.hypot(n.x - cx, n.y - cy)) || 0) + 44;
    return { g, x: cx, y: cy, r };
  });
  const pad = 24;
  const minX = d3.min(bubbles, (b) => b.x - b.r) - pad, maxX = d3.max(bubbles, (b) => b.x + b.r) + pad;
  const minY = d3.min(bubbles, (b) => b.y - b.r) - pad - 18, maxY = d3.max(bubbles, (b) => b.y + b.r) + pad;
  state.layout = { key, nodes, links, bubbles, viewBox: [minX, minY, maxX - minX, maxY - minY] };
  return state.layout;
}

function renderGraph() {
  app.innerHTML = `
  <div class="wrap wide">
    ${header("graph")}
    <div class="filters" style="justify-content:flex-end">
      <label class="groupby">Group by
        <select id="ggroup">
          <option value="tag" ${state.graphGroup === "tag" ? "selected" : ""}>Tag</option>
          <option value="company" ${state.graphGroup === "company" ? "selected" : ""}>Company</option>
        </select>
      </label>
    </div>
    <div class="graph-layout">
      <div class="graph-box" id="graph"></div>
      <aside class="side" id="side"></aside>
    </div>
  </div>`;
  bindSearch(styleGraph);
  document.getElementById("ggroup").addEventListener("change", (e) => { state.graphGroup = e.target.value; drawGraph(); });

  const box = document.getElementById("graph");
  box.addEventListener("click", (e) => {
    const n = e.target.closest(".node");
    if (n) select(n.dataset.id);
  });
  box.addEventListener("keydown", (e) => {
    const n = e.target.closest(".node");
    if (n && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(n.dataset.id); }
  });
  document.getElementById("side").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sel]");
    if (b) select(b.dataset.sel);
  });
  drawGraph();
}

function drawGraph() {
  const box = document.getElementById("graph");
  if (!state.data.people.length) { box.innerHTML = `<p class="empty" style="padding:24px">No one yet.</p>`; return; }
  const L = graphLayout();
  if (!state.sel || !state.data.byId.has(state.sel)) {
    state.sel = [...state.data.people].sort((a, b) => b.knows.length - a.knows.length)[0].id;
  }
  const pos = new Map(L.nodes.map((n) => [n.id, n]));
  box.innerHTML = `
  <svg viewBox="${L.viewBox.join(" ")}" role="img" aria-label="Network graph">
    ${L.bubbles.map((b) => `<circle class="bubble" cx="${b.x}" cy="${b.y}" r="${b.r}"></circle>
      <text class="glabel" x="${b.x}" y="${b.y - b.r - 8}" text-anchor="middle">${esc(b.g)}</text>`).join("")}
    ${state.data.links.map((l) => {
      const a = pos.get(l.person_a), b = pos.get(l.person_b);
      return `<line data-a="${l.person_a}" data-b="${l.person_b}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"></line>`;
    }).join("")}
    ${L.nodes.map((n) => `
      <g class="node ${n.p.over >= 0 ? "overdue" : ""}" data-id="${n.id}" tabindex="0" role="button" aria-label="${esc(n.p.name)}">
        <circle cx="${n.x}" cy="${n.y}" r="18" fill="transparent"></circle>
        <circle class="ring" cx="${n.x}" cy="${n.y}" r="12"></circle>
        <circle class="dot" cx="${n.x}" cy="${n.y}" r="7"></circle>
        <text x="${n.x}" y="${n.y + 25}" text-anchor="middle">${esc(n.p.name)}</text>
      </g>`).join("")}
  </svg>`;
  styleGraph();
}

function select(id) { state.sel = id; styleGraph(); }

function styleGraph() {
  const box = document.getElementById("graph");
  if (!box || !state.data.people.length) return;
  const s = state.sel;
  const p = state.data.byId.get(s);
  const neighbors = new Set(p.knows.map((k) => k.person.id));
  const searching = state.q.trim() !== "";

  box.querySelectorAll(".node").forEach((el) => {
    const id = el.dataset.id;
    const person = state.data.byId.get(id);
    el.classList.toggle("sel", id === s);
    const visible = searching ? matches(person) || id === s : id === s || neighbors.has(id);
    el.classList.toggle("fade", !visible);
  });
  box.querySelectorAll("line").forEach((el) => el.classList.toggle("on", el.dataset.a === s || el.dataset.b === s));

  const sub = [p.role, p.company].filter(Boolean).join(", ");
  document.getElementById("side").innerHTML = `
    <div style="display:flex;flex-direction:column;gap:2px">
      <h2>${esc(p.name)}</h2>
      ${sub ? `<p class="dim">${esc(sub)}</p>` : ""}
      ${p.over >= 0 ? `<p class="over" style="margin-top:4px">${p.over === 0 ? "Due today" : `${p.over}d overdue`}</p>` : ""}
    </div>
    ${p.knows.length ? `<section><h2 class="label" style="font-size:13px">Knows</h2>
      ${p.knows.map((k) => `<button type="button" class="k" data-sel="${k.person.id}">
        <span>${esc(k.person.name)}</span><span>${esc(k.note ?? "")}</span></button>`).join("")}
    </section>` : ""}
    <a class="u" href="#/p/${p.id}" style="font-size:13px;align-self:flex-start">Open profile</a>`;
}

// ---------- connect & routing ----------

function renderConnect(error, value = "") {
  app.innerHTML = `
  <form class="connect" id="connect">
    <h1>Network</h1>
    <label class="sr" for="url">Connector URL</label>
    <input id="url" type="url" placeholder="Connector URL" required autocomplete="off" value="${esc(value)}">
    <button type="submit">Open</button>
    ${error ? `<p class="empty">${esc(error)}</p>` : ""}
  </form>`;
  document.getElementById("connect").addEventListener("submit", async (e) => {
    e.preventDefault();
    store.set(document.getElementById("url").value.trim());
    start();
  });
}

function route() {
  if (!state.data) return;
  const h = location.hash || "#/";
  const m = h.match(/^#\/p\/([0-9a-f-]{36})$/);
  if (m) renderPerson(m[1]);
  else if (h === "#/graph") renderGraph();
  else renderList();
}

async function start() {
  // A link like .../#connect=<connector url> saves the URL on a new device.
  const m = location.hash.match(/^#connect=(.+)$/);
  if (m) {
    store.set(decodeURIComponent(m[1]));
    history.replaceState(null, "", location.pathname + "#/");
  }
  state.url = store.get();
  if (!state.url) return renderConnect();
  try {
    await load();
  } catch {
    // Don't forget the URL on a flaky connection; let the user retry or fix it.
    return renderConnect("Couldn't load. Check the URL or your connection.", state.url);
  }
  route();
}

window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !state.data || Date.now() - state.loadedAt < 60_000) return;
  try { await load(); route(); } catch { /* keep showing what we have */ }
});

start();
