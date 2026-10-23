// Sol Works 중계 서버 (Cloudflare Workers)
// - 로그인한 사람(Firebase 로그인 증표)의 요청만 받는다.
// - 키는 Cloudflare 비밀 값(NAVER_ID, NAVER_SECRET)에만 있고 응답에는 절대 넣지 않는다.
//
//   GET /health                    살아 있는지 (로그인 불필요)
//   매일 08:47 KST                 사업공고 수집 워크플로 실행 (wrangler.toml [triggers], 비밀 값 GH_TOKEN)
//   GET /naver/local?q=춘천역 맛집   네이버 지역 검색 → {items:[{name, category, address, road, lat, lng, link}]}
//   GET /odsay/path?sx=&sy=&ex=&ey=  ODsay 대중교통 길찾기 (응답 그대로). 키(ODSAY_KEY)는 사이트 주소로 잠긴
//                                    웹 키라 사이트 주소를 Referer 로 붙여 부른다 (GitHub 에서 확인)
//   GET /naver/image?q=춘천 호수별닭갈비  네이버 이미지 검색 → {items:[{thumb, src, w, h}]}
//   GET /tour/info?name=&lat=&lng=   한국관광공사 관광정보(공공데이터포털 DATA_GO_KR_KEY) — 이름·위치로 찾아
//                                    {found, title, overview, tel, homepage, info:[[항목, 값]], images:[]}
// 장소 정보는 잘 안 바뀌므로 Cloudflare 캐시에 하루 둔다 (같은 장소는 네이버·관광공사에 다시 묻지 않음)

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

async function naverImage(url, env) {
  if (!env.NAVER_ID || !env.NAVER_SECRET) return { status: 503, body: { error: "no_key" } };
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  if (!q) return { status: 400, body: { error: "query" } };
  const u = new URL("https://naverapihub.apigw.ntruss.com/search/v1/image");
  u.searchParams.set("query", q);
  u.searchParams.set("display", "12");
  u.searchParams.set("sort", "sim");
  const r = await fetch(u, { headers: { "X-NCP-APIGW-API-KEY-ID": env.NAVER_ID, "X-NCP-APIGW-API-KEY": env.NAVER_SECRET } });
  if (!r.ok) return { status: 502, body: { error: "naver", status: r.status } };
  const d = await r.json();
  const items = (d.items || [])
    .map((it) => ({ thumb: it.thumbnail, src: it.link, w: +it.sizewidth || 0, h: +it.sizeheight || 0 }))
    .filter((x) => x.thumb && (!x.w || x.w >= 300));   // 아이콘·작은 그림 빼기
  return { status: 200, body: { items: items.slice(0, 10) } };
}

/* 한국관광공사 국문 관광정보(KorService2). 이름으로 찾고, 그중 좌표가 1.5km 안인 곳을 고른다 */
const TOUR = "https://apis.data.go.kr/B551011/KorService2/";
const INTRO = {   // 분류별 상세 항목 이름
  "12": [["usetime", "이용 시간"], ["restdate", "쉬는 날"], ["parking", "주차"], ["infocenter", "문의"], ["expguide", "체험"]],
  "14": [["usetimeculture", "이용 시간"], ["restdateculture", "쉬는 날"], ["usefee", "요금"], ["parkingculture", "주차"], ["infocenterculture", "문의"]],
  "15": [["eventstartdate", "시작"], ["eventenddate", "끝"], ["playtime", "시간"], ["usetimefestival", "요금"], ["eventplace", "장소"]],
  "28": [["usetimeleports", "이용 시간"], ["restdateleports", "쉬는 날"], ["usefeeleports", "요금"], ["parkingleports", "주차"]],
  "32": [["checkintime", "체크인"], ["checkouttime", "체크아웃"], ["roomtype", "객실"], ["parkinglodging", "주차"], ["reservationlodging", "예약"]],
  "38": [["opentime", "영업 시간"], ["restdateshopping", "쉬는 날"], ["parkingshopping", "주차"]],
  "39": [["firstmenu", "대표 메뉴"], ["treatmenu", "메뉴"], ["opentimefood", "영업 시간"], ["restdatefood", "쉬는 날"], ["parkingfood", "주차"], ["infocenterfood", "문의"]],
};
const strip2 = (s) => String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
async function tourGet(op, params, env) {
  const u = new URL(TOUR + op);
  u.searchParams.set("serviceKey", env.DATA_GO_KR_KEY);
  u.searchParams.set("MobileOS", "ETC");
  u.searchParams.set("MobileApp", "solworks");
  u.searchParams.set("_type", "json");
  for (const k in params) u.searchParams.set(k, params[k]);
  const r = await fetch(u);
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* XML 오류 응답 */ }
  if (!r.ok || !j || !j.response) return { error: (j && j.OpenAPI_ServiceResponse && j.OpenAPI_ServiceResponse.cmmMsgHeader && j.OpenAPI_ServiceResponse.cmmMsgHeader.errMsg) || ("http " + r.status) };
  const items = j.response.body && j.response.body.items && j.response.body.items.item;
  return { items: Array.isArray(items) ? items : items ? [items] : [] };
}
function km(a, b) {
  const R = 6371, d1 = (b.lat - a.lat) * Math.PI / 180, d2 = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(d1 / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(d2 / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
async function tourInfo(url, env) {
  if (!env.DATA_GO_KR_KEY) return { status: 503, body: { error: "no_key" } };
  const name = (url.searchParams.get("name") || "").trim().slice(0, 60);
  const at = { lat: +url.searchParams.get("lat"), lng: +url.searchParams.get("lng") };
  if (!name) return { status: 400, body: { error: "query" } };
  const s = await tourGet("searchKeyword2", { keyword: name, numOfRows: "20", arrange: "A" }, env);
  if (s.error) return { status: 502, body: { error: "tour", detail: s.error } };
  const near = s.items
    .map((x) => ({ x, d: (at.lat && x.mapy) ? km(at, { lat: +x.mapy, lng: +x.mapx }) : 99 }))
    .filter((o) => o.d <= 1.5)
    .sort((a, b) => a.d - b.d)[0];
  if (!near) return { status: 200, body: { found: false } };
  const it = near.x, id = it.contentid, type = String(it.contenttypeid || "");
  const [com, intro, img] = await Promise.all([
    tourGet("detailCommon2", { contentId: id }, env),
    INTRO[type] ? tourGet("detailIntro2", { contentId: id, contentTypeId: type }, env) : Promise.resolve({ items: [] }),
    tourGet("detailImage2", { contentId: id, imageYN: "Y" }, env),
  ]);
  const c = (com.items && com.items[0]) || {};
  const ii = (intro.items && intro.items[0]) || {};
  const info = (INTRO[type] || []).map(([k, label]) => [label, strip2(ii[k])]).filter((p) => p[1]);
  const images = [it.firstimage, ...((img.items || []).map((m) => m.originimgurl))].filter(Boolean)
    .map((u) => u.replace(/^http:/, "https:"));
  return { status: 200, body: {
    found: true, title: it.title, type, tel: strip2(c.tel || it.tel), homepage: strip2(c.homepage),
    overview: strip2(c.overview).slice(0, 600), addr: [it.addr1, it.addr2].filter(Boolean).join(" "),
    info, images: [...new Set(images)].slice(0, 8),
  } };
}

export default {
  async fetch(req, env) {
    const cors = corsFor(req, env);
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "GET") return json({ error: "method" }, 405, cors);

    if (url.pathname === "/health") {
      return json({ ok: true, naver: Boolean(env.NAVER_ID && env.NAVER_SECRET), odsay: Boolean(env.ODSAY_KEY), tour: Boolean(env.DATA_GO_KR_KEY), github: Boolean(env.GH_TOKEN) }, 200, cors);
    }

    if (url.pathname === "/naver/local") {
      if (!(await userOf(req, env))) return json({ error: "login" }, 401, cors);
      if (!env.NAVER_ID || !env.NAVER_SECRET) return json({ error: "no_key" }, 503, cors);
      const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
      if (!q) return json({ error: "query" }, 400, cors);
      const out = await naverLocal(q, env);
      return json(out.body, out.status, cors);
    }

    if (url.pathname === "/naver/image" || url.pathname === "/tour/info") {
      if (!(await userOf(req, env))) return json({ error: "login" }, 401, cors);
      const cache = caches.default;
      const key = new Request(url.origin + url.pathname + url.search);
      let hit = await cache.match(key);
      if (!hit) {
        const out = url.pathname === "/naver/image" ? await naverImage(url, env) : await tourInfo(url, env);
        hit = new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=86400" } });
        if (out.status === 200) await cache.put(key, hit.clone());
      }
      return new Response(hit.body, { status: hit.status, headers: { "content-type": "application/json; charset=utf-8", ...cors } });
    }

    if (url.pathname === "/odsay/path") {
      if (!(await userOf(req, env))) return json({ error: "login" }, 401, cors);
      if (!env.ODSAY_KEY) return json({ error: "no_key" }, 503, cors);
      const n = (k) => { const v = Number(url.searchParams.get(k)); return Number.isFinite(v) ? v : null; };
      const sx = n("sx"), sy = n("sy"), ex = n("ex"), ey = n("ey");
      if ([sx, sy, ex, ey].some((v) => v === null)) return json({ error: "query" }, 400, cors);
      const u = `https://api.odsay.com/v1/api/searchPubTransPathT?SX=${sx}&SY=${sy}&EX=${ex}&EY=${ey}&OPT=0&SearchType=0&apiKey=${encodeURIComponent(env.ODSAY_KEY)}`;
      const r = await fetch(u, { headers: { referer: "https://www.solworks.store/travel/", origin: "https://www.solworks.store" } });
      return new Response(await r.text(), { status: r.ok ? 200 : 502, headers: { "content-type": "application/json; charset=utf-8", ...cors } });
    }

    return json({ error: "not_found" }, 404, cors);
  },

  // 정시 실행: GitHub 의 사업공고 수집을 workflow_dispatch 로 부른다. 그날 이미 했으면 워크플로가 알아서 건너뛴다.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchCrawl(env));
  },
};

async function dispatchCrawl(env) {
  if (!env.GH_TOKEN) { console.log("GH_TOKEN 없음 - 건너뜀"); return; }
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "solworks-relay",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: env.GH_REF, inputs: { scheduled: "true" } }),
  });
  console.log("수집 실행 요청", r.status, r.status === 204 ? "" : await r.text());
}
