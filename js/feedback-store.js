// 수정 요청을 Firebase 에 바로 저장한다 (feedback.js 가 부른다).
// 사이트에 로그인해 있으면 users/{내 uid}/feedback/{자동 id} 에 들어가고,
// GitHub Actions(feedback.yml)가 한 시간마다 읽어서 GitHub 이슈로 옮기고, 처리 상태와 답변을 다시 적어 준다.
// 대시보드에서는 sync.js 가 먼저 만든 Firebase 앱을 같이 쓰고, 여행노트에서는 여기서 만든다
// (같은 사이트라 로그인 상태가 그대로 이어진다).

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, addDoc, updateDoc, doc, onSnapshot, query, orderBy, limit, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = getApps()[0] || initializeApp(firebaseConfig);
const auth = getAuth(app);
let user = null;
let listeners = [], unsub = null, latest = [];
// 로그인한 동안 내 요청 목록을 실시간으로 받아 둔다 (상태·답변이 바뀌면 바로 보이게)
function watch() {
  if (unsub) { unsub(); unsub = null; }
  latest = [];
  if (!user) { listeners.forEach((f) => f(latest)); return; }
  const q = query(collection(getFirestore(app), "users", user.uid, "feedback"), orderBy("createdAt", "desc"), limit(30));
  unsub = onSnapshot(q, (snap) => {
    latest = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    listeners.forEach((f) => f(latest));
  }, (e) => console.error(e));
}
onAuthStateChanged(auth, (u) => { user = u; watch(); });

window.solFeedback = {
  ready: () => !!user,
  async send(item) {
    if (!user) throw new Error("로그인되어 있지 않아요");
    const ref = await addDoc(collection(getFirestore(app), "users", user.uid, "feedback"), {
      ...item, status: "new", createdAt: serverTimestamp(),
    });
    return ref.id;
  },
  // 목록이 바뀔 때마다 fn(목록)을 부른다. 바로 한 번 지금 목록으로도 부른다.
  onList(fn) { listeners.push(fn); fn(latest); },
  // 보낸 요청 고치기 — 이슈로 옮겨진 뒤면 다음 동기화 때 이슈에 댓글로 붙는다
  async edit(id, text) {
    if (!user) throw new Error("로그인되어 있지 않아요");
    const now = new Date();
    const at = now.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    await updateDoc(doc(getFirestore(app), "users", user.uid, "feedback", id), {
      text, edited: true, editedAt: at, updatedAt: serverTimestamp(),
    });
  },
};
window.dispatchEvent(new Event("sol-feedback-ready"));
