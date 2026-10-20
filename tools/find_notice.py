"""특정 공고가 어디에 있는지 찾는다 (수동 실행용).

  python tools/find_notice.py "검색어" ["검색어2" ...]

1) NTIS 국가R&D통합공고 목록을 앞에서부터 넘기며 제목에 검색어가 있는 행을 찾고, 몇 페이지·어떤 상태인지 찍는다.
2) IRIS 사업공고 목록 화면과 목록 데이터 주소를 불러 보고, 검색어가 들어 있는지와 응답 모양을 찍는다.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "crawler"))
import crawl  # noqa: E402

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}


def fetch(url: str, data: dict | None = None, headers: dict | None = None) -> tuple[int, str]:
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers={**UA, **(headers or {})}, method="POST" if body else "GET")
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:500]
    except Exception as e:  # noqa: BLE001
        return 0, f"{type(e).__name__}: {e}"


def ntis(words: list[str], pages: int = 40) -> None:
    print("===== NTIS 국가R&D통합공고 =====")
    found = 0
    for page in range(1, pages + 1):
        code, html = fetch(f"{crawl.NTIS_LIST}?pageIndex={page}&pageUnit=50&recordCountPerPage=50")
        if code != 200:
            print(f"[ntis] {page}페이지 실패 {code}: {html[:200]}")
            break
        rows = crawl.parse_ntis_rows(html)
        if not rows:
            print(f"[ntis] {page}페이지 행 없음 - 끝")
            break
        for r in rows:
            if any(w in r["title"] for w in words):
                found += 1
                print(f"[ntis] 찾음 {page}페이지: 상태={r['status'] or '-'} | {r['title']} | {r['org']} | {r['start']}~{r['end']} | {r['url']}")
        if page in (1, 10, 20, 30, 40):
            print(f"[ntis] {page}페이지 마지막 행: {rows[-1]['status']} {rows[-1]['start']} {rows[-1]['title'][:40]}")
    print(f"[ntis] 검색 결과 {found}건 ({pages}페이지까지)")
    # NTIS 목록 화면의 검색 기능도 시도
    for key in ("searchKeyword", "searchWrd", "schKeyword"):
        code, html = fetch(f"{crawl.NTIS_LIST}?{key}={urllib.parse.quote(words[0])}&pageUnit=50")
        rows = crawl.parse_ntis_rows(html) if code == 200 else []
        hit = [r for r in rows if any(w in r["title"] for w in words)]
        print(f"[ntis] 검색 파라미터 {key}: 응답 {code}, 행 {len(rows)}개, 일치 {len(hit)}개")
        for r in hit[:3]:
            print(f"        {r['status']} | {r['title']} | {r['start']}~{r['end']}")


def iris(words: list[str]) -> None:
    print("\n===== IRIS 사업공고 =====")
    base = "https://www.iris.go.kr"
    pages = [
        ("목록 화면", base + "/contents/retrieveBsnsAncmBtinSituListView.do", None),
        ("목록 데이터(POST)", base + "/contents/retrieveBsnsAncmBtinSituList.do",
         {"pageIndex": "1", "pageUnit": "50", "searchKeyword": words[0]}),
        ("목록 데이터(POST, 검색어 없음)", base + "/contents/retrieveBsnsAncmBtinSituList.do",
         {"pageIndex": "1", "pageUnit": "50"}),
    ]
    for name, url, data in pages:
        code, text = fetch(url, data, {"X-Requested-With": "XMLHttpRequest", "Referer": base + "/contents/retrieveBsnsAncmBtinSituListView.do"})
        hit = [w for w in words if w in text]
        print(f"[iris] {name}: 응답 {code}, {len(text)}자, 검색어 포함 {hit or '없음'}")
        snippet = text[:1500].replace("\n", " ")
        print("        앞부분:", re.sub(r"\s+", " ", snippet)[:1500])
        for w in words:
            for m in list(re.finditer(re.escape(w), text))[:2]:
                print("        주변:", re.sub(r"\s+", " ", text[max(0, m.start() - 300):m.end() + 300]))
        if text.strip().startswith("{"):
            try:
                j = json.loads(text)
                print("        JSON 키:", list(j)[:20])
            except ValueError:
                pass


def iris_view(words: list[str]) -> None:
    """목록에서 공고를 누르면 여는 함수(f_bsnsAncmBtinSituListForm_view)가 어느 주소로 가는지 찾고, 실제로 열어 본다."""
    print("\n===== IRIS 상세 주소 =====")
    base = "https://www.iris.go.kr"
    code, html = fetch(base + "/contents/retrieveBsnsAncmBtinSituListView.do")
    texts = [("목록 화면", html)]
    for src in re.findall(r'<script[^>]+src="([^"]+)"', html):
        if "jquery" in src.lower():
            continue
        c, js = fetch(urllib.parse.urljoin(base, src))
        if "BsnsAncm" in js or "bsnsAncm" in js:
            texts.append((src, js))
    for name, t in texts:
        for m in re.finditer(r"f_bsnsAncmBtinSituListForm_view\s*=?\s*function|function\s+f_bsnsAncmBtinSituListForm_view", t):
            print(f"[iris] {name} 에서 찾음:", re.sub(r"\s+", " ", t[m.start():m.start() + 900]))
        for m in list(re.finditer(r"retrieveBsnsAncm\w*View\.do", t))[:5]:
            print(f"[iris] {name} 주소 후보:", re.sub(r"\s+", " ", t[max(0, m.start() - 200):m.end() + 200]))
    # 흔한 모양의 주소를 직접 열어 본다
    code, data = fetch(base + "/contents/retrieveBsnsAncmBtinSituList.do", {"pageIndex": "1"})
    try:
        first = json.loads(data)["listBsnsAncmBtinSitu"][0]
    except Exception:  # noqa: BLE001
        print("[iris] 목록 데이터를 못 읽음"); return
    aid, title = first["ancmId"], first["ancmTl"]
    for path in ("/contents/retrieveBsnsAncmView.do", "/contents/retrieveBsnsAncmBtinSituView.do",
                 "/contents/retrieveBsnsAncmBtinSituDetailView.do"):
        for method in ("GET", "POST"):
            q = {"ancmId": aid, "ancmPrg": "ancmIng"}
            url = base + path + ("?" + urllib.parse.urlencode(q) if method == "GET" else "")
            c, t = fetch(url, q if method == "POST" else None)
            print(f"[iris] {method} {path}: 응답 {c}, {len(t)}자, 제목 포함 {title[:20] in t}")


if __name__ == "__main__":
    ws = sys.argv[1:] or ["IRES", "학생인력교류"]
    ntis(ws)
    iris(ws)
    iris_view(ws)
