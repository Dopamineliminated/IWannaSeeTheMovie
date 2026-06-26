// 넷플릭스 추천기 — 프론트엔드 (무빌드 바닐라 JS)
const $ = (s) => document.querySelector(s);
const TMDB_IMG = "https://image.tmdb.org/t/p/w342";

const state = {
  config: null,
  sessionKey: null,
  demo: false,
  csvText: null,
  picks: null,
  answers: {},
  exclude: [],
};

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function show(id) { for (const s of ["intro", "picker", "loading", "analysis", "results"]) $("#" + s).classList.toggle("hidden", s !== id); }
let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add("hidden"), 4200);
}

// 포스터: 실제 이미지(있으면) 위에 폴백 타일을 깔아 안전하게 표시
function poster(posterPath, title) {
  const fb = `<div class="fallback"><span>${esc(title)}</span></div>`;
  const img = posterPath ? `<img src="${TMDB_IMG}${esc(posterPath)}" loading="lazy" alt="${esc(title)}" onerror="this.remove()" />` : "";
  return `<div class="poster">${fb}${img}</div>`;
}

// ---------- 초기화 ----------
async function init() {
  try {
    state.config = await (await fetch("/api/config")).json();
  } catch { toast("서버에 연결하지 못했습니다."); return; }
  const c = state.config;
  $("#catalogNote").textContent = `현재 카탈로그 ${c.catalogSize.toLocaleString()}개 작품 · 지역 ${c.region}`
    + (c.hasApiKey ? "" : " · 데모 카탈로그");
  if (!c.hasApiKey) {
    $("#apiKeyNote").innerHTML = "지금은 <b>데모 카탈로그</b>로 동작합니다. 서버에 TMDB 키를 설정하면 시청기록 매칭과 추천 범위가 크게 넓어져요.";
  }
}

// ---------- 1단계: 파일 업로드 / 데모 ----------
function wireIntro() {
  const drop = $("#drop"), fileInput = $("#fileInput");
  $("#pickStartBtn").onclick = openPicker;
  $("#csvStartBtn").onclick = () => { $("#csvArea").classList.toggle("hidden"); };
  $("#pickBtn").onclick = () => fileInput.click();
  drop.onclick = (e) => { if (e.target.closest("button")) return; fileInput.click(); };
  fileInput.onchange = () => fileInput.files[0] && readFile(fileInput.files[0]);
  ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) readFile(f); });
  $("#demoBtn").onclick = () => analyze({ demo: true });
}

function readFile(file) {
  if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") { toast("CSV 파일을 올려주세요 (NetflixViewingHistory.csv)."); return; }
  $("#fileName").textContent = file.name;
  $("#drop").classList.add("has-file");
  const reader = new FileReader();
  reader.onload = () => analyze({ csv: reader.result });
  reader.onerror = () => toast("파일을 읽지 못했습니다.");
  reader.readAsText(file, "utf-8");
}

// ---------- 빠르게 고르기 (픽커) ----------
let pickItems = [];          // 그리드에 보이는 후보들
let pickSearchItems = [];    // 최근 검색 결과
const pickSel = new Map();   // 선택된 key -> item

function pickTileHtml(it) {
  const sel = pickSel.has(it.key) ? " selected" : "";
  return `<div class="pick-tile${sel}" data-key="${esc(it.key)}">
    <div class="check">✓</div>${poster(it.poster_path, it.title)}
    <div class="pick-name">${esc(it.title)}</div></div>`;
}
function renderPickGrid() {
  const g = $("#pickGrid");
  g.innerHTML = pickItems.map(pickTileHtml).join("");
  g.querySelectorAll(".pick-tile").forEach((el) => (el.onclick = () => togglePick(el.dataset.key)));
}
function togglePick(key) {
  if (pickSel.has(key)) pickSel.delete(key);
  else {
    const it = pickItems.find((x) => x.key === key) || pickSearchItems.find((x) => x.key === key);
    if (it) pickSel.set(key, it);
  }
  renderPickGrid();
  updatePickCount();
}
function updatePickCount() {
  const n = pickSel.size;
  $("#pickCount").textContent = `${n}개 선택`;
  $("#pickDoneBtn").disabled = n < 1;
  $("#pickDoneBtn").textContent = n >= 3 ? "✨ 추천 받기" : n >= 1 ? `✨ 추천 받기 (${3 - n}개 더 고르면 정확해져요)` : "✨ 추천 받기";
}
async function openPicker() {
  show("picker");
  pickSel.clear(); pickItems = []; updatePickCount();
  $("#pickSearch").value = ""; $("#pickSearchResults").classList.add("hidden");
  $("#pickGrid").innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const r = await (await fetch("/api/popular?n=60")).json();
    pickItems = r.results;
    renderPickGrid();
  } catch { $("#pickGrid").innerHTML = '<p class="muted">목록을 불러오지 못했어요. 검색으로 추가해 주세요.</p>'; }
}
function wirePickSearch() {
  const input = $("#pickSearch"), box = $("#pickSearchResults");
  let t;
  input.addEventListener("input", () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 1) { box.classList.add("hidden"); box.innerHTML = ""; return; }
    t = setTimeout(async () => {
      try {
        const r = await (await fetch("/api/search?q=" + encodeURIComponent(q))).json();
        pickSearchItems = r.results;
        if (!r.results.length) { box.classList.add("hidden"); box.innerHTML = ""; return; }
        box.innerHTML = pickSearchItems.map(pickTileHtml).join("");
        box.classList.remove("hidden");
        box.querySelectorAll(".pick-tile").forEach((el) => (el.onclick = () => {
          const key = el.dataset.key;
          const it = pickSearchItems.find((x) => x.key === key);
          if (it && !pickItems.find((x) => x.key === key)) pickItems.unshift(it);
          if (it) pickSel.set(key, it);
          input.value = ""; box.classList.add("hidden"); box.innerHTML = "";
          renderPickGrid(); updatePickCount();
        }));
      } catch { box.classList.add("hidden"); }
    }, 220);
  });
}

// ---------- 분석 ----------
async function analyze(payload) {
  state.demo = !!payload.demo;
  state.csvText = payload.csv || null;
  state.picks = payload.picks || null;
  $("#loadingText").textContent = state.demo ? "데모 시청기록을 분석하는 중…" : "시청기록을 분석하는 중…";
  show("loading");
  let data;
  try {
    const res = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || "분석 실패");
  } catch (e) { toast(e.message); show("intro"); return; }
  state.sessionKey = data.key;
  renderProfile(data);
  renderQuestions();
  state.answers = {};
  show("analysis");
}

function renderProfile(data) {
  $("#playerName").textContent = data.label;
  const s = data.stats;
  let sum = `${s.titles.toLocaleString()}개 작품 인식 · ${s.matched.toLocaleString()}개 매칭`;
  if (s.online) sum += ` (TMDB 검색 ${s.online})`;
  $("#libSummary").textContent = sum;

  $("#topTags").innerHTML = data.profile.topTags.map((t) =>
    `<span class="tag-chip">${esc(t.ko)}${t.title ? ` · <b>${esc(t.title)}</b>` : ""}</span>`).join("");

  $("#topGames").innerHTML = data.top.map((g) => `
    <div class="mini-game">
      ${poster(g.poster_path, g.title)}
      ${g.count > 1 ? `<span class="count">${g.count}회</span>` : ""}
      <div class="mini-title">${esc(g.title)}</div>
    </div>`).join("");
}

// ---------- 질문 렌더 ----------
function renderQuestions() {
  const wrap = $("#questions");
  wrap.innerHTML = "";
  for (const q of state.config.questions) {
    const el = document.createElement("div");
    el.className = "question";
    el.innerHTML = `<div class="q-title">${esc(q.title)}</div>${q.hint ? `<div class="q-hint">${esc(q.hint)}</div>` : ""}`;
    if (q.type === "seed") el.appendChild(seedField());
    else el.appendChild(optionsField(q));
    wrap.appendChild(el);
  }
}

function optionsField(q) {
  const box = document.createElement("div");
  box.className = "options";
  for (const o of q.options) {
    const b = document.createElement("div");
    b.className = "opt"; b.textContent = o.label; b.dataset.value = o.value;
    b.onclick = () => toggleOption(q, o.value, box, b);
    box.appendChild(b);
  }
  return box;
}

function toggleOption(q, value, box, btn) {
  if (q.type === "multi") {
    const cur = new Set(state.answers[q.id] || []);
    cur.has(value) ? cur.delete(value) : cur.add(value);
    state.answers[q.id] = [...cur];
    btn.classList.toggle("selected");
  } else { // single
    const was = btn.classList.contains("selected");
    box.querySelectorAll(".opt").forEach((x) => x.classList.remove("selected"));
    if (was) { delete state.answers[q.id]; }
    else { state.answers[q.id] = value; btn.classList.add("selected"); }
  }
}

// 시드: 이 작품과 비슷한
function seedField() {
  const box = document.createElement("div");
  box.className = "seed-box";
  box.innerHTML = `<input class="seed-input" type="text" placeholder="영화·시리즈 이름 검색 (예: 종이의 집)" autocomplete="off" />
    <div class="seed-suggest hidden"></div>`;
  const input = box.querySelector(".seed-input");
  const sug = box.querySelector(".seed-suggest");
  let t;
  input.addEventListener("input", () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 1) { sug.classList.add("hidden"); return; }
    t = setTimeout(async () => {
      try {
        const r = await (await fetch("/api/search?q=" + encodeURIComponent(q))).json();
        if (!r.results.length) { sug.classList.add("hidden"); return; }
        sug.innerHTML = r.results.map((x) => `
          <div class="seed-opt" data-key="${esc(x.key)}" data-title="${esc(x.title)}">
            ${poster(x.poster_path, x.title)}
            <div class="label">${esc(x.title)} <small>${x.year || ""} · ${x.type === "tv" ? "시리즈" : "영화"}</small></div>
          </div>`).join("");
        sug.classList.remove("hidden");
        sug.querySelectorAll(".seed-opt").forEach((opt) => opt.onclick = () => {
          state.answers.seed = opt.dataset.key;
          box.innerHTML = `<div class="seed-selected"><span class="seed-chip">🎯 <b>${esc(opt.dataset.title)}</b>와(과) 비슷하게 <span class="seed-x">✕</span></span></div>`;
          box.querySelector(".seed-x").onclick = () => { delete state.answers.seed; box.replaceWith(seedField()); };
        });
      } catch { sug.classList.add("hidden"); }
    }, 220);
  });
  document.addEventListener("click", (e) => { if (!box.contains(e.target)) sug.classList.add("hidden"); });
  return box;
}

// ---------- 추천 ----------
async function doRecommend(reset) {
  if (reset) state.exclude = [];
  const btn = reset ? $("#recommendBtn") : $("#rerollBtn");
  const prev = btn.textContent; btn.disabled = true; btn.textContent = "불러오는 중…";
  try {
    const res = await fetch("/api/recommend", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: state.sessionKey, demo: state.demo, csv: state.csvText, picks: state.picks, answers: state.answers, exclude: state.exclude, count: 12 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "추천 실패");
    if (!data.recommendations.length) { toast("조건에 맞는 작품이 없어요. 필터를 줄여보세요."); return; }
    renderResults(data.recommendations);
    state.exclude.push(...data.recommendations.map((r) => `${r.type}:${r.id}`));
    show("results");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = prev; }
}

function renderResults(recs) {
  $("#recGrid").innerHTML = recs.map((r) => {
    const meta = [r.year, r.type === "tv" ? "시리즈" : "영화", r.langKo, r.runtime ? (r.type === "tv" ? `회당 ${r.runtime}분` : `${r.runtime}분`) : ""].filter(Boolean).join(" · ");
    return `
    <div class="rec">
      <div style="position:relative">
        <div class="rec-badges">
          <span class="badge type ${r.type}">${r.type === "tv" ? "📺 시리즈" : "🎞️ 영화"}</span>
        </div>
        ${poster(r.poster_path, r.title)}
      </div>
      <div class="rec-body">
        <div class="rec-title">${esc(r.title)}</div>
        <div class="rec-meta">${esc(meta)}</div>
        ${r.matchTags.length ? `<div class="match-tags">${r.matchTags.map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
        <div class="reasons">${r.reasons.map((x) => `<div>${esc(x)}</div>`).join("")}</div>
        <div class="rec-foot">
          <a href="${esc(r.netflix)}" target="_blank" rel="noopener">▶ 넷플릭스에서 보기</a>
          ${r.poster_path ? `<a class="sub" href="${esc(r.tmdb)}" target="_blank" rel="noopener">상세</a>` : ""}
        </div>
      </div>
    </div>`;
  }).join("");
}

// ---------- 버튼 ----------
function wire() {
  wireIntro();
  wirePickSearch();
  $("#pickDoneBtn").onclick = () => analyze({ picks: [...pickSel.keys()] });
  $("#pickBackBtn").onclick = () => show("intro");
  $("#recommendBtn").onclick = () => doRecommend(true);
  $("#rerollBtn").onclick = () => doRecommend(false);
  $("#resetBtn").onclick = () => { state.answers = {}; state.picks = null; pickSel.clear(); $("#csvArea").classList.add("hidden"); $("#drop").classList.remove("has-file"); $("#fileName").textContent = "NetflixViewingHistory.csv"; show("intro"); };
  $("#editBtn").onclick = () => show("analysis");
}

init();
wire();
