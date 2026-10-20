// 로그인해야 보이는 페이지(예: travel/)에 붙인다.
// 페이지는 처음에 가려 둔 채로(html.sol-guard) 시작하고, Firebase 로그인이 확인되면 보여준다.
// 로그인이 안 돼 있으면 첫 화면(로그인 페이지)으로 보내고, 로그인하면 ?next= 로 원래 페이지에 돌아온다.
// 다른 탭에서 로그아웃해도 바로 로그인 페이지로 넘어간다.

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const app = getApps()[0] || initializeApp(firebaseConfig);
const root = new URL("../", import.meta.url);   // js/ 의 한 단계 위 = 사이트 첫 화면

export function toLogin() {
  const next = location.pathname.slice(root.pathname.length).replace(/index\.html$/, "") + location.hash;
  location.replace(root.href + "?next=" + encodeURIComponent(next));
}

// 중계 서버(worker/)에 보낼 로그인 증표. 로그인 확인이 끝날 때까지 기다렸다가 준다 (로그인 안 돼 있으면 null).
let authed;
const authReady = new Promise((res) => { authed = res; });
window.solIdToken = () => authReady.then((u) => (u ? u.getIdToken() : null));

onAuthStateChanged(getAuth(app), (u) => {
  authed(u);
  if (u) {
    window.solGuardOk = true;
    document.documentElement.classList.remove("sol-guard");
  } else {
    toLogin();
  }
});
