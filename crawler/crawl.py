"""사업공고 수집기.

매일 GitHub Actions 에서 실행되어 data/notices.json 을 갱신한다.
표준 라이브러리만 사용하므로 별도 설치가 필요 없다.

수집처
  - 기업마당(bizinfo.go.kr) 지원사업 API   : 환경변수 BIZINFO_API_KEY
  - K-Startup 사업공고 (공공데이터포털)     : 환경변수 DATA_GO_KR_KEY
  - 임의의 RSS 피드                         : crawler/config.json 의 sources.rss

키가 없는 수집처는 건너뛴다.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "crawler" / "config.json"
OUTPUT_PATH = ROOT / "data" / "notices.json"

KST = timezone(timedelta(hours=9))
USER_AGENT = "Mozilla/5.0 (compatible; my-work-page-crawler/1.0)"
TIMEOUT = 30


def http_get(url: str, retries: int = 1) -> bytes:
    """GET. retries 만큼 다시 시도한다 (느린 정부 사이트 대비, 2·4·8초 간격)."""
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return resp.read()
        except Exception:
            if attempt == retries:
                raise
            time.sleep(2 ** (attempt + 1))


def parse_date(value) -> str | None:
    """'20241031', '2024-10-31', '2024.10.31 18:00' 등을 'YYYY-MM-DD' 로 바꾼다."""
    if not value:
        return None
    m = re.search(r"(\d{4})[-./]?(\d{1,2})[-./]?(\d{1,2})", str(value))
    if not m:
        return None
    y, mo, d = (int(g) for g in m.groups())
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return None


def parse_period(value) -> tuple[str | None, str | None]:
    """'20241001 ~ 20241031' 형태의 접수기간을 (시작, 종료) 로 나눈다."""
    if not value:
        return None, None
    parts = re.split(r"\s*~\s*", str(value), maxsplit=1)
    start = parse_date(parts[0])
    end = parse_date(parts[1]) if len(parts) > 1 else None
    return start, end


REGIONS = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원",
           "충북", "충남", "전북", "전남", "경북", "경남", "제주"]
REGION_ALIASES = {
    "충청북도": "충북", "충청남도": "충남", "전라북도": "전북", "전북특별자치도": "전북",
    "전라남도": "전남", "경상북도": "경북", "경상남도": "경남", "강원특별자치도": "강원",
    "제주특별자치도": "제주", "세종특별자치시": "세종",
}


def detect_regions(*texts) -> list[str]:
    """지역 표시 문자열이나 제목에서 시·도를 뽑는다. 못 찾거나 너무 많이 걸리면 빈 목록(전국).
    앞쪽 인자를 먼저 본다: 제목·기관에서 찾으면 그걸 쓰고, 없을 때만 뒤쪽(해시태그 등)을 본다."""
    for t in texts:
        text = str(t or "")
        for long, short in REGION_ALIASES.items():
            text = text.replace(long, short)
        text = re.sub(r"(서울|부산|대구|인천|광주|대전|울산)(특별시|광역시)", r"\1", text)
        if "전국" in text:
            return []
        found = [r for r in REGIONS if r in text]
        if len(found) >= 5:      # 지역 태그를 잔뜩 단 공고는 사실상 전국 대상
            return []
        if found:
            return found
    return []


def make_id(source: str, key: str) -> str:
    return source + ":" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


def clean(text) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


# ---------------------------------------------------------------- 수집처

def fetch_bizinfo(cfg: dict) -> list[dict]:
    key = os.environ.get("BIZINFO_API_KEY")
    if not key:
        print("[bizinfo] BIZINFO_API_KEY 없음 - 건너뜀")
        return []
    # 페이지를 넘기며 새 공고가 더 안 나올 때까지 모두 가져온다.
    rows, seen = [], set()
    for page in range(1, cfg.get("max_pages", 50) + 1):
        params = {
            "crtfcKey": key,
            "dataType": "json",
            "searchCnt": cfg.get("page_size", 100),
            "pageUnit": cfg.get("page_size", 100),
            "pageIndex": page,
        }
        url = "https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do?" + urllib.parse.urlencode(params)
        data = json.loads(http_get(url))
        batch = data.get("jsonArray") or data.get("items") or []
        fresh = [r for r in batch if (r.get("pblancId") or r.get("pblancNm")) not in seen]
        seen.update(r.get("pblancId") or r.get("pblancNm") for r in fresh)
        rows.extend(fresh)
        if not fresh:
            break
    items = []
    for r in rows:
        title = clean(r.get("pblancNm"))
        if not title:
            continue
        link = r.get("pblancUrl") or ""
        if link.startswith("/"):
            link = "https://www.bizinfo.go.kr" + link
        start, end = parse_period(r.get("reqstBeginEndDe"))
        items.append({
            "id": make_id("bizinfo", r.get("pblancId") or link or title),
            "source": "기업마당",
            "title": title,
            "org": clean(r.get("jrsdInsttNm") or r.get("excInsttNm")),
            "category": clean(r.get("pldirSportRealmLclasCodeNm")),
            "start": start,
            "end": end,
            "posted": parse_date(r.get("creatPnttm")),
            "url": link,
            "summary": clean(re.sub(r"<[^>]+>", " ", r.get("bsnsSumryCn") or ""))[:300],
            "target": clean(r.get("trgetNm")),
            "regions": detect_regions(title, r.get("jrsdInsttNm"), r.get("hashtags")),
            "age": "",
            "how": clean(re.sub(r"<[^>]+>", " ", r.get("reqstMthPapersCn") or ""))[:200],
            "contact": clean(r.get("refrncNm"))[:200],
        })
    print(f"[bizinfo] {len(items)}건")
    return items


def fetch_kstartup(cfg: dict) -> list[dict]:
    key = os.environ.get("DATA_GO_KR_KEY")
    if not key:
        print("[kstartup] DATA_GO_KR_KEY 없음 - 건너뜀")
        return []
    # 공공데이터포털 키는 Encoding(이미 %xx 로 바뀐 것)과 Decoding(+ / = 가 그대로인 것) 두 가지로
    # 발급된다. 어느 쪽을 넣어도 되도록 Decoding 키만 인코딩해서 붙인다.
    if "%" not in key:
        key = urllib.parse.quote(key, safe="")
    per_page = cfg.get("per_page", 200)
    rows = []
    for page in range(1, cfg.get("max_pages", 20) + 1):
        query = urllib.parse.urlencode({
            "page": page,
            "perPage": per_page,
            "returnType": "json",
            "cond[rcrt_prgs_yn::EQ]": "Y",
        })
        url = ("https://apis.data.go.kr/B552735/kisedKstartupService01/getAnnouncementInformation01"
               f"?serviceKey={key}&{query}")
        data = json.loads(http_get(url))
        batch = data.get("data") or []
        rows.extend(batch)
        total = data.get("totalCount") or data.get("matchCount")
        if len(batch) < per_page or (total and len(rows) >= int(total)):
            break
    items = []
    for r in rows:
        title = clean(r.get("biz_pbanc_nm") or r.get("intg_pbanc_biz_nm"))
        if not title:
            continue
        link = r.get("detl_pg_url") or ""
        items.append({
            "id": make_id("kstartup", str(r.get("pbanc_sn") or link or title)),
            "source": "K-Startup",
            "title": title,
            "org": clean(r.get("pbanc_ntrp_nm") or r.get("sprv_inst")),
            "category": clean(r.get("supt_biz_clsfc")),
            "start": parse_date(r.get("pbanc_rcpt_bgng_dt")),
            "end": parse_date(r.get("pbanc_rcpt_end_dt")),
            "posted": parse_date(r.get("pbanc_rcpt_bgng_dt")),
            "url": link,
            "summary": clean(r.get("pbanc_ctnt"))[:300],
            "target": clean(r.get("aply_trgt") or r.get("aply_trgt_ctnt"))[:200],
            "regions": detect_regions(title, r.get("supt_regin")),
            "age": clean(r.get("biz_enyy"))[:100],
            "how": "",
            "contact": clean(r.get("prch_cnpl_no") or r.get("biz_prch_dprt_nm"))[:200],
        })
    print(f"[kstartup] {len(items)}건")
    return items


def fetch_rss(feed: dict) -> list[dict]:
    name, url = feed.get("name", "RSS"), feed["url"]
    root = ET.fromstring(http_get(url))
    items = []
    for it in root.iter("item"):
        title = clean(it.findtext("title"))
        link = clean(it.findtext("link"))
        if not title:
            continue
        posted = it.findtext("pubDate")
        try:
            from email.utils import parsedate_to_datetime
            posted = parsedate_to_datetime(posted).date().isoformat() if posted else None
        except (TypeError, ValueError):
            posted = parse_date(posted)
        items.append({
            "id": make_id("rss-" + name, link or title),
            "source": name,
            "title": title,
            "org": feed.get("org", ""),
            "category": clean(it.findtext("category")),
            "start": None,
            "end": None,
            "posted": posted,
            "url": link,
            "summary": clean(re.sub(r"<[^>]+>", " ", it.findtext("description") or ""))[:300],
            "target": "",
            "regions": detect_regions(title, feed.get("region")),
            "age": "",
            "how": "",
            "contact": "",
        })
    print(f"[rss:{name}] {len(items)}건")
    return items


# ---------------------------------------------------------------- NTIS 국가R&D통합공고
# 부처별 R&D·비R&D 공고를 한곳에 모아 둔 공개 목록 페이지를 읽는다 (키 불필요).

NTIS_LIST = "https://www.ntis.go.kr/rndgate/eg/un/ra/mng.do"
DATE_RE = re.compile(r"(\d{4})[-./](\d{1,2})[-./](\d{1,2})")


class _RowParser(HTMLParser):
    """표의 각 <tr> 을 {cells: [...], links: [(href, onclick, text)]} 로 모은다."""

    def __init__(self):
        super().__init__()
        self.rows, self._row, self._cell, self._link = [], None, None, None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "tr":
            self._row = {"cells": [], "links": []}
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
        elif tag == "a" and self._row is not None:
            self._link = [a.get("href") or "", a.get("onclick") or "", []]

    def handle_endtag(self, tag):
        if tag == "a" and self._link is not None and self._row is not None:
            href, onclick, text = self._link
            self._row["links"].append((href, onclick, clean("".join(text))))
            self._link = None
        elif tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row["cells"].append(clean("".join(self._cell)))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row["cells"]:
                self.rows.append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)
        if self._link is not None:
            self._link[2].append(data)


def parse_ntis_rows(html: str) -> list[dict]:
    p = _RowParser()
    p.feed(html)
    items = []
    for row in p.rows:
        links = [l for l in row["links"] if len(l[2]) >= 6]
        if not links:
            continue
        href, onclick, title = max(links, key=lambda l: len(l[2]))
        status = next((c for c in row["cells"] if c in ("접수중", "접수예정", "마감", "접수마감")), "")
        dates = [d for c in row["cells"] for d in (parse_date("-".join(g)) for g in DATE_RE.findall(c)) if d]
        if not dates:
            continue
        org = next((c for c in row["cells"]
                    if c != title and len(c) <= 20 and re.search(r"(부|청|처|위원회|공사|재단|진흥원|연구원)$", c)), "")
        if href and not href.startswith(("#", "javascript")):
            url = urllib.parse.urljoin(NTIS_LIST, href)
        else:
            url = NTIS_LIST
        ids = re.findall(r"['\"]([A-Za-z0-9_-]{6,})['\"]", onclick + " " + href)
        if ids and url.endswith("/view.do"):
            url = f"{url}?roRndUid={ids[0]}"
        dates_sorted = sorted(set(dates))
        items.append({
            "title": title,
            "org": org,
            "posted": dates[0],
            "start": dates_sorted[-2] if len(dates_sorted) >= 2 else None,
            "end": dates_sorted[-1],
            "url": url,
            "key": ids[0] if ids else title,
            "status": status,
            "cells": row["cells"],
        })
    return items


NTIS_EXCEL = "https://www.ntis.go.kr/rndgate/eg/com/excel/download.do"


class _NtisForm(HTMLParser):
    """목록 화면의 검색 양식(id=rndMngForm) 기본값. '리스트 다운로드' 버튼이 이 값을 그대로 보낸다."""

    def __init__(self):
        super().__init__()
        self.inside, self.fields, self._sel, self._opt = False, [], None, None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "form":
            self.inside = a.get("id") == "rndMngForm"
        if not self.inside:
            return
        if tag == "input" and a.get("name"):
            if a.get("type") in ("checkbox", "radio") and "checked" not in a:
                return
            if a.get("type") not in ("button", "submit", "image"):
                self.fields.append((a["name"], a.get("value") or ""))
        elif tag == "select" and a.get("name"):
            self._sel, self._opt = a["name"], None
        elif tag == "option" and self._sel and (self._opt is None or "selected" in a):
            self._opt = a.get("value") or ""

    def handle_endtag(self, tag):
        if tag == "form":
            self.inside = False
        elif tag == "select" and self._sel:
            self.fields.append((self._sel, self._opt or ""))
            self._sel = None


def won_label(value) -> str:
    """공고금액(원) → '228.6억 원' / '5,000만 원'. 0·빈칸이면 ''."""
    try:
        n = int(float(str(value).replace(",", "")))
    except ValueError:
        return ""
    if n <= 0:
        return ""
    if n >= 100_000_000:
        return f"{n / 100_000_000:,.1f}".rstrip("0").rstrip(".") + "억 원"
    return f"{n // 10_000:,}만 원"


def parse_ntis_excel_rows(rows: list[list[str]]) -> list[dict]:
    """엑셀 행(첫 줄은 머리글) → 접수중·접수예정 공고."""
    if not rows:
        return []
    head = [h.strip() for h in rows[0]]
    col = {h: i for i, h in enumerate(head)}

    def cell(r, name):
        i = col.get(name)
        return clean(r[i]) if i is not None and i < len(r) else ""

    items = []
    for r in rows[1:]:
        status = cell(r, "현황")
        if status not in ("접수중", "접수예정"):
            continue
        title = cell(r, "공고명")
        if not title:
            continue
        no = cell(r, "순번").split(".")[0] or title
        url = cell(r, "공고문 바로가기(URL)")
        if not url.startswith("http"):
            url = NTIS_LIST
        org = " · ".join(x for x in [cell(r, "부처명"), cell(r, "공고기관명")] if x)
        items.append({
            "id": make_id("ntis", no),
            "source": "NTIS",
            "kind": "연구과제",
            "title": title,
            "org": org,
            "category": f"국가R&D · {status}",
            "start": parse_date(cell(r, "접수일")),
            "end": parse_date(cell(r, "마감일")),
            "posted": parse_date(cell(r, "공고일")),
            "url": url,
            "summary": "",
            "target": "",
            "regions": detect_regions(title),
            "age": "",
            "how": " · ".join(x for x in [cell(r, "형태"), cell(r, "공고유형")] if x and x != "-"),
            "contact": cell(r, "문의처"),
            "budget": won_label(cell(r, "공고금액")),
        })
    return items


def fetch_ntis_excel() -> list[dict]:
    """목록 화면의 '리스트 다운로드'(엑셀)를 한 번 받아 열린 공고만 고른다. 페이지를 넘기는 것보다 훨씬 빠르다."""
    import xlrd   # 옛 .xls 형식 (워크플로에서 pip 로 설치)
    from http.cookiejar import CookieJar

    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    opener.addheaders = [("User-Agent", BROWSER_UA)]
    form = _NtisForm()
    form.feed(opener.open(NTIS_LIST, timeout=90).read().decode("utf-8", "replace"))
    fields = [(k, v) for k, v in form.fields if k != "pageIndex"] + [("pageIndex", "1"), ("autoXsl", "ra")]
    req = urllib.request.Request(NTIS_EXCEL, data=urllib.parse.urlencode(fields).encode(), method="POST",
                                 headers={"Referer": NTIS_LIST, "Content-Type": "application/x-www-form-urlencoded"})
    body = opener.open(req, timeout=300).read()
    sheet = xlrd.open_workbook(file_contents=body).sheet_by_index(0)
    rows = [[str(c) for c in sheet.row_values(i)] for i in range(sheet.nrows)]
    items = parse_ntis_excel_rows(rows)
    print(f"[ntis] 엑셀 {sheet.nrows - 1}행 중 접수중·예정 {len(items)}건")
    return items


def fetch_ntis(cfg: dict) -> list[dict]:
    """엑셀로 먼저 받고, 안 되면 목록 화면을 넘기며 읽는다."""
    if cfg.get("excel", True):
        try:
            return fetch_ntis_excel()
        except Exception as e:  # noqa: BLE001
            print(f"[ntis] 엑셀 실패, 목록 화면으로 읽음: {e}", file=sys.stderr)
    return fetch_ntis_pages(cfg)


def fetch_ntis_pages(cfg: dict) -> list[dict]:
    """최근 등록순 목록을 넘기며 접수중·접수예정 공고를 모은다.

    마감된 공고만 나오는 페이지가 연달아 stop_after 번 나오면 멈춘다.
    중간 페이지가 끝내 안 열려도 그때까지 모은 공고는 버리지 않는다.
    """
    today = datetime.now(KST).date().isoformat()
    unit = cfg.get("page_unit", 50)
    items, seen, quiet = [], set(), 0
    for page in range(1, cfg.get("max_pages", 60) + 1):
        try:
            html = http_get(f"{NTIS_LIST}?pageIndex={page}&pageUnit={unit}&recordCountPerPage={unit}",
                            retries=3).decode("utf-8", "replace")
        except Exception as e:
            print(f"[ntis] {page}페이지 실패, 여기까지 모은 공고만 저장: {e}", file=sys.stderr)
            break
        rows = parse_ntis_rows(html)
        if page == 1:
            # 사이트 구조가 바뀌었을 때 원인을 찾기 쉽도록 로그에 남긴다
            print(f"[ntis] 1페이지 {len(html)}바이트, 행 {len(rows)}개")
            for r in rows[:2]:
                print("[ntis] 예시:", json.dumps(r, ensure_ascii=False)[:600])
            if not rows:
                i = html.find("<table")
                print("[ntis] 표를 찾지 못함. HTML 일부:", html[max(i, 0):max(i, 0) + 3000])
        fresh = [r for r in rows if r["key"] not in seen]
        if not fresh:
            break
        seen.update(r["key"] for r in fresh)
        open_rows = [r for r in fresh
                     if (r["status"] in ("접수중", "접수예정")) or (not r["status"] and r["end"] >= today)]
        quiet = 0 if open_rows else quiet + 1
        for r in open_rows:
            items.append({
                "id": make_id("ntis", r["key"]),
                "source": "NTIS",
                "kind": "연구과제",
                "title": r["title"],
                "org": r["org"],
                "category": "국가R&D" + (f" · {r['status']}" if r["status"] else ""),
                "start": r["start"],
                "end": r["end"],
                "posted": r["posted"],
                "url": r["url"],
                "summary": "",
                "target": "",
                "regions": detect_regions(r["title"]),
                "age": "",
                "how": "",
                "contact": "",
            })
        if quiet >= cfg.get("stop_after", 3):
            break
        time.sleep(cfg.get("delay", 0.5))   # 상대 서버에 부담을 주지 않도록 잠깐 쉰다
    print(f"[ntis] {len(items)}건 (접수중·예정), {page}페이지까지 확인")
    return items


# ---------------------------------------------------------------- IRIS 사업공고
# 범부처통합연구지원시스템(IRIS)의 공고 목록. NTIS 통합공고에 늦게 넘어가거나 안 넘어가는 공고가 있어서 따로 읽는다.
# 화면이 쓰는 목록 데이터 주소를 그대로 부르면 JSON 으로 온다 (키 불필요).

IRIS_BASE = "https://www.iris.go.kr"
IRIS_LIST = IRIS_BASE + "/contents/retrieveBsnsAncmBtinSituList.do"
IRIS_LIST_VIEW = IRIS_BASE + "/contents/retrieveBsnsAncmBtinSituListView.do"
IRIS_VIEW = IRIS_BASE + "/contents/retrieveBsnsAncmView.do"   # 상세 화면 (?ancmId=...&ancmPrg=...) — GET 으로 열리는 것 확인
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def http_post(url: str, data: dict, retries: int = 1) -> bytes:
    body = urllib.parse.urlencode(data).encode()
    for attempt in range(retries + 1):
        try:
            # IRIS 는 크롤러 이름으로 부르면 응답이 늦거나 끊긴다. 일반 브라우저처럼 부르고 넉넉히 기다린다.
            req = urllib.request.Request(url, data=body, method="POST", headers={
                "User-Agent": BROWSER_UA, "X-Requested-With": "XMLHttpRequest", "Referer": IRIS_LIST_VIEW})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read()
        except Exception:
            if attempt == retries:
                raise
            time.sleep(2 ** (attempt + 1))


def parse_iris(data: dict, prg: str = "ancmIng") -> list[dict]:
    """IRIS 목록 JSON 한 쪽을 공고 목록으로."""
    items = []
    for r in data.get("listBsnsAncmBtinSitu") or []:
        aid, title = str(r.get("ancmId") or ""), clean(r.get("ancmTl") or "")
        if not aid or not title:
            continue
        status = clean(r.get("rcveSttSeNmLst") or r.get("rcveStt") or "")
        ministry = clean(r.get("blngGovdSeNm") or "")
        items.append({
            "id": make_id("iris", aid),
            "source": "IRIS",
            "kind": "연구과제",
            "title": title,
            "org": " · ".join(x for x in [ministry, clean(r.get("sorgnNm") or "")] if x),
            "category": "국가R&D" + (f" · {status.replace('공고', '')}" if status else ""),
            "start": parse_date(r.get("rcveStrDe")),
            "end": parse_date(r.get("rcveEndDe")),
            "posted": parse_date(r.get("ancmDe")),
            "url": f"{IRIS_VIEW}?" + urllib.parse.urlencode({"ancmId": aid, "ancmPrg": prg}),
            "summary": "",
            "target": "",
            "regions": detect_regions(title),
            "age": "",
            "how": clean(r.get("pbofrTpSeNmLst") or ""),
            "contact": "",
        })
    return items


def fetch_iris(cfg: dict) -> list[dict]:
    """IRIS '공고 중'(ancmIng) 목록을 쪽마다 넘겨 모은다. (ancmPre 는 IRIS 가 모르는 값이라 응답이 오지 않는다)
    한 쪽이 안 열려도 그때까지 받은 것은 버리지 않는다. 어디서 막히는지 보이게 쪽마다 기록한다."""
    items, seen = [], set()
    for prg in cfg.get("progress", ["ancmIng"]):
        page, pages = 1, 1
        while page <= pages and page <= cfg.get("max_pages", 30):
            t0 = time.time()
            try:
                raw = http_post(IRIS_LIST, {"pageIndex": str(page), "pageUnit": "50", "ancmPrg": prg}, retries=1)
                data = json.loads(raw.decode("utf-8", "replace"))
            except Exception as e:  # noqa: BLE001
                print(f"[iris] {prg} {page}쪽 실패 ({time.time() - t0:.0f}초): {e}")
                break
            pages = int((data.get("paginationInfo") or {}).get("totalPageCount") or 1)
            got = parse_iris(data, prg)
            print(f"[iris] {prg} {page}/{pages}쪽 {len(got)}건 ({time.time() - t0:.1f}초)")
            for it in got:
                if it["id"] not in seen:
                    seen.add(it["id"])
                    items.append(it)
            page += 1
            time.sleep(cfg.get("delay", 0.3))
    print(f"[iris] {len(items)}건")
    if not items:
        raise RuntimeError("IRIS 공고를 하나도 받지 못함")
    return items


# ---------------------------------------------------------------- 병합

def match_keywords(item: dict, keywords: list[str]) -> list[str]:
    # 분류명(예: '국가R&D')은 모든 공고에 붙어 있어 빼고, 제목·요약·대상만 본다
    text = " ".join([item.get("title", ""), item.get("summary", ""), item.get("target", "")]).lower()
    return [k for k in keywords if k.lower() in text]


RND_RE = re.compile(r"R&D|R&amp;D|연구개발|기술개발|연구과제|과제\s*공모|원천기술|기초연구")

# 공공조달 관련 공고 분류 (제목 기준). 순서대로 보고, 걸리는 것을 모두 붙인다.
PROC_RULES = [
    ("우수제품", re.compile(r"우수조달|우수제품(?!\s*품질)")),       # '제주우수제품품질인증(JQ)' 같은 지역 품질인증은 뺀다
    ("혁신제품", re.compile(r"혁신제품|혁신시제품|혁신조달|혁신장터")),
    ("성능인증", re.compile(r"성능인증|(?<![A-Za-z])EPC(?![A-Za-z])")),
    ("NET·NEP", re.compile(r"(?<![A-Za-z.])NE[TP](?![A-Za-z])|신기술\s*인증|신제품\s*인증|신기술\(NET\)|신제품\(NEP\)")),
    ("녹색인증", re.compile(r"녹색\s*인증|녹색기술|녹색제품|환경표지")),
    ("GS인증", re.compile(r"GS\s*인증|굿소프트웨어")),
    ("조달·공공구매", re.compile(r"조달|공공\s*구매|우선\s*구매|구매\s*상담|벤처나라|나라장터|다수공급자|SMPP|공공\s*판로")),
]


def procurement_tags(title: str) -> list[str]:
    """공공조달 관련이면 분류 이름 목록, 아니면 빈 목록. 구체적인 분류가 있으면 '조달·공공구매'는 빼지 않고 같이 둔다."""
    return [name for name, rx in PROC_RULES if rx.search(title or "")]


def norm_title(title: str) -> str:
    """출처가 달라도 같은 공고를 알아보도록 앞머리 [기관] 표시와 기호·공백만 걷어낸 제목.
    (1차)·(분야명) 같은 괄호 내용은 서로 다른 공고를 가르는 경우가 많아 남긴다."""
    t = re.sub(r"^\s*(\[[^\]]*\]\s*)+", "", title or "")
    return re.sub(r"[^0-9A-Za-z가-힣]", "", t).lower()


def merge(old_items: list[dict], new_items: list[dict], cfg: dict, today: date) -> list[dict]:
    """기존 목록과 새로 수집한 목록을 합친다.

    - first_seen 은 처음 발견한 날짜를 유지한다 (NEW 표시용).
    - 마감 후 keep_expired_days 가 지난 공고는 지운다.
    """
    keywords = cfg.get("keywords", [])
    excludes = [k.lower() for k in cfg.get("exclude_keywords", [])]
    keep_days = cfg.get("keep_expired_days", 14)
    cutoff = (today - timedelta(days=keep_days)).isoformat()
    # 마감일이 없는(상시·예산 소진 시) 공고는 최근 open_ended_days 안에 올라온 것만 남긴다
    open_cutoff = (today - timedelta(days=cfg.get("open_ended_days", 120))).isoformat()
    today_s = today.isoformat()

    by_id = {it["id"]: it for it in old_items}
    old_by_title = {(it.get("source"), norm_title(it.get("title", ""))): it for it in old_items}
    for it in new_items:
        prev = by_id.get(it["id"])
        if prev is None:
            # 같은 출처·같은 제목인데 id 만 바뀐 경우(수집 방식이 바뀌면 생김) 예전 것을 지우고 처음 본 날을 잇는다
            prev = old_by_title.get((it.get("source"), norm_title(it.get("title", ""))))
            if prev is not None and prev["id"] in by_id:
                del by_id[prev["id"]]
        it["first_seen"] = prev.get("first_seen", today_s) if prev else today_s
        by_id[it["id"]] = it

    # IRIS 공고가 NTIS 에도 있으면(NTIS 엑셀의 바로가기 주소가 IRIS ancmId 를 가리킴) NTIS 쪽 하나만 남긴다.
    # NTIS 쪽에 문의처·공고금액이 더 있고, 바로가기는 어차피 IRIS 공고 페이지다.
    ntis_ancm = {}
    for it in by_id.values():
        m = re.search(r"iris\.go\.kr/.*[?&]ancmId=(\d+)", it.get("url") or "") if it.get("source") == "NTIS" else None
        if m:
            ntis_ancm[m.group(1)] = it
    for key in [k for k, it in by_id.items() if it.get("source") == "IRIS"]:
        m = re.search(r"[?&]ancmId=(\d+)", by_id[key].get("url") or "")
        if m and m.group(1) in ntis_ancm:
            twin = ntis_ancm[m.group(1)]
            twin.setdefault("also", [])
            if "IRIS" not in twin["also"]:
                twin["also"].append("IRIS")
            del by_id[key]

    result, by_title = [], {}
    for it in by_id.values():
        if it.get("end") and it["end"] < cutoff:
            continue
        if not it.get("end") and (it.get("posted") or it.get("first_seen") or today_s) < open_cutoff:
            continue
        if not it.get("kind"):
            it["kind"] = "연구과제" if RND_RE.search(it.get("title", "")) else "지원사업"
        nt = norm_title(it.get("title", ""))
        if nt and nt in by_title and by_title[nt].get("source") != it.get("source"):  # 다른 출처에 이미 있는 공고
            first = by_title[nt]
            first.setdefault("also", [])
            if it["source"] != first["source"] and it["source"] not in first["also"]:
                first["also"].append(it["source"])
            continue
        by_title[nt] = it
        if any(x in it.get("title", "").lower() for x in excludes):
            continue
        it["matched"] = match_keywords(it, keywords)
        proc = procurement_tags(it.get("title", ""))
        if proc:
            it["proc"] = proc
        else:
            it.pop("proc", None)
        result.append(it)

    result.sort(key=lambda x: (x.get("first_seen") or "", x.get("posted") or ""), reverse=True)
    return result


WEATHER_URL = ("https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.978"
               "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
               "&timezone=Asia%2FSeoul&forecast_days=2")


def save_weather() -> None:
    """서울 오늘·내일 예보를 data/weather.json 에 저장 (페이지가 직접 못 불러올 때 쓰는 예비본)."""
    try:
        data = json.loads(http_get(WEATHER_URL))
        data["fetched_at"] = datetime.now(KST).isoformat(timespec="seconds")
        (ROOT / "data" / "weather.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        print("[weather] 저장")
    except Exception as e:
        print(f"[weather] 실패: {e}", file=sys.stderr)


def main() -> int:
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    src = cfg.get("sources", {})
    save_weather()

    collected: list[dict] = []
    errors: list[str] = []
    jobs = []
    if src.get("bizinfo", {}).get("enabled", True):
        jobs.append(("bizinfo", lambda: fetch_bizinfo(src.get("bizinfo", {}))))
    if src.get("kstartup", {}).get("enabled", True):
        jobs.append(("kstartup", lambda: fetch_kstartup(src.get("kstartup", {}))))
    if src.get("ntis", {}).get("enabled", True):
        ntis_cfg = dict(src.get("ntis", {}))
        jobs.append(("ntis", lambda: fetch_ntis(ntis_cfg)))
    if src.get("iris", {}).get("enabled", True):
        iris_cfg = dict(src.get("iris", {}))
        jobs.append(("iris", lambda: fetch_iris(iris_cfg)))
    for feed in src.get("rss", []):
        jobs.append((f"rss:{feed.get('name')}", lambda feed=feed: fetch_rss(feed)))

    for name, job in jobs:
        try:
            collected.extend(job())
        except Exception as e:  # 한 곳이 실패해도 나머지는 계속 수집
            print(f"[{name}] 실패: {e}", file=sys.stderr)
            errors.append(f"{name}: {e}")

    old = {"items": []}
    if OUTPUT_PATH.exists():
        old = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
        if old.get("sample"):  # 처음 실제 수집 시 샘플 데이터는 버린다
            if not collected:
                print("수집된 공고가 없어 샘플 데이터를 그대로 둡니다.")
                return 0
            old = {"items": []}

    now = datetime.now(KST)
    items = merge(old.get("items", []), collected, cfg, now.date())
    out = {
        "updated_at": now.isoformat(timespec="seconds"),
        "keywords": cfg.get("keywords", []),
        "errors": errors,
        "items": items,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"총 {len(items)}건 저장 -> {OUTPUT_PATH.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
