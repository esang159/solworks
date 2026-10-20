"""NTIS 국가R&D통합공고 '리스트 다운로드'(엑셀)를 실제로 받아 모양을 확인한다 (수동 실행용).

목록 화면의 검색 양식(rndMngForm)에 들어 있는 값을 그대로 모아 /rndgate/eg/com/excel/download.do 로 보낸다
(화면의 fn_search('', 'Y') 와 같은 동작).
"""
from __future__ import annotations

import io
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from html.parser import HTMLParser
from http.cookiejar import CookieJar

LIST = "https://www.ntis.go.kr/rndgate/eg/un/ra/mng.do"
DOWN = "https://www.ntis.go.kr/rndgate/eg/com/excel/download.do"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


class FormFields(HTMLParser):
    """id=rndMngForm 안의 input/select 기본값을 모은다 (체크 안 된 체크박스는 뺀다)."""

    def __init__(self):
        super().__init__()
        self.inside, self.fields, self._sel, self._opt_first = False, [], None, None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "form":
            self.inside = a.get("id") == "rndMngForm"
        if not self.inside:
            return
        if tag == "input" and a.get("name"):
            if a.get("type") in ("checkbox", "radio") and "checked" not in a:
                return
            if a.get("type") in ("button", "submit", "image"):
                return
            self.fields.append((a["name"], a.get("value") or ""))
        elif tag == "select" and a.get("name"):
            self._sel, self._opt_first = a["name"], None
        elif tag == "option" and self._sel:
            if self._opt_first is None or "selected" in a:
                self._opt_first = a.get("value") or ""

    def handle_endtag(self, tag):
        if tag == "form":
            self.inside = False
        if tag == "select" and self._sel:
            self.fields.append((self._sel, self._opt_first or ""))
            self._sel = None


def main() -> int:
    jar = CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [("User-Agent", UA)]
    t0 = time.time()
    html = opener.open(LIST, timeout=90).read().decode("utf-8", "replace")
    p = FormFields()
    p.feed(html)
    fields = [(k, v) for k, v in p.fields if k not in ("pageIndex",)] + [("pageIndex", "1"), ("autoXsl", "ra")]
    print(f"[excel] 양식 필드 {len(fields)}개:", [k for k, _ in fields])
    req = urllib.request.Request(DOWN, data=urllib.parse.urlencode(fields).encode(), method="POST",
                                 headers={"Referer": LIST, "Content-Type": "application/x-www-form-urlencoded"})
    with opener.open(req, timeout=300) as r:
        body = r.read()
        print(f"[excel] 응답 {r.status}, {len(body):,}바이트, {time.time() - t0:.1f}초")
        print("[excel] 헤더:", {k: v for k, v in r.headers.items() if k.lower() in ("content-type", "content-disposition")})
    print("[excel] 앞부분:", body[:300])

    rows = []
    if body[:2] == b"PK":   # xlsx
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(body), read_only=True)
        ws = wb.active
        rows = [[("" if c is None else str(c)) for c in row] for row in ws.iter_rows(values_only=True)]
    elif body[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":   # 옛 xls
        import xlrd
        sh = xlrd.open_workbook(file_contents=body).sheet_by_index(0)
        rows = [[str(c) for c in sh.row_values(i)] for i in range(sh.nrows)]
    else:   # HTML 표로 오는 경우
        text = body.decode("utf-8", "replace")
        rows = [re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S) for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", text, re.S)]
        rows = [[re.sub(r"<[^>]+>|\s+", " ", c).strip() for c in r] for r in rows if r]
    print(f"[excel] 행 {len(rows)}개")
    for r in rows[:4]:
        print("   ", r)
    if rows:
        head = rows[0]
        idx = next((i for i, h in enumerate(head) if "현황" in h), 1)
        print("[excel] 현황별:", Counter(r[idx] for r in rows[1:] if len(r) > idx))
        opens = [r for r in rows[1:] if len(r) > idx and r[idx] in ("접수중", "접수예정")]
        print(f"[excel] 접수중·예정 {len(opens)}건")
        for r in opens:
            if any(w in " ".join(r) for w in ("IRES", "학생인력교류")):
                print("   IRES:", r)
    return 0


if __name__ == "__main__":
    sys.exit(main())
