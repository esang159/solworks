// Sol Works 중계 서버 (Cloudflare Workers)
// - 로그인한 사람(Firebase 로그인 증표)의 요청만 받는다.
// - 키는 Cloudflare 비밀 값(NAVER_ID, NAVER_SECRET)에만 있고 응답에는 절대 넣지 않는다.
//
//   GET /health                    살아 있는지 (로그인 불필요)
//   GET /naver/local?q=춘천역 맛집   네이버 지역 검색 → {items:[{name, category, address, road, lat, lng, link}]}

const json = (body, status, cors) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...cors } });

function corsFor(req, env) {
  const origin = req.headers.get("origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  if (!allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

// Firebase 로그인 증표가 진짜인지 Firebase에 묻는다. 같은 증표는 5분 동안 다시 묻지 않는다.
const seen = new Map();
async function userOf(req, env) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer (.+)$/);
  if (!m) return null;
  const token = m[1];
  const hit = seen.get(token);
  if (hit && hit.until > Date.now()) return hit.uid;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken: token }),
  });
  if (!r.ok) return null;
  const uid = (await r.json()).users?.[0]?.localId || null;
  if (uid) {
    if (seen.size > 200) seen.clear();
    seen.set(token, { uid, until: Date.now() + 5 * 60 * 1000 });
  }
  return uid;
}

const strip = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');

// NAVER API HUB(2026년 8월부터 새 키는 여기서 발급) 먼저, 안 되면 예전 개발자센터 방식으로.
const NAVER_LOCAL = [
  { url: "https://naverapihub.apigw.ntruss.com/search/v1/local", id: "X-NCP-APIGW-API-KEY-ID", secret: "X-NCP-APIGW-API-KEY" },
  { url: "https://openapi.naver.com/v1/search/local.json", id: "X-Naver-Client-Id", secret: "X-Naver-Client-Secret" },
];

async function naverLocal(q, env) {
  let r;
  for (const ep of NAVER_LOCAL) {
    const u = new URL(ep.url);
    u.searchParams.set("query", q);
    u.searchParams.set("display", "5");
    r = await fetch(u, { headers: { [ep.id]: env.NAVER_ID, [ep.secret]: env.NAVER_SECRET } });
    if (r.status !== 401 && r.status !== 403) break;
  }
  if (!r.ok) return { status: 502, body: { error: "naver", status: r.status } };
  const data = await r.json();
  const items = (data.items || []).map((it) => ({
    name: strip(it.title),
    category: it.category || "",
    address: it.address || "",
    road: it.roadAddress || "",
    // mapx/mapy: 경도·위도 × 10,000,000
    lng: it.mapx ? Number(it.mapx) / 1e7 : null,
    lat: it.mapy ? Number(it.mapy) / 1e7 : null,
    link: it.link || "",
  }));
  return { status: 200, body: { items } };
}

export default {
  async fetch(req, env) {
    const cors = corsFor(req, env);
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "GET") return json({ error: "method" }, 405, cors);

    if (url.pathname === "/health") {
      return json({ ok: true, naver: Boolean(env.NAVER_ID && env.NAVER_SECRET) }, 200, cors);
    }

    if (url.pathname === "/naver/local") {
      if (!(await userOf(req, env))) return json({ error: "login" }, 401, cors);
      if (!env.NAVER_ID || !env.NAVER_SECRET) return json({ error: "no_key" }, 503, cors);
      const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
      if (!q) return json({ error: "query" }, 400, cors);
      const out = await naverLocal(q, env);
      return json(out.body, out.status, cors);
    }

    return json({ error: "not_found" }, 404, cors);
  },
};
