// 수정 요청 버튼 — 화면 오른쪽 아래 연필 버튼을 누르면 메모 칸이 열린다. 대시보드와 여행노트가 함께 쓴다.
// [올리기]를 누르면
//   · 사이트에 로그인해 있으면 Firebase 에 바로 저장 (feedback-store.js). 한 시간 안에 GitHub 이슈로 옮겨진다.
//   · 로그인이 안 돼 있으면 GitHub 새 이슈 화면을 내용이 채워진 채로 연다 (거기서 Submit).
// Claude에게 "수정 요청 불러와"라고 하면 이슈를 읽어서 고친다.
(function () {
  "use strict";
  var REPO = "https://github.com/esang159/solworks";
  var DRAFT = "sol.feedback.draft";
  var SENT = "sol.feedback.sent";

  function where() {
    var p = location.pathname;
    if (/\/travel\//.test(p)) {
      var v = (location.hash || "").replace("#/", "") || "home";
      var names = { home: "여행 만들기", cart: "일정표", explore: "둘러보기", shop: "특산물 쇼핑" };
      return "여행노트 · " + (names[v] || v);
    }
    if (document.body.classList.contains("hub-mode")) return "서비스 선택";
    var tab = document.querySelector("[data-tab].active");
    return "대시보드 · " + (tab ? tab.textContent.trim() : "");
  }
  function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  var css = document.createElement("style");
  css.textContent = [
    ".fb-btn{position:fixed;right:18px;bottom:calc(18px + env(safe-area-inset-bottom,0px));z-index:9000;width:52px;height:52px;border-radius:16px;border:0;cursor:pointer;",
    "background:#e8875f;color:#111;display:grid;place-items:center;box-shadow:0 8px 22px rgba(0,0,0,.35);transition:transform .15s}",
    ".fb-btn:hover{transform:translateY(-2px)}",
    ".fb-btn svg{width:24px;height:24px}",
    ".fb-btn .fb-n{position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;border-radius:9px;background:#fff;color:#111;font:700 11px/18px system-ui,sans-serif;padding:0 5px}",
    ".fb-panel{position:fixed;right:18px;bottom:calc(82px + env(safe-area-inset-bottom,0px));z-index:9001;width:min(360px,calc(100vw - 36px));",
    "background:#141312;color:#ece8e2;border:1px solid #2c2a27;border-radius:16px;box-shadow:0 18px 48px rgba(0,0,0,.5);padding:16px;",
    "font:14px/1.5 'MaruBuri',system-ui,-apple-system,'Malgun Gothic',sans-serif;display:none}",
    ".fb-panel.open{display:block}",
    ".fb-panel h3{margin:0 0 2px;font-size:16px;font-weight:700;color:#fff}",
    ".fb-panel .fb-where{font-size:12px;color:#9a948c;margin-bottom:10px}",
    ".fb-panel .fb-where b{color:#e8875f;font-weight:600}",
    ".fb-panel textarea{width:100%;box-sizing:border-box;min-height:130px;resize:vertical;border-radius:10px;border:1px solid #34312d;background:#0b0a09;color:#ece8e2;",
    "padding:10px 12px;font:inherit;outline:none}",
    ".fb-panel textarea:focus{border-color:#e8875f}",
    ".fb-row{display:flex;gap:8px;margin-top:10px;align-items:center}",
    ".fb-row .fb-go{flex:1;border:0;border-radius:10px;background:#e8875f;color:#111;font:700 14px/1 inherit;padding:12px;cursor:pointer}",
    ".fb-row .fb-go:disabled{opacity:.4;cursor:default}",
    ".fb-row .fb-x{border:1px solid #34312d;background:transparent;color:#bdb6ad;border-radius:10px;padding:11px 14px;cursor:pointer;font:inherit}",
    ".fb-help{font-size:12px;color:#9a948c;margin-top:10px;line-height:1.55}",
    ".fb-help b{color:#ece8e2;font-weight:600}",
    ".fb-sent{margin-top:12px;border-top:1px solid #2c2a27;padding-top:10px}",
    ".fb-sent summary{font-size:12px;color:#9a948c;cursor:pointer}",
    ".fb-sent ul{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:8px;max-height:280px;overflow:auto}",
    ".fb-sent li{font-size:12.5px;color:#d6d0c8;background:#0b0a09;border:1px solid #2c2a27;border-radius:10px;padding:8px 10px}",
    ".fb-sent li small{display:block;color:#7d776f}",
    ".fb-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px}",
    ".fb-st{font:700 11px/1 system-ui,sans-serif;padding:3px 7px;border-radius:5px;background:#2c2a27;color:#bdb6ad}",
    ".fb-st.issued{background:#332912;color:#e8c06e}.fb-st.done{background:#1b2c21;color:#7fcb9b}",
    ".fb-top small{display:inline;margin-left:2px}",
    ".fb-top .fb-ed{margin-left:auto;border:1px solid #34312d;background:transparent;color:#bdb6ad;border-radius:6px;padding:3px 8px;font:12px/1 inherit;cursor:pointer}",
    ".fb-t{margin:0;white-space:pre-wrap;line-height:1.5}",
    ".fb-reply{margin-top:6px;padding:7px 9px;border-radius:8px;background:#1b2c21;color:#d8efe0;white-space:pre-wrap;line-height:1.5}",
    ".fb-reply b{display:block;font-size:11px;color:#7fcb9b;margin-bottom:2px}",
    ".fb-edit textarea{min-height:80px;margin-top:4px}",
    ".fb-edit .fb-row{margin-top:6px}.fb-edit .fb-row button{padding:8px 12px}",
    ".fb-sent a{color:#e8875f}",
    "@media print{.fb-btn,.fb-panel{display:none!important}}"
  ].join("");
  document.head.appendChild(css);

  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fb-btn";
  btn.title = "수정 요청 남기기";
  btn.setAttribute("aria-label", "수정 요청 남기기");
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="M13.5 6.5l4 4"/></svg>';

  var panel = document.createElement("div");
  panel.className = "fb-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "수정 요청");
  panel.innerHTML =
    '<h3>수정 요청</h3>' +
    '<div class="fb-where">지금 화면: <b class="fb-place"></b></div>' +
    '<textarea class="fb-text" placeholder="고치고 싶은 점을 적어 주세요.&#10;예) 공고 목록 글씨가 너무 작아요 / 지도 버튼을 위로 옮겨 주세요"></textarea>' +
    '<div class="fb-row"><button type="button" class="fb-go">올리기</button><button type="button" class="fb-x">닫기</button></div>' +
    '<p class="fb-help fb-msg"></p>' +
    '<details class="fb-sent"><summary>보낸 요청</summary><ul></ul>' +
    '<p class="fb-help"><a href="' + REPO + '/issues" target="_blank" rel="noopener">GitHub에서 전체 보기</a></p></details>';

  var text = panel.querySelector(".fb-text");
  var go = panel.querySelector(".fb-go");

  // 로그인해 있으면 Firebase 의 내 요청 목록(상태·답변 포함), 아니면 이 기기에서 보낸 기록
  var cloud = null, editing = null;
  var STATUS = { new: ["접수 대기", ""], issuing: ["접수 대기", ""], issued: ["처리 중", "issued"], done: ["처리 완료", "done"] };
  function renderSent() {
    var ul = panel.querySelector(".fb-sent ul");
    if (cloud) {
      ul.innerHTML = cloud.length ? cloud.map(function (f) {
        var st = STATUS[f.status] || ["접수 대기", ""];
        var label = st[0] + (f.issue && f.status !== "new" ? " · #" + f.issue : "") + (f.edited ? " · 수정 반영 대기" : "");
        var top = '<div class="fb-top"><span class="fb-st ' + st[1] + '">' + esc(label) + "</span><small>" + esc(f.where || "") + " · " + esc(f.at || "") +
          '</small><button type="button" class="fb-ed" data-id="' + esc(f.id) + '">' + (editing === f.id ? "닫기" : "수정") + "</button></div>";
        var body = editing === f.id
          ? '<div class="fb-edit"><textarea class="fb-et">' + esc(f.text || "") + '</textarea><div class="fb-row"><button type="button" class="fb-go fb-save" data-id="' + esc(f.id) + '">고친 내용 저장</button></div></div>'
          : '<p class="fb-t">' + esc(f.text || "") + "</p>";
        var reply = f.reply ? '<div class="fb-reply"><b>답변' + (f.doneAt ? " · " + esc(f.doneAt) : "") + "</b>" + esc(f.reply) + "</div>" : "";
        return "<li>" + top + body + reply + "</li>";
      }).join("") : "<li>아직 보낸 요청이 없어요</li>";
      return;
    }
    var list = load(SENT, []);
    ul.innerHTML = list.length
      ? list.slice().reverse().map(function (s) { return "<li>" + esc(s.text.slice(0, 80)) + "<small>" + esc(s.where) + " · " + esc(s.at) + "</small></li>"; }).join("")
      : "<li>아직 없어요</li>";
  }
  function hookCloud() {
    if (!window.solFeedback || !window.solFeedback.onList) return;
    window.solFeedback.onList(function (list) {
      cloud = window.solFeedback.ready() ? list : null;
      if (panel.classList.contains("open") && !editing) renderSent();
    });
  }
  window.addEventListener("sol-feedback-ready", hookCloud);
  hookCloud();
  panel.querySelector(".fb-sent ul").addEventListener("click", function (e) {
    var ed = e.target.closest(".fb-ed");
    if (ed) { editing = editing === ed.dataset.id ? null : ed.dataset.id; renderSent(); return; }
    var sv = e.target.closest(".fb-save");
    if (!sv) return;
    var ta = sv.closest("li").querySelector(".fb-et");
    var val = ta.value.trim();
    if (!val) return;
    sv.disabled = true; sv.textContent = "저장 중…";
    window.solFeedback.edit(sv.dataset.id, val).then(function () {
      editing = null; renderSent();
      msg.innerHTML = "<b>고쳤어요 ✓</b> 이미 처리 중인 요청이면 고친 내용이 이슈에 덧붙여져요.";
    }).catch(function (err) {
      sv.disabled = false; sv.textContent = "고친 내용 저장";
      msg.textContent = "저장하지 못했어요 (" + (err && err.message || "연결 오류") + ")";
    });
  });
  var msg = panel.querySelector(".fb-msg");
  var direct = function () { return !!(window.solFeedback && window.solFeedback.ready()); };
  function hint() {
    msg.innerHTML = direct()
      ? '누르면 바로 올라갑니다. Claude에게 <b>"수정 요청 불러와"</b>라고 하면 읽어서 고칩니다.'
      : '로그인이 안 돼 있어 GitHub 창으로 올립니다. 창이 열리면 <b>Submit new issue</b>를 눌러 주세요.';
  }
  function sync() { go.disabled = sending || !text.value.trim(); }
  var sending = false;
  function open() {
    panel.querySelector(".fb-place").textContent = where();
    text.value = load(DRAFT, "");
    sync(); renderSent(); hint();
    if (cloud && cloud.length) panel.querySelector(".fb-sent").open = true;
    panel.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    text.focus();
  }
  function close() { panel.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); }

  btn.addEventListener("click", function () { panel.classList.contains("open") ? close() : open(); });
  panel.querySelector(".fb-x").addEventListener("click", close);
  text.addEventListener("input", function () { save(DRAFT, text.value); sync(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && panel.classList.contains("open")) close(); });

  go.addEventListener("click", function () {
    var body = text.value.trim();
    if (!body || sending) return;
    var place = where();
    var now = new Date();
    var at = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0") +
      " " + String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
    var item = { text: body, where: place, url: location.href, at: at, size: window.innerWidth + "×" + window.innerHeight };

    function done(how) {
      var sent = load(SENT, []);
      sent.push({ text: body, where: place, at: at });
      save(SENT, sent.slice(-20));
      save(DRAFT, "");
      text.value = "";
      sending = false;
      sync(); renderSent();
      panel.querySelector(".fb-sent").open = true;
      msg.innerHTML = how;
    }
    function viaGitHub() {
      var title = "[수정요청] " + place + " — " + body.split("\n")[0].slice(0, 50);
      var issue = body + "\n\n---\n- 화면: " + place + "\n- 주소: " + item.url + "\n- 작성: " + at + "\n- 화면 크기: " + item.size;
      window.open(REPO + "/issues/new?title=" + encodeURIComponent(title) + "&body=" + encodeURIComponent(issue) +
        "&labels=" + encodeURIComponent("수정요청"), "_blank", "noopener");
      done('GitHub 창에서 <b>Submit new issue</b>를 눌러야 올라갑니다.');
    }

    if (!direct()) return viaGitHub();
    sending = true; sync();
    go.textContent = "올리는 중…";
    window.solFeedback.send(item).then(function () {
      go.textContent = "올리기";
      done('<b>올라갔어요 ✓</b> Claude에게 "수정 요청 불러와"라고 하면 읽어서 고칩니다.');
    }).catch(function (e) {
      console.error(e);
      go.textContent = "올리기";
      sending = false; sync();
      msg.innerHTML = '저장하지 못했어요 (' + esc(e && e.message || "연결 오류") + '). 다시 누르거나, 안 되면 <a href="#" class="fb-gh" style="color:#e8875f">GitHub로 올리기</a>';
      var a = msg.querySelector(".fb-gh");
      if (a) a.addEventListener("click", function (ev) { ev.preventDefault(); viaGitHub(); });
    });
  });

  // 로그인 화면에서는 숨긴다 (대시보드의 body.locked)
  function visible() { btn.style.display = document.body.classList.contains("locked") ? "none" : ""; if (btn.style.display) close(); }
  new MutationObserver(visible).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  document.body.appendChild(btn);
  document.body.appendChild(panel);
  visible();
})();
