// Sol Works - 일정 / 사업공고 / 할 일 / 메모
// 개인 데이터는 브라우저 localStorage 에 저장되고, 공고는 data/notices.json 에서 읽는다.

const KINDS = { work: "업무", meeting: "회의", deadline: "마감", personal: "개인" };
const KIND_COLOR = { work: "var(--c-work)", meeting: "var(--c-meeting)", deadline: "var(--c-deadline)", personal: "var(--c-personal)" };

// ---------------------------------------------------------------- 저장소

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("mwp." + key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("mwp." + key, JSON.stringify(value)); } catch { /* 저장 불가 환경 */ }
    // 로그인해 있으면 같은 내용을 클라우드(Firebase)에도 올린다 (sync.js)
    if (SYNC_KEYS.includes(key)) window.solSync?.push(key, value);
  },
  has(key) {
    try { return localStorage.getItem("mwp." + key) != null; } catch { return false; }
  },
};

// 기기 사이에 동기화하는 데이터. 탭·필터 같은 화면 설정은 기기마다 따로 둔다.
const SYNC_KEYS = ["events", "todos", "works", "notes", "stars", "noticeMemos"];

const state = {
  events: store.get("events", []),
  // 처음엔 비워 둔다. (예전엔 설정 안내를 넣어 뒀는데, 새 기기에서 로그인하면 계정 할 일에 다시 합쳐지는 문제가 있었다)
  todos: store.get("todos", []),
  works: store.get("works", []),     // 진행 중인 업무 {id, title, due, progress 0~100}
  stars: store.get("stars", {}),     // 공고 id -> 공고 사본 (목록에서 빠져도 유지)
  noticeMemos: store.get("noticeMemos", {}),   // 공고 id -> {text, updated, title, url, end, kind}
  editingMemo: null,                 // 지금 메모를 쓰고 있는 공고 id
  memo: store.get("memo", ""),       // 예전 한 칸짜리 메모 (포스트잇으로 옮긴다)
  notes: store.get("notes", null),   // 포스트잇 {id, text, color, updated}
  notices: [],
  noticeMeta: {},
  nTags: new Set(store.get("nTags", [])),   // 사업공고 해시태그 필터
  cal: { year: 0, month: 0, selected: "" },
};

// ---------------------------------------------------------------- 유틸

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
// 매일 하는 일(daily)은 체크한 날(doneOn)에만 완료. 다음 날이 되면 저절로 다시 할 일이 된다.
const isDone = (t) => (t.daily ? t.doneOn === todayStr() : !!t.done);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
// "20261015", "2026-10-15", "2026.10.15" → "2026-10-15". 날짜가 아니면 null.
function toIso(text) {
  const m = String(text || "").trim().match(/^(\d{4})[-./]?(\d{1,2})[-./]?(\d{1,2})$/);
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}
const compact = (iso) => (iso || "").replace(/-/g, "");

// 숫자 날짜 칸을 읽는다. 비었으면 "" (필수면 undefined), 잘못되면 안내를 띄우고 undefined.
function readYmd(input, required) {
  const v = input.value.trim();
  input.setCustomValidity("");
  if (!v && !required) return "";
  const iso = toIso(v);
  if (!iso) {
    input.setCustomValidity("날짜를 20261015 처럼 8자리 숫자로 입력해 주세요.");
    input.reportValidity();
    return undefined;
  }
  return iso;
}
document.addEventListener("input", (e) => {
  if (!e.target.classList.contains("ymd")) return;
  e.target.setCustomValidity("");
  e.target.value = e.target.value.replace(/[^0-9]/g, "").slice(0, 8);
});

const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");

// 둥근 모서리 별 아이콘 (켜면 채움, 끄면 테두리만)
const STAR_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3.6l2.5 5.1 5.6.8-4 3.9.9 5.6L12 16.4 7 19l.9-5.6-4-3.9 5.6-.8z" stroke-linejoin="round" stroke-linecap="round"/></svg>`;

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(y, m - 1, d) - t) / 86400000);
}

function ddayBadge(end) {
  const n = daysUntil(end);
  if (n == null) return `<span class="badge">상시/미정</span>`;
  if (n < 0) return `<span class="badge closed">마감</span>`;
  const label = n === 0 ? "D-Day" : `D-${n}`;
  return `<span class="badge dday ${n <= 3 ? "urgent" : ""}">${label}</span>`;
}

// 최신 등록순. 출처마다 '등록일' 칸 뜻이 달라서(K-Startup·NTIS는 접수 시작일) 미래 날짜는 처음 본 날로 낮춘다.
// 그래야 지원사업·연구과제가 실제 날짜대로 섞이고, 접수 시작이 먼 공고가 맨 위에 몰리지 않는다.
function regDate(n) {
  const seen = n.first_seen || "";
  const p = n.posted || seen;
  return seen && p > seen ? seen : p;
}
function byNewest(a, b) {
  return regDate(b).localeCompare(regDate(a)) || (a.end || "9999").localeCompare(b.end || "9999");
}

function isNew(n) {
  const d = daysUntil(n.first_seen);
  return d != null && d >= -2; // 최근 3일 안에 처음 수집됨
}

// ---------------------------------------------------------------- 탭

// ---------------------------------------------------------------- 서비스 선택 화면
// 로그인하면 서비스 카드(대시보드 · AI 영상 분석 · 여행)부터 보여주고, 대시보드를 누르면 지금 화면으로.

function showHub() {
  document.body.classList.add("hub-mode");
  history.replaceState(null, "", "#hub");
  renderHub();
}
function openDashboard() {
  document.body.classList.remove("hub-mode");
  showTab(store.get("tab", "home"));
}
function renderHub() {
  const todos = state.todos.filter((t) => !t.offHome && !isDone(t)).length;
  const works = state.works.filter((w) => !workProgress || workProgress(w) < 100).length;
  const fresh = state.notices.filter(isNew).length;
  $("#dashMeta").textContent = `할 일 ${todos} · 진행 중 업무 ${works} · 새 공고 ${fresh}`;
}
$("#openDash").addEventListener("click", openDashboard);
$("#toHub").addEventListener("click", showHub);

function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("active", s.id === "tab-" + name));
  store.set("tab", name);
  location.hash = name;
}
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------------------------------------------------------------- 대시보드

function renderHome() {
  $("#homeTodo").innerHTML = todoListHTML();
  renderWorks();

  const fresh = state.notices.filter(isNew);
  const freshShown = fresh.filter((n) => n.matched && n.matched.length).concat(fresh.filter((n) => !(n.matched && n.matched.length))).slice(0, 10);
  $("#homeNewCount").textContent = fresh.length ? `(${fresh.length}건)` : "";
  $("#homeNew").innerHTML = freshShown.length
    ? freshShown.map((n) => `<li>${kindBadge(n)}${(n.matched || []).map((k) => `<span class="badge new">${esc(k)}</span>`).join("")}<a class="grow" href="${esc(safeUrl(n.url))}" target="_blank" rel="noopener">${esc(n.title)}</a>${ddayBadge(n.end)}</li>`).join("")
    : `<li class="empty">최근 3일 동안 새 공고가 없습니다.</li>`;

}


// ---------------------------------------------------------------- 달력

function renderCalendar() {
  const { year, month } = state.cal;
  $("#calTitle").textContent = `${year}년 ${month + 1}월`;
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const today = todayStr();

  const byDate = {};
  for (const e of state.events) (byDate[e.date] ||= []).push(e);
  const added = new Set(state.events.map((e) => e.noticeId).filter(Boolean));
  for (const n of Object.values(state.stars)) {
    if (n.end && !added.has(n.id)) (byDate[n.end] ||= []).push({ title: "[마감] " + n.title, kind: "deadline", notice: true, url: n.url });
  }

  let html = ["일", "월", "화", "수", "목", "금", "토"].map((d) => `<div class="dow">${d}</div>`).join("");
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const ds = ymd(d);
    const evs = (byDate[ds] || []).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    const cls = ["cell", d.getMonth() !== month && "other", ds === today && "today", ds === state.cal.selected && "selected", d.getDay() === 0 && "sun"].filter(Boolean).join(" ");
    html += `<div class="${cls}" data-date="${ds}"><span class="num">${d.getDate()}</span>` +
      evs.slice(0, 3).map((e) => `<div class="ev" ${e.id ? `data-ev="${e.id}"` : ""} style="background:${KIND_COLOR[e.kind]}" title="${esc(e.title)}">${esc((e.time ? e.time + " " : "") + e.title)}</div>`).join("") +
      (evs.length > 3 ? `<div class="more">+${evs.length - 3}</div>` : "") + `</div>`;
  }
  $("#calGrid").innerHTML = html;
  renderDay();
}

function renderDay() {
  const ds = state.cal.selected;
  const [y, m, d] = ds.split("-").map(Number);
  const label = new Date(y, m - 1, d).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
  $("#dayTitle").textContent = (ds === todayStr() ? "오늘 · " : "") + label;
  const evs = state.events.filter((e) => e.date === ds).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  const added = new Set(state.events.map((e) => e.noticeId).filter(Boolean));
  const deadlines = Object.values(state.stars).filter((n) => n.end === ds && !added.has(n.id));
  $("#dayEvents").innerHTML =
    evs.map((e) => `<li><span class="dot k-${e.kind}"></span><span>${esc(e.time || "종일")}</span><a href="#" class="grow" data-edit="${e.id}">${esc(e.title)}</a><span class="badge">${KINDS[e.kind]}</span></li>`).join("") +
    deadlines.map((n) => `<li><span class="dot k-deadline"></span><a class="grow" href="${esc(safeUrl(n.url))}" target="_blank" rel="noopener">[마감] ${esc(n.title)}</a></li>`).join("") ||
    `<li class="empty">일정이 없습니다.</li>`;
}

function selectDate(ds) {
  state.cal.selected = ds;
  resetEventForm();
  renderCalendar();
}

function resetEventForm() {
  const f = $("#eventForm");
  f.reset();
  f.id.value = "";
  f.date.value = compact(state.cal.selected || todayStr());
  $("#eventDelete").hidden = true;
  $("#formTitle").textContent = "일정 추가";
}

// 날짜를 누르면 그 날을 고르고, 일정 칸을 누르면 수정 팝업, + 를 누르면 고른 날에 추가 팝업.
$("#calGrid").addEventListener("click", (e) => {
  const cell = e.target.closest(".cell");
  if (!cell) return;
  const evId = e.target.closest(".ev")?.dataset.ev;
  selectDate(cell.dataset.date);
  if (evId) openEventDialog(evId);
});
$("#calAdd").addEventListener("click", () => openEventDialog());

function openEventDialog(editId) {
  resetEventForm();
  renderDay();
  if (editId) editEvent(editId);
  const dlg = $("#eventDialog");
  if (!dlg.open) dlg.showModal ? dlg.showModal() : dlg.setAttribute("open", "");
  if (!editId) $("#eventForm").title.focus();
}
function closeEventDialog() {
  const dlg = $("#eventDialog");
  if (dlg.open) dlg.close ? dlg.close() : dlg.removeAttribute("open");
}
$("#dialogClose").addEventListener("click", closeEventDialog);
$("#eventDialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeEventDialog(); });
$("#calPrev").addEventListener("click", () => moveMonth(-1));
$("#calNext").addEventListener("click", () => moveMonth(1));
$("#calToday").addEventListener("click", () => {
  const t = new Date();
  state.cal.year = t.getFullYear(); state.cal.month = t.getMonth();
  selectDate(todayStr());
});
function moveMonth(delta) {
  const d = new Date(state.cal.year, state.cal.month + delta, 1);
  state.cal.year = d.getFullYear(); state.cal.month = d.getMonth();
  renderCalendar();
}

$("#dayEvents").addEventListener("click", (e) => {
  const id = e.target.dataset.edit;
  if (!id) return;
  e.preventDefault();
  editEvent(id);
});
function editEvent(id) {
  const ev = state.events.find((x) => x.id === id);
  if (!ev) return;
  const f = $("#eventForm");
  for (const k of ["id", "title", "date", "time", "kind", "memo"]) f[k].value = ev[k] || "";
  f.date.value = compact(ev.date);
  $("#eventDelete").hidden = false;
  $("#formTitle").textContent = "일정 수정";
  f.title.focus();
}

$("#eventForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  const date = readYmd(f.date, true);
  if (date === undefined) return;
  const data = { title: f.title.value.trim(), date, time: f.time.value, kind: f.kind.value, memo: f.memo.value.trim() };
  if (f.id.value) Object.assign(state.events.find((x) => x.id === f.id.value), data);
  else state.events.push({ id: uid(), ...data });
  store.set("events", state.events);
  state.cal.selected = data.date;
  const [y, m] = data.date.split("-").map(Number);
  state.cal.year = y; state.cal.month = m - 1;
  resetEventForm();
  closeEventDialog();
  renderAll();
});
$("#eventDelete").addEventListener("click", () => {
  const id = $("#eventForm").id.value;
  if (!id || !confirm("이 일정을 삭제할까요?")) return;
  state.events = state.events.filter((x) => x.id !== id);
  store.set("events", state.events);
  resetEventForm();
  closeEventDialog();
  renderAll();
});
$("#eventReset").addEventListener("click", resetEventForm);

// ---------------------------------------------------------------- 사업공고

async function loadNotices() {
  try {
    const res = await fetch("data/notices.json", { cache: "no-store" });
    const data = await res.json();
    state.notices = data.items || [];
    state.noticeMeta = data;
  } catch (err) {
    state.notices = [];
    state.noticeMeta = { error: String(err) };
  }
  const sources = [...new Set(state.notices.map((n) => n.source))];
  $("#nSource").innerHTML = `<option value="">전체 출처</option>` + sources.map((s) => `<option>${esc(s)}</option>`).join("");
  // 관심공고 사본을 최신 정보로 갱신
  for (const n of state.notices) if (state.stars[n.id]) state.stars[n.id] = n;
  store.set("stars", state.stars);
  renderAll();
}

function renderNotices() {
  syncKindToggle();
  const q = $("#nSearch").value.trim().toLowerCase();
  const src = $("#nSource").value;
  const region = $("#nRegion").value;
  const kind = state.kind;
  store.set("region", region);
  const filter = $("#nFilter").value;
  const sort = $("#nSort").value;

  let list = filter === "star" ? Object.values(state.stars) : state.notices.slice();
  if (src) list = list.filter((n) => n.source === src || (n.also || []).includes(src));
  if (kind) list = list.filter((n) => (n.kind || "지원사업") === kind);
  // 지역을 고르면 그 지역 공고와 전국 공고를 함께 보여준다
  if (region) list = list.filter((n) => !(n.regions && n.regions.length) || n.regions.includes(region));
  if (q) list = list.filter((n) => [n.title, n.org, n.category, n.summary, n.target].join(" ").toLowerCase().includes(q));
  if (filter === "open") list = list.filter((n) => { const d = daysUntil(n.end); return d == null || d >= 0; });
  if (filter === "matched") list = list.filter((n) => n.matched && n.matched.length);
  if (filter === "new") list = list.filter(isNew);
  if (filter === "memo") {
    list = Object.entries(state.noticeMemos).map(([id, m]) =>
      findNotice(id) || { id, title: m.title, url: m.url, end: m.end, kind: m.kind, source: "", regions: [] });
  }
  // 해시태그: 지금 조건에서 태그별 개수를 보여 주고, 고른 태그 중 하나라도 붙은 공고만 남긴다
  renderTagFilter(list);
  if (state.nTags.size) list = list.filter((n) => (n.matched || []).some((k) => state.nTags.has(k)));
  if (sort === "deadline") list.sort((a, b) => (a.end || "9999").localeCompare(b.end || "9999"));
  else list.sort(byNewest);

  // 한 번에 다 그리지 않고 10·30·50개씩 끊어서 보여준다
  const total = list.length;
  const per = Number($("#nPer").value) || 10;
  const pages = Math.max(1, Math.ceil(total / per));
  state.nPage = Math.min(Math.max(1, state.nPage || 1), pages);
  const from = (state.nPage - 1) * per;
  list = list.slice(from, from + per);

  const m = state.noticeMeta;
  const updated = m.updated_at ? new Date(m.updated_at).toLocaleString("ko-KR") : "-";
  $("#nMeta").innerHTML = `${total}건` + (total > per ? ` 중 ${from + 1}–${from + list.length}` : "") + ` · 마지막 수집 ${esc(updated)}` +
    (m.sample ? ` · <b>샘플 데이터입니다</b> (API 키 설정 후 실제 공고로 바뀝니다)` : "") +
    (m.error ? ` · 공고 파일을 읽지 못했습니다` : "") +
    (m.errors && m.errors.length ? ` · 수집 오류 ${m.errors.length}건` : "");

  $("#nList").innerHTML = list.length ? list.map(noticeCardHTML).join("") : `<p class="meta">조건에 맞는 공고가 없습니다.</p>`;
  renderPager(pages);
}

// 공고 한 건 (사업공고 · 공공조달 탭이 함께 쓴다). 긴 소개 문단은 빼고 대상·문의까지만 보여준다.
function noticeCardHTML(n) {
  const rnd = (n.kind || "지원사업") === "연구과제";
  const d = daysUntil(n.end);
  const lv = d == null ? "open" : d < 0 ? "closed" : d <= 3 ? "urgent" : d <= 7 ? "soon" : "calm";
  const big = d == null ? "상시" : d < 0 ? "마감" : d === 0 ? "D-Day" : `D-${d}`;
  const md = (x) => (x ? x.slice(5).replace("-", ".") : "?");
  const facts = [["기관", n.org], ["지역", n.regions && n.regions.length ? n.regions.join(", ") : "전국"],
    ["대상", n.target], ["업력", n.age], ["공고금액", n.budget], ["문의", n.contact]].filter(([, v]) => v);
  return `
    <article class="notice nc ${rnd ? "is-rnd" : "is-support"}">
      <div class="nc-band">
        ${kindBadge(n)}
        <span class="nc-src">${esc([n.source, ...(n.also || [])].join(" · "))}${n.category ? " · " + esc(n.category) : ""}</span>
        ${(n.proc || []).map((t) => `<span class="badge proc">${esc(t)}</span>`).join("")}
        ${isNew(n) ? `<span class="badge new">NEW</span>` : ""}
        <span class="grow"></span>
        <button class="star ${state.stars[n.id] ? "on" : ""}" data-star="${esc(n.id)}" title="관심공고" aria-pressed="${!!state.stars[n.id]}">${STAR_SVG}</button>
      </div>
      <div class="nc-body">
        <div class="nc-d ${lv}"><b>${big}</b><small>${n.end ? md(n.end) + " 마감" : "기한 없음"}</small></div>
        <div class="nc-main">
          <div class="title"><a href="${esc(safeUrl(n.url))}" target="_blank" rel="noopener">${esc(n.title)}</a></div>
          <dl class="nc-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
          ${noticeMemoHTML(n)}
        </div>
      </div>
      <div class="nc-foot">
        <span>등록 ${md(regDate(n))}</span><span>접수 ${md(n.start)} ~ ${md(n.end)}</span>
        ${(n.matched || []).map((k) => `<button type="button" class="nc-hash${state.nTags.has(k) ? " on" : ""}" data-tag="${esc(k)}" title="#${esc(k)} 공고만 보기">#${esc(k)}</button>`).join("")}
        <span class="grow"></span>
        <button class="ghost" data-memo="${esc(n.id)}">${state.noticeMemos[n.id] ? "메모 수정" : "메모 추가"}</button>
      </div>
    </article>`;
}

// 페이지 번호: 처음 · 이전 · (지금 페이지 앞뒤 2쪽) · 다음 · 끝
function renderPager(pages, el = "#nPager", cur = state.nPage) {
  if (pages <= 1) { $(el).innerHTML = ""; return; }
  const nums = [];
  for (let i = Math.max(1, cur - 2); i <= Math.min(pages, cur + 2); i++) nums.push(i);
  const btn = (p, label, extra = "") =>
    `<button type="button" data-page="${p}" ${extra}>${label}</button>`;
  $(el).innerHTML =
    btn(1, "«", cur === 1 ? "disabled aria-label=\"처음\"" : "aria-label=\"처음\"") +
    btn(cur - 1, "이전", cur === 1 ? "disabled" : "") +
    (nums[0] > 1 ? `<span class="gap">…</span>` : "") +
    nums.map((p) => btn(p, p, p === cur ? `class="on" aria-current="page"` : "")).join("") +
    (nums[nums.length - 1] < pages ? `<span class="gap">…</span>` : "") +
    btn(cur + 1, "다음", cur === pages ? "disabled" : "") +
    btn(pages, "»", cur === pages ? "disabled aria-label=\"끝\"" : "aria-label=\"끝\"");
}
$("#nPager").addEventListener("click", (e) => {
  const b = e.target.closest("[data-page]");
  if (!b || b.disabled) return;
  state.nPage = Number(b.dataset.page);
  renderNotices();
  $("#nKind").scrollIntoView({ behavior: "smooth", block: "start" });
});

$("#nRegion").value = store.get("region", "");
$("#nPer").value = String(store.get("nPer", 10));
$("#nPer").addEventListener("input", () => store.set("nPer", Number($("#nPer").value)));
// 조건을 바꾸면 첫 페이지로
["#nSearch", "#nSource", "#nRegion", "#nFilter", "#nSort", "#nPer"].forEach((s) =>
  $(s).addEventListener("input", () => { state.nPage = 1; renderNotices(); }));

// 해시태그 필터 (#수출 등). 여러 개 고르면 그중 하나라도 붙은 공고
function renderTagFilter(list) {
  const cnt = {};
  for (const n of state.notices) for (const k of n.matched || []) cnt[k] ||= 0;
  for (const n of list) for (const k of n.matched || []) cnt[k] = (cnt[k] || 0) + 1;
  const tags = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || a.localeCompare(b));
  $("#nTags").hidden = !tags.length;
  $("#nTags").innerHTML = tags.length ? `<button type="button" class="${state.nTags.size ? "" : "on"}" data-tag="">전체</button>` +
    tags.map((k) => `<button type="button" class="${state.nTags.has(k) ? "on" : ""}" data-tag="${esc(k)}" aria-pressed="${state.nTags.has(k)}">#${esc(k)} <span class="cnt">${cnt[k]}</span></button>`).join("") : "";
}
function toggleTag(k) {
  if (!k) state.nTags.clear();
  else if (state.nTags.has(k)) state.nTags.delete(k);
  else state.nTags.add(k);
  store.set("nTags", [...state.nTags]);
  state.nPage = 1;
  renderNotices();
}
$("#nTags").addEventListener("click", (e) => { const b = e.target.closest("[data-tag]"); if (b) toggleTag(b.dataset.tag); });
$("#nList").addEventListener("click", (e) => {
  const b = e.target.closest(".nc-hash[data-tag]");
  if (!b) return;
  toggleTag(b.dataset.tag);
  $("#nTags").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

function kindBadge(n) {
  const k = n.kind || "지원사업";
  return `<span class="badge ${k === "연구과제" ? "kind-rnd" : "kind-support"}">${esc(k)}</span>`;
}

state.kind = store.get("kind", "");
function syncKindToggle() {
  const open = state.notices.filter((n) => { const d = daysUntil(n.end); return d == null || d >= 0; });
  document.querySelectorAll("#nKind button").forEach((b) => {
    b.classList.toggle("on", b.dataset.kind === state.kind);
    b.setAttribute("aria-selected", b.dataset.kind === state.kind);
  });
  document.querySelectorAll("#nKind .cnt").forEach((c) => {
    const k = c.dataset.cnt;
    c.textContent = open.filter((n) => !k || (n.kind || "지원사업") === k).length;
  });
}
$("#nKind").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.kind = b.dataset.kind;
  state.nPage = 1;
  store.set("kind", state.kind);
  syncKindToggle();
  renderNotices();
});

// 공고마다 남기는 메모. 쓰는 중에는 입력칸, 저장하면 공고 아래에 메모 상자로 보인다.
function noticeMemoHTML(n) {
  const m = state.noticeMemos[n.id];
  if (state.editingMemo === n.id) {
    return `<div class="nmemo-edit">
      <textarea class="nmemo-text" rows="3" placeholder="이 공고에 대한 메모 (준비할 서류, 담당자, 지원 여부 등)">${esc(m?.text || "")}</textarea>
      <div class="row">
        <button type="button" data-memo-save="${esc(n.id)}">저장</button>
        <button type="button" class="ghost" data-memo-cancel>취소</button>
        ${m ? `<button type="button" class="ghost" data-memo-del="${esc(n.id)}">메모 삭제</button>` : ""}
      </div>
    </div>`;
  }
  if (!m) return "";
  const when = new Date(m.updated).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
  return `<div class="nmemo"><span class="nmemo-label">메모 · ${esc(when)}</span><p>${esc(m.text)}</p></div>`;
}

function findNotice(id) {
  return state.notices.find((n) => n.id === id) || state.stars[id];
}

function onNoticeListClick(e) {
  const box = e.currentTarget;
  const starId = e.target.closest("[data-star]")?.dataset.star;
  if (starId) {
    if (state.stars[starId]) delete state.stars[starId];
    else state.stars[starId] = findNotice(starId);
    store.set("stars", state.stars);
    renderAll();
    return;
  }
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.memo) {
    state.editingMemo = b.dataset.memo;
    renderNotices(); renderProc();
    const ta = box.querySelector(".nmemo-text");
    ta?.focus();
    ta?.setSelectionRange(ta.value.length, ta.value.length);
  } else if ("memoCancel" in b.dataset) {
    state.editingMemo = null;
    renderNotices();
  } else if (b.dataset.memoSave) {
    const id = b.dataset.memoSave, text = box.querySelector(".nmemo-text").value.trim();
    if (text) {
      const n = findNotice(id) || {};
      state.noticeMemos[id] = { text, updated: new Date().toISOString(), title: n.title, url: n.url, end: n.end, kind: n.kind };
    } else {
      delete state.noticeMemos[id];
    }
    store.set("noticeMemos", state.noticeMemos);
    state.editingMemo = null;
    renderNotices();
  } else if (b.dataset.memoDel) {
    delete state.noticeMemos[b.dataset.memoDel];
    store.set("noticeMemos", state.noticeMemos);
    state.editingMemo = null;
    renderNotices();
  }
  renderProc();
}
$("#nList").addEventListener("click", onNoticeListClick);
$("#pList").addEventListener("click", onNoticeListClick);

// ---------------------------------------------------------------- 공공조달
// 매일 모은 공고 가운데 조달 관련(우수제품·혁신제품·성능인증·NET·NEP·녹색인증·GS인증·조달청/공공구매)만 모은다.
// 분류는 수집기(crawler/crawl.py 의 PROC_RULES)가 제목을 보고 붙인 n.proc 를 쓴다.
const PROC_TAGS = ["우수제품", "혁신제품", "성능인증", "NET·NEP", "녹색인증", "GS인증", "조달·공공구매"];
state.pTag = "";
function renderProc() {
  const all = state.notices.filter((n) => n.proc && n.proc.length);
  const openOnly = $("#pFilter").value === "open";
  const pool = openOnly ? all.filter((n) => { const d = daysUntil(n.end); return d == null || d >= 0; }) : all;
  $("#pTags").innerHTML = [["", "전체", pool.length]].concat(PROC_TAGS.map((t) => [t, t, pool.filter((n) => n.proc.includes(t)).length]))
    .map(([v, label, c]) => `<button type="button" data-ptag="${esc(v)}" class="${state.pTag === v ? "on" : ""}" ${c || !v ? "" : "disabled"}>${esc(label)} <span class="cnt">${c}</span></button>`).join("");
  const q = $("#pSearch").value.trim().toLowerCase();
  let list = pool.filter((n) => !state.pTag || n.proc.includes(state.pTag));
  if (q) list = list.filter((n) => [n.title, n.org, n.category].join(" ").toLowerCase().includes(q));
  if ($("#pSort").value === "deadline") list.sort((a, b) => (a.end || "9999").localeCompare(b.end || "9999"));
  else list.sort(byNewest);
  const total = list.length, per = Number($("#pPer").value) || 10;
  const pages = Math.max(1, Math.ceil(total / per));
  state.pPage = Math.min(Math.max(1, state.pPage || 1), pages);
  const from = (state.pPage - 1) * per;
  list = list.slice(from, from + per);
  $("#pMeta").textContent = `${total}건` + (total > per ? ` 중 ${from + 1}–${from + list.length}` : "");
  $("#pList").innerHTML = list.length ? list.map(noticeCardHTML).join("")
    : `<p class="meta">조건에 맞는 공고가 없습니다. 조달 관련 공고는 매일 아침 수집 때 함께 모입니다.</p>`;
  renderPager(pages, "#pPager", state.pPage);
}
$("#pTags").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ptag]");
  if (!b || b.disabled) return;
  state.pTag = b.dataset.ptag; state.pPage = 1; renderProc();
});
["#pSearch", "#pFilter", "#pSort", "#pPer"].forEach((s) =>
  $(s).addEventListener("input", () => { state.pPage = 1; renderProc(); }));
$("#pPager").addEventListener("click", (e) => {
  const b = e.target.closest("[data-page]");
  if (!b || b.disabled) return;
  state.pPage = Number(b.dataset.page); renderProc();
  $("#tab-proc").scrollIntoView({ behavior: "smooth", block: "start" });
});

// ---------------------------------------------------------------- 진행 중인 업무
// 진행률은 -/+ 버튼으로 10%씩. 100% 가 되면 완료로 표시하고 목록 아래로 내린다.

// 업무에 연결된 할 일이 있으면 진행률은 (완료한 할 일 / 전체) 로 자동 계산, 없으면 −/+ 로 직접 조절.
function workTodos(w) { return state.todos.filter((t) => t.workId === w.id); }
function workProgress(w) {
  const ts = workTodos(w);
  if (!ts.length) return w.progress || 0;
  return Math.round((ts.filter(isDone).length / ts.length) * 100);
}
const workName = (id) => state.works.find((w) => w.id === id)?.title;

// ★ 표시한 업무가 위로. 정렬: 진행 중 먼저 → ★ → 마감 빠른 순 → 추가한 순.
state.works.forEach((w, i) => { w.starred ??= w.priority === 1; w.order ??= i; });

function sortedWorks() {
  return state.works.slice().sort((a, b) =>
    (workProgress(a) >= 100) - (workProgress(b) >= 100) || (b.starred ? 1 : 0) - (a.starred ? 1 : 0)
    || (a.due || "9999").localeCompare(b.due || "9999") || a.order - b.order);
}

function renderWorks() {
  const list = sortedWorks();
  const active = state.works.filter((w) => workProgress(w) < 100).length;
  $("#workCount").textContent = state.works.length ? `(${active}건 진행 중)` : "";
  $("#workList").innerHTML = list.length ? list.map((w) => {
    const pr = workProgress(w), done = pr >= 100, ts = workTodos(w), auto = ts.length > 0;
    return `
    <li class="work ${done ? "done" : ""}">
      <div class="work-top">
        <button class="star work-star ${w.starred ? "on" : ""}" data-work-star="${w.id}" title="중요 표시 (위로 올리기)" aria-pressed="${!!w.starred}">${STAR_SVG}</button>
        <span class="grow">${esc(w.title)}</span>
        ${w.due ? (done ? `<span class="meta due">${esc(w.due.replace(/-/g, "."))}</span>` : ddayBadge(w.due)) : ""}
        <button class="icon" data-work-del="${w.id}" title="업무 삭제">×</button>
      </div>
      <div class="work-bar">
        <div class="bar" role="progressbar" aria-valuenow="${pr}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pr}%"></i></div>
        <span class="pct">${done ? "완료" : pr + "%"}</span>
        ${auto
          ? `<span class="work-count">할 일 ${ts.filter(isDone).length}/${ts.length}</span>`
          : `<button class="step" data-work-step="-10" data-id="${w.id}" aria-label="진행률 낮추기" ${pr <= 0 ? "disabled" : ""}>−</button>
             <button class="step" data-work-step="10" data-id="${w.id}" aria-label="진행률 올리기" ${done ? "disabled" : ""}>+</button>`}
      </div>
      <ul class="work-todos">
        ${ts.map((t) => `
          <li class="todo ${isDone(t) ? "done" : ""}">
            <input type="checkbox" data-todo="${t.id}" ${isDone(t) ? "checked" : ""} aria-label="완료">
            ${t.daily ? `<span class="daily-chip" title="매일 하는 일">매일</span>` : ""}
            ${t.due && !isDone(t) ? ddayBadge(t.due) : ""}
            <span class="grow">${esc(t.text)}</span>
            <button class="icon" data-work-todo-del="${t.id}" title="이 업무에서 할 일 삭제">×</button>
          </li>`).join("")}
      </ul>
      <form class="work-todo-form" data-work="${w.id}">
        <input name="text" placeholder="+ 이 업무에 할 일 추가" aria-label="${esc(w.title)}에 할 일 추가" required>
      </form>
    </li>`;
  }).join("") : `<li class="empty">진행 중인 업무를 추가해 보세요.</li>`;

  // 할 일 입력칸의 업무 선택 목록도 맞춘다 (고른 값은 유지)
  const opts = `<option value="">업무 없음</option>` +
    state.works.filter((w) => workProgress(w) < 100).map((w) => `<option value="${w.id}">${esc(w.title)}</option>`).join("");
  document.querySelectorAll(".work-select").forEach((sel) => {
    const v = sel.value;
    sel.innerHTML = opts;
    sel.value = state.works.some((w) => w.id === v) ? v : "";
  });
}

$("#workForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  const due = readYmd(f.due, false);
  if (due === undefined) return;
  const order = Math.max(0, ...state.works.map((w) => w.order + 1));
  state.works.push({ id: uid(), title: f.title.value.trim(), due, progress: 0, starred: false, order });
  store.set("works", state.works);
  f.title.value = ""; f.due.value = "";
  renderWorks();
  f.title.focus();
});
$("#workList").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.workTodoDel) {
    // 업무 안에서 지우면 할 일 자체를 지운다
    state.todos = state.todos.filter((t) => t.id !== b.dataset.workTodoDel);
    store.set("todos", state.todos);
    renderAll();
    return;
  }
  if (b.dataset.workDel) {
    const id = b.dataset.workDel;
    state.works = state.works.filter((w) => w.id !== id);
    // 업무를 지워도 할 일은 남기고 연결만 끊는다 (할 일 목록에서 이미 지운 것만 같이 지운다)
    state.todos = state.todos.filter((t) => !(t.workId === id && t.offHome));
    for (const t of state.todos) if (t.workId === id) delete t.workId;
    store.set("todos", state.todos);
  } else if (b.dataset.workStar) {
    const w = state.works.find((x) => x.id === b.dataset.workStar);
    if (w) w.starred = !w.starred;
  } else if (b.dataset.workStep) {
    const w = state.works.find((x) => x.id === b.dataset.id);
    if (w) w.progress = Math.max(0, Math.min(100, w.progress + Number(b.dataset.workStep)));
  } else return;
  store.set("works", state.works);
  renderAll();
});
$("#workList").addEventListener("change", (e) => {
  if (e.target.dataset.todo) toggleTodo(e.target.dataset.todo);
});
$("#workList").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target.closest(".work-todo-form");
  const text = f.text.value.trim();
  if (!text) return;
  state.todos.push({ id: uid(), text, due: "", done: false, workId: f.dataset.work });
  store.set("todos", state.todos);
  renderAll();
  $(`.work-todo-form[data-work="${f.dataset.work}"] input`)?.focus();
});

// ---------------------------------------------------------------- 할 일 / 메모

// 체크해도 지우지 않고 줄만 긋는다. 매일 하는 일이 위, 나머지는 추가한 순서 그대로.
// offHome: 업무에 연결된 할 일을 할 일 목록에서만 지운 것 (업무 쪽에는 남아 있다)
function todoListHTML() {
  const mine = state.todos.filter((t) => !t.offHome);
  const list = mine.filter((t) => t.daily).concat(mine.filter((t) => !t.daily));
  return list.length ? list.map((t) => `
    <li class="todo ${isDone(t) ? "done" : ""}">
      <input type="checkbox" data-todo="${t.id}" ${isDone(t) ? "checked" : ""} aria-label="완료">
      ${t.daily ? `<span class="daily-chip" title="매일 하는 일 · 다음 날 다시 체크할 수 있어요">매일</span>` : ""}
      ${t.due ? (isDone(t) ? `<span class="meta due">${esc(t.due.replace(/-/g, "."))}</span>` : ddayBadge(t.due)) : ""}
      ${t.workId && workName(t.workId) ? `<span class="work-chip" title="연결된 업무">${esc(workName(t.workId))}</span>` : ""}
      <span class="grow">${esc(t.text)}</span>
      <button class="icon" data-todo-del="${t.id}" title="${t.workId && workName(t.workId) ? "할 일 목록에서 빼기 (업무에는 남아요)" : "삭제"}">×</button>
    </li>`).join("") : `<li class="empty">할 일이 없습니다.</li>`;
}

function toggleTodo(id) {
  const t = state.todos.find((x) => x.id === id);
  if (t?.daily) t.doneOn = isDone(t) ? "" : todayStr();
  else if (t) t.done = !t.done;
  store.set("todos", state.todos);
  renderAll();
}

function addTodoFrom(form) {
  const workId = form.work?.value || "";
  const daily = !!form.daily?.checked;
  state.todos.push({ id: uid(), text: form.text.value.trim(), due: "", done: false,
    ...(daily ? { daily: true, doneOn: "" } : {}), ...(workId ? { workId } : {}) });
  store.set("todos", state.todos);
  form.text.value = "";   // 고른 업무·'매일'은 이어서 쓰도록 남겨 둔다
  renderAll();
  form.text.focus();
}

for (const sel of ["#homeTodoForm"]) {
  $(sel).addEventListener("submit", (e) => { e.preventDefault(); addTodoFrom(e.target); });
}
for (const sel of ["#homeTodo"]) {
  $(sel).addEventListener("click", (e) => {
    if (e.target.dataset.todo) toggleTodo(e.target.dataset.todo);
    if (e.target.dataset.todoDel) {
      // 업무에 연결된 할 일은 할 일 목록에서만 빼고 업무에는 남긴다 (#9)
      const t = state.todos.find((x) => x.id === e.target.dataset.todoDel);
      if (t?.workId && workName(t.workId)) t.offHome = true;
      else state.todos = state.todos.filter((x) => x.id !== e.target.dataset.todoDel);
      store.set("todos", state.todos);
      renderAll();
    }
  });
}

// ---------------------------------------------------------------- 메모 (포스트잇)
// 쓰는 동안에는 다시 그리지 않고(커서 유지) 저장만, 추가·삭제·색 변경 때만 보드를 다시 그린다.

const NOTE_COLORS = ["yellow", "peach", "pink", "mint", "sky", "lavender"];
const NOTE_COLOR_NAMES = { yellow: "노랑", peach: "살구", pink: "분홍", mint: "민트", sky: "하늘", lavender: "라벤더" };
if (!Array.isArray(state.notes)) {
  state.notes = state.memo.trim() ? [{ id: uid(), text: state.memo, color: "yellow", updated: new Date().toISOString() }] : [];
  store.set("notes", state.notes);
}
let newNoteColor = store.get("noteColor", "yellow");

function noteTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderNoteColors() {
  $("#newNoteColors").innerHTML = NOTE_COLORS.map((c) =>
    `<button type="button" class="swatch n-${c} ${c === newNoteColor ? "on" : ""}" data-new-color="${c}" role="radio" aria-checked="${c === newNoteColor}" title="${NOTE_COLOR_NAMES[c]}"></button>`).join("");
}

function renderNotes() {
  const q = $("#noteSearch").value.trim().toLowerCase();
  const list = q ? state.notes.filter((n) => n.text.toLowerCase().includes(q)) : state.notes;
  $("#noteCount").textContent = !state.notes.length ? "" : q ? `(${state.notes.length}개 중 ${list.length}개)` : `(${state.notes.length}개)`;
  if (state.notes.length && !list.length) {
    $("#noteBoard").innerHTML = `<p class="meta note-empty">"${esc(q)}" 검색 결과가 없어요.</p>`;
    return;
  }
  $("#noteBoard").innerHTML = list.length ? list.map((n) => `
    <div class="note n-${n.color}" data-note="${n.id}">
      <div class="note-tools">
        <span class="note-swatches">${NOTE_COLORS.map((c) =>
          `<button type="button" class="swatch mini n-${c} ${c === n.color ? "on" : ""}" data-note-color="${c}" title="${NOTE_COLOR_NAMES[c]}"></button>`).join("")}</span>
        <span class="note-acts"><button type="button" class="note-big" data-note-open title="크게 보기 (메모를 두 번 눌러도 돼요)" aria-label="메모 크게 보기">⤢</button><button type="button" class="note-del" data-note-del title="메모 삭제">×</button></span>
      </div>
      <textarea class="note-text" placeholder="여기에 적으세요 · 두 번 누르면 크게" aria-label="메모 내용">${esc(n.text)}</textarea>
      <div class="note-time">${esc(noteTime(n.updated))}</div>
    </div>`).join("") : `<p class="meta note-empty">아직 메모가 없어요. <b>+ 새 메모</b>를 눌러 시작해 보세요.</p>`;
}

function saveNotes() { store.set("notes", state.notes); }

$("#noteSearch").addEventListener("input", renderNotes);

$("#addNote").addEventListener("click", () => {
  $("#noteSearch").value = "";   // 새 메모가 바로 보이도록 검색을 비운다
  const n = { id: uid(), text: "", color: newNoteColor, updated: new Date().toISOString() };
  state.notes.unshift(n);
  saveNotes();
  renderNotes();
  $("#noteBoard .note-text")?.focus();
});
$("#newNoteColors").addEventListener("click", (e) => {
  const c = e.target.dataset.newColor;
  if (!c) return;
  newNoteColor = c;
  store.set("noteColor", c);
  renderNoteColors();
});

// 보드에서 한 번 누르면 그 자리에서 고치고, 두 번 누르면(또는 ⤢) 큰 창으로 연다. 쓰는 동안 0.4초 모아서 저장.
const noteTimers = {};
$("#noteBoard").addEventListener("input", (e) => {
  if (!e.target.classList.contains("note-text")) return;
  const el = e.target.closest(".note");
  const n = state.notes.find((x) => x.id === el.dataset.note);
  if (!n) return;
  n.text = e.target.value;
  n.updated = new Date().toISOString();
  clearTimeout(noteTimers[n.id]);
  noteTimers[n.id] = setTimeout(() => {
    saveNotes();
    el.querySelector(".note-time").textContent = "저장됨 · " + noteTime(n.updated);
  }, 400);
});
$("#noteBoard").addEventListener("dblclick", (e) => {
  if (!e.target.classList.contains("note-text")) return;
  const id = e.target.closest(".note").dataset.note;
  clearTimeout(noteTimers[id]);
  saveNotes();
  openNote(id);
});
let openNoteId = null;
function openNote(id) {
  const n = state.notes.find((x) => x.id === id);
  if (!n) return;
  openNoteId = id;
  const dlg = $("#noteDialog");
  dlg.querySelector(".note").className = `note big n-${n.color}`;
  $("#noteBig").value = n.text;
  $("#noteBigTime").textContent = noteTime(n.updated);
  dlg.showModal();
  const ta = $("#noteBig");
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}
$("#noteBig").addEventListener("input", () => {
  const n = state.notes.find((x) => x.id === openNoteId);
  if (!n) return;
  n.text = $("#noteBig").value;
  n.updated = new Date().toISOString();
  clearTimeout(noteTimers[n.id]);
  noteTimers[n.id] = setTimeout(() => {
    saveNotes();
    $("#noteBigTime").textContent = "저장됨 · " + noteTime(n.updated);
  }, 400);
});
$("#noteDialog").addEventListener("close", () => {
  const n = state.notes.find((x) => x.id === openNoteId);
  if (n) { clearTimeout(noteTimers[n.id]); saveNotes(); }
  openNoteId = null;
  renderNotes();
});
$("#noteBigClose").addEventListener("click", () => $("#noteDialog").close());
$("#noteDialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });   // 바깥 누르면 닫기
$("#noteBoard").addEventListener("click", (e) => {
  const el = e.target.closest(".note");
  if (!el) return;
  const n = state.notes.find((x) => x.id === el.dataset.note);
  if (!n) return;
  if (e.target.closest("[data-note-open]")) { openNote(n.id); return; }
  if (e.target.dataset.noteColor) {
    n.color = e.target.dataset.noteColor;
    saveNotes();
    renderNotes();
  } else if ("noteDel" in e.target.dataset) {
    // 한 번 누르면 "삭제?"로 바뀌고, 3초 안에 다시 누르면 지운다
    const btn = e.target;
    if (!btn.classList.contains("arm")) {
      btn.classList.add("arm");
      btn.textContent = "삭제?";
      setTimeout(() => { if (btn.isConnected) { btn.classList.remove("arm"); btn.textContent = "×"; } }, 3000);
      return;
    }
    state.notes = state.notes.filter((x) => x.id !== n.id);
    saveNotes();
    renderNotes();
  }
});

// ---------------------------------------------------------------- Claude 검색창
// claude.ai 아티팩트로 열면 페이지 안에서 바로 답하고 일정·할 일도 추가한다.
// 그 밖의 곳(GitHub Pages 등)에서는 질문을 담아 claude.ai 새 대화를 연다.

let sampleFn = null;
let askCtl = null;
if (window.claude?.use) window.claude.use("sample").then((fn) => { sampleFn = fn; }).catch(() => {});

function pageContext() {
  const today = todayStr();
  const soon = state.events
    .filter((e) => { const d = daysUntil(e.date); return d != null && d >= -1 && d <= 30; })
    .sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")))
    .map((e) => `- ${e.date} ${e.time || "종일"} [${KINDS[e.kind]}] ${e.title}`);
  const todos = state.todos.filter((t) => !isDone(t)).map((t) => `- ${t.text}${t.daily ? " (매일)" : ""}${t.due ? " (기한 " + t.due + ")" : ""}${t.workId && workName(t.workId) ? " [업무: " + workName(t.workId) + "]" : ""}`);
  const notices = state.notices
    .filter((n) => { const d = daysUntil(n.end); return d == null || d >= 0; })
    .slice(0, 60)
    .map((n) => `- [${n.id}] ${n.title} | ${n.org || ""} | ${n.kind || "지원사업"} | 지역 ${(n.regions || []).join(",") || "전국"} | 대상 ${n.target || "-"} | 접수 ${n.start || "?"}~${n.end || "?"}${state.stars[n.id] ? " | ★관심" : ""}`);
  const works = sortedWorks().filter((w) => workProgress(w) < 100).map((w) => `- ${w.starred ? "★ " : ""}${w.title} (진행률 ${workProgress(w)}%${w.due ? ", 마감 " + w.due : ""})`);
  const notes = state.notes.filter((n) => n.text.trim()).slice(0, 20).map((n) => `- ${n.text.trim().replace(/\s+/g, " ").slice(0, 200)}`);
  return `오늘: ${today} (${new Date().toLocaleDateString("ko-KR", { weekday: "long" })})

[앞으로 30일 일정]
${soon.join("\n") || "(없음)"}

[진행 중인 업무]
${works.join("\n") || "(없음)"}

[메모]
${notes.join("\n") || "(없음)"}

[남은 할 일]
${todos.join("\n") || "(없음)"}

[접수중인 사업공고]
${notices.join("\n") || "(없음)"}`;
}

const ASK_TOOLS = [
  {
    name: "add_event",
    description: "사용자 달력에 일정을 추가한다. 날짜는 YYYY-MM-DD, 시간은 HH:MM(24시간, 없으면 빈 문자열). 추가된 일정을 돌려준다.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        date: { type: "string" },
        time: { type: "string" },
        kind: { type: "string", enum: ["work", "meeting", "deadline", "personal"] },
        memo: { type: "string" },
      },
      required: ["title", "date"],
    },
    execute(input) {
      const date = String(input.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date는 YYYY-MM-DD 형식이어야 합니다");
      const time = /^\d{2}:\d{2}$/.test(String(input.time || "")) ? String(input.time) : "";
      const kind = KINDS[input.kind] ? String(input.kind) : "work";
      const ev = { id: uid(), title: String(input.title).slice(0, 200), date, time, kind, memo: String(input.memo || "") };
      state.events.push(ev);
      store.set("events", state.events);
      const [y, m] = date.split("-").map(Number);
      state.cal = { year: y, month: m - 1, selected: date };
      renderAll();
      return ev;
    },
  },
  {
    name: "add_todo",
    description: "할 일 목록에 항목을 추가한다. due는 YYYY-MM-DD 또는 빈 문자열. 매일 반복하는 일이면 daily=true.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, due: { type: "string" }, daily: { type: "boolean" }, work: { type: "string", description: "연결할 진행 중인 업무 이름 (선택)" } },
      required: ["text"],
    },
    execute(input) {
      const due = /^\d{4}-\d{2}-\d{2}$/.test(String(input.due || "")) ? String(input.due) : "";
      const w = input.work ? state.works.find((x) => x.title.includes(String(input.work)) || String(input.work).includes(x.title)) : null;
      const t = { id: uid(), text: String(input.text).slice(0, 200), due, done: false,
        ...(input.daily ? { daily: true, doneOn: "" } : {}), ...(w ? { workId: w.id } : {}) };
      state.todos.push(t);
      store.set("todos", state.todos);
      renderAll();
      return t;
    },
  },
  {
    name: "star_notice",
    description: "사업공고를 관심공고(★)로 표시한다. 공고 목록의 대괄호 안 id를 넘긴다. 관심공고 마감일은 달력에 표시된다.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute(input) {
      const n = state.notices.find((x) => x.id === String(input.id));
      if (!n) throw new Error("그런 id의 공고가 없습니다");
      state.stars[n.id] = n;
      store.set("stars", state.stars);
      renderAll();
      return { ok: true, title: n.title };
    },
  },
];

const ASK_ERRORS = {
  not_granted: "Claude 사용을 허용하지 않아 답할 수 없습니다.",
  sampling_disabled: "이 계정에서는 Claude를 쓸 수 없습니다.",
  rate_limited: "요청이 많습니다. 잠시 후 다시 물어봐 주세요.",
  session_expired: "claude.ai에 다시 로그인해 주세요.",
  refused: "이 질문에는 답할 수 없습니다. 다르게 물어봐 주세요.",
  prompt_too_large: "보낼 내용이 너무 깁니다.",
};

async function ask(question) {
  if (!sampleFn) {
    const q = `${question}\n\n(참고: 오늘은 ${todayStr()}입니다)`;
    window.open("https://claude.ai/new?q=" + encodeURIComponent(q), "_blank", "noopener");
    return;
  }
  const panel = $("#askPanel"), out = $("#askA"), note = $("#askNote");
  panel.hidden = false;
  $("#askQ").textContent = question;
  out.textContent = "생각하는 중…";
  note.textContent = "";
  $("#askBtn").disabled = true;
  $("#askStop").hidden = false;
  askCtl = new AbortController();
  const canUseTools = !!(await sampleFn.limits().catch(() => null))?.tools;
  const prompt = `너는 사용자의 개인 업무 대시보드 "Sol Works"에 있는 비서야. 아래 페이지 데이터를 보고 한국어로 짧고 바로 쓸 수 있게 답해.
일정이나 할 일을 추가해 달라고 하면 도구를 써서 실제로 추가하고, 무엇을 추가했는지 한 줄로 알려줘.
"다음 주 화요일" 같은 상대 날짜는 오늘 날짜를 기준으로 계산해. 마크다운 표나 제목은 쓰지 말고 평문과 짧은 목록만 써.

${pageContext()}

[질문]
${question}`;
  try {
    const { truncated } = await sampleFn(prompt, {
      signal: askCtl.signal,
      modelTier: "quick",
      ...(canUseTools ? { tools: ASK_TOOLS } : {}),
      onText: ({ text }) => { out.textContent = text; },
    });
    if (truncated) note.textContent = "답이 길어 중간에 끊겼습니다.";
  } catch (e) {
    out.textContent = e?.text ?? "";
    if (e?.code !== "cancelled") {
      note.textContent = ASK_ERRORS[e?.code] || "답을 받지 못했습니다. 다시 시도해 주세요.";
    }
    if (e?.code === "not_granted" || e?.code === "sampling_disabled") sampleFn = null;
  } finally {
    $("#askBtn").disabled = false;
    $("#askStop").hidden = true;
  }
}

$("#askForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#askInput").value.trim();
  if (!q) return;
  $("#askInput").value = "";
  ask(q);
});
$("#askStop").addEventListener("click", () => askCtl?.abort());
$("#askClose").addEventListener("click", () => { askCtl?.abort(); $("#askPanel").hidden = true; });

// ---------------------------------------------------------------- 백업

$("#exportBtn").addEventListener("click", () => {
  const data = { events: state.events, todos: state.todos, works: state.works, stars: state.stars, notes: state.notes };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `SolWorks-백업-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!confirm("현재 데이터를 백업 파일 내용으로 바꿀까요?")) return;
    if (data.notes === undefined && typeof data.memo === "string" && data.memo.trim()) {
      data.notes = [{ id: uid(), text: data.memo, color: "yellow", updated: new Date().toISOString() }];
    }
    for (const k of ["events", "todos", "works", "stars", "notes"]) {
      if (data[k] !== undefined) { state[k] = data[k]; store.set(k, data[k]); }
    }
    renderAll();
  } catch {
    alert("올바른 백업 파일이 아닙니다.");
  }
  e.target.value = "";
});

// ---------------------------------------------------------------- 서울 날씨
// Open-Meteo(키 불필요)에서 바로 받고, 막혀 있으면 매일 수집기가 저장한 data/weather.json 을 쓴다.

const WEATHER_URL = "https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.978"
  + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
  + "&timezone=Asia%2FSeoul&forecast_days=2";

function weatherLabel(code) {
  if (code === 0) return "맑음";
  if (code === 1) return "대체로 맑음";
  if (code === 2) return "구름 조금";
  if (code === 3) return "흐림";
  if (code === 45 || code === 48) return "안개";
  if (code >= 51 && code <= 57) return "이슬비";
  if (code >= 61 && code <= 67) return "비";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "눈";
  if (code >= 80 && code <= 82) return "소나기";
  if (code >= 95) return "뇌우";
  return "-";
}

function weatherIcon(code) {
  if (code === 0) return "☀️";
  if (code === 1) return "🌤️";
  if (code === 2) return "⛅";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️";
  if (code >= 61 && code <= 67) return "🌧️";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "🌨️";
  if (code >= 80 && code <= 82) return "🌦️";
  if (code >= 95) return "⛈️";
  return "🌡️";
}

async function loadWeather() {
  let data = null;
  for (const url of [WEATHER_URL, "data/weather.json"]) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) { data = await res.json(); break; }
    } catch { /* 다음 방법 시도 */ }
  }
  const d = data?.daily;
  const el = $("#weather");
  if (!d?.time?.length) {
    el.innerHTML = `<span class="w-off">날씨를 불러오지 못했어요</span>`;
    el.hidden = false;
    return;
  }
  const today = todayStr();
  const days = d.time.map((t, i) => ({
    t, code: d.weather_code[i], hi: d.temperature_2m_max[i], lo: d.temperature_2m_min[i], pop: d.precipitation_probability_max[i],
  })).filter((x) => x.t >= today).slice(0, 1);
  if (!days.length) return;
  // 한 날짜 = 작은 칸 하나:  [아이콘] [최고/최저] / [날씨] [강수] / 오늘
  el.innerHTML = days.map((x) => `
    <div class="w-day" title="서울 ${esc(x.t)}">
      <span class="w-icon" aria-hidden="true">${weatherIcon(x.code)}</span>
      <span class="w-temp">${Math.round(x.hi)}°<small>/${Math.round(x.lo)}°</small></span>
      <span class="w-label">${esc(weatherLabel(x.code))}</span>
      <span class="w-pop ${x.pop >= 60 ? "wet" : ""}">강수 ${x.pop ?? "-"}%</span>
    </div>`).join("");
  el.hidden = false;
}

// ---------------------------------------------------------------- 시작

// 날짜가 바뀐 뒤 다시 보면 '매일' 할 일의 체크를 풀어 다시 그린다
let shownDay = todayStr();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && todayStr() !== shownDay) renderAll();
});
setInterval(() => { if (todayStr() !== shownDay) renderAll(); }, 60000);

function renderAll() {
  shownDay = todayStr();
  renderHub();
  renderHome();
  renderCalendar();
  renderNotices();
  renderProc();
  renderNotes();
}

// 로그인 기능(sync.js)을 못 불러오면 로그인 페이지에 이유와 '다시 시도'를 보여준다
window.solSyncFailed = (why) => {
  if (window.solSync) return;
  document.getElementById("gateWait").hidden = true;
  document.getElementById("loginForm").hidden = true;
  document.getElementById("gateFailMsg").textContent = "로그인 서버에 연결하지 못했어요. " + why;
  document.getElementById("gateFail").hidden = false;
};
if (window.claude) {
  // claude.ai 미리보기에서는 외부 로그인을 쓸 수 없어 로그인 없이 보여준다
  document.body.classList.remove("locked");
  document.getElementById("syncBox").hidden = true;
} else {
  setTimeout(() => window.solSyncFailed("인터넷 연결이나 광고 차단 프로그램을 확인해 주세요."), 12000);
}

// sync.js 가 클라우드에서 받은 데이터를 화면에 반영할 때 쓰는 입구
window.solApp = {
  SYNC_KEYS,
  get(key) { return state[key]; },
  hasLocal(key) { return store.has(key); },
  // 로그아웃하면 이 기기 화면에서 내 데이터를 지운다 (클라우드에는 그대로 남아 다시 로그인하면 돌아온다)
  clearSynced() {
    for (const key of SYNC_KEYS) this.apply(key, key === "stars" || key === "noticeMemos" ? {} : []);
  },
  apply(key, value) {
    state[key] = value;
    try { localStorage.setItem("mwp." + key, JSON.stringify(value)); } catch { /* 저장 불가 환경 */ }
    if (key === "works") state.works.forEach((w, i) => { w.starred ??= false; w.order ??= i; });
    // 메모를 쓰는 중이면 메모 보드는 다시 그리지 않는다 (커서가 날아가지 않게)
    const typing = document.activeElement?.classList?.contains("note-text");
    const memoTyping = document.activeElement?.classList?.contains("nmemo-text");
    renderHub();
    renderHome();
    renderCalendar();
    if (!memoTyping) renderNotices();
    if (!typing) renderNotes();
  },
};

(function init() {
  const t = new Date();
  $("#todayLabel").textContent = t.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
  state.cal = { year: t.getFullYear(), month: t.getMonth(), selected: todayStr() };
  resetEventForm();
  const tab = location.hash.slice(1);
  if (document.getElementById("tab-" + tab)) { document.body.classList.remove("hub-mode"); showTab(tab); }
  else { showTab(store.get("tab", "home")); showHub(); }
  renderNoteColors();
  renderAll();
  loadNotices();
  loadWeather();
})();
