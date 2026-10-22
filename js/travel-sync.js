// 여행노트(travel/)를 여러 기기에서 같이 쓰기
// 여행노트는 상태를 통째로 localStorage 'yeohaengnote-v3' 에 둔다. 로그인돼 있으면 같은 내용을
// Firestore users/{uid}/data/travel 에 올리고, 다른 기기에서 더 최근에 저장한 게 있으면 받아서 다시 연다.
// 비교는 저장 시각(savedAt)으로 한다. 보안 규칙은 firebase/firestore.rules (본인 칸만).

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = getApps()[0] || initializeApp(firebaseConfig);
const db = getFirestore(app);
const KEY = "yeohaengnote-v3";
const OWNER = "yeohaengnote-owner";   // 이 기기의 여행노트가 누구 것인지

let user = null, timer = null, pending = null, synced = false;
const ref = () => doc(db, "users", user.uid, "data", "travel");
const readLocal = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } };
// 이 페이지를 열 때 이 기기에 있던 저장 시각. 처음 맞춰 보기 전에 생긴 변경(자동 검색 결과 등)은 비교에 넣지 않는다
const bootAt = (readLocal() || {}).savedAt || 0;

async function upload() {
  timer = null;
  if (!user || !pending) return;
  const st = pending;
  pending = null;
  try {
    // 배열 속 배열 같은 Firestore 제약을 피하려고 글자로 통째로 저장한다
    await setDoc(ref(), { value: JSON.stringify(st), savedAt: st.savedAt || Date.now(), updatedAt: serverTimestamp() });
  } catch (e) {
    console.error("여행노트 저장 실패", e);
    if (!pending) pending = st;   // 다음 저장 때 다시
  }
}

// travel/index.html 의 save() 가 부른다. 연달아 바뀌면 1초 모아서 한 번에 올린다.
window.travelSync = {
  push(state) {
    pending = JSON.parse(JSON.stringify(state));
    if (!user || !synced) return;   // 클라우드와 처음 맞춰 보기 전에는 올리지 않는다
    clearTimeout(timer);
    timer = setTimeout(upload, 1000);
  },
};

// 클라우드 쪽이 더 최근이면 받아서 페이지를 다시 연다 (같은 것을 두 번 받지 않게 표시)
async function pull() {
  if (!user || timer) return;   // 올릴 게 남아 있으면 이 기기 것이 더 최신
  const snap = await getDoc(ref());
  const local = readLocal();
  const lt = synced ? ((local && local.savedAt) || 0) : bootAt;
  synced = true;
  if (!snap.exists()) {
    if (local && local.savedAt) { pending = local; upload(); }
    return;
  }
  const r = snap.data();
  if (r.savedAt > lt) {
    if (sessionStorage.getItem("travel-pulled") === String(r.savedAt)) return;
    sessionStorage.setItem("travel-pulled", String(r.savedAt));
    // 다시 여는 사이에 이 화면의 늦은 저장(검색 결과 등)이 받아 온 내용을 덮어쓰지 않게 저장을 멈춘다
    window.travelSync.frozen = true;
    clearTimeout(timer); timer = null; pending = null;
    localStorage.setItem(KEY, r.value);
    location.reload();
  } else if (lt > r.savedAt && local) {
    pending = local; upload();
  } else if (pending) {
    upload();   // 맞춰 보는 동안 생긴 변경
  }
}

onAuthStateChanged(getAuth(app), (u) => {
  user = u;
  if (!u) return;
  // 다른 사람이 이 기기에서 쓰던 여행노트면 올리지 않고 지운다
  const owner = localStorage.getItem(OWNER);
  if (owner && owner !== u.uid) localStorage.removeItem(KEY);
  localStorage.setItem(OWNER, u.uid);
  pull().catch((e) => console.error("여행노트 불러오기 실패", e));
});

// 다른 기기에서 고친 뒤 이 탭으로 돌아오면 확인
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pull().catch(() => {});
});
