import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import crawl  # noqa: E402


class ParseTest(unittest.TestCase):
    def test_parse_date(self):
        self.assertEqual(crawl.parse_date("20241031"), "2024-10-31")
        self.assertEqual(crawl.parse_date("2024.10.1 18:00"), "2024-10-01")
        self.assertEqual(crawl.parse_date("2024-02-30"), None)
        self.assertEqual(crawl.parse_date("상시"), None)

    def test_parse_period(self):
        self.assertEqual(crawl.parse_period("20241001 ~ 20241031"), ("2024-10-01", "2024-10-31"))
        self.assertEqual(crawl.parse_period("예산 소진시까지"), (None, None))


class RegionTest(unittest.TestCase):
    def test_detect_regions(self):
        self.assertEqual(crawl.detect_regions("#경기 #창업"), ["경기"])
        self.assertEqual(crawl.detect_regions("전라북도 경제통상진흥원"), ["전북"])
        self.assertEqual(crawl.detect_regions("전국"), [])
        self.assertEqual(crawl.detect_regions("중소벤처기업부", None), [])
        # 제목 표시가 해시태그보다 먼저
        self.assertEqual(crawl.detect_regions("[부산] 공공구매 페어", "부산광역시", "부산,서울"), ["부산"])
        # 기관명으로 판단
        self.assertEqual(crawl.detect_regions("2026년 기업유치 지원사업", "대구광역시", "서울,부산"), ["대구"])
        # 지역 태그가 잔뜩이면 전국
        self.assertEqual(crawl.detect_regions("지원사업", "중소벤처기업부", "서울,부산,대구,인천,광주,대전"), [])


class NtisParseTest(unittest.TestCase):
    def test_parse_rows(self):
        html = """<table><tr><th>번호</th><th>공고명</th></tr>
        <tr><td>1</td><td><a href="#" onclick="fn_view('AB12345678')">2026년 인공지능 핵심기술개발사업 신규과제 공고</a></td>
        <td>과학기술정보통신부</td><td>2026.10.01</td><td>2026-10-05</td><td>2026-11-04</td></tr></table>"""
        rows = crawl.parse_ntis_rows(html)
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r["org"], "과학기술정보통신부")
        self.assertEqual((r["posted"], r["start"], r["end"]), ("2026-10-01", "2026-10-05", "2026-11-04"))
        self.assertEqual(r["key"], "AB12345678")


class NtisRealShapeTest(unittest.TestCase):
    def test_status_and_link(self):
        html = """<table><tr><td></td><td>77149</td><td>접수예정</td>
        <td><a href="/rndgate/eg/un/ra/view.do" onclick="fn_view('1279968')">2026년 지역거점 AX 혁신 기술개발 사업 신규지원 대상과제 공고</a></td>
        <td>과학기술정보통신부</td><td>2026.10.26</td><td>2026.11.09</td><td>D-25</td></tr></table>"""
        r = crawl.parse_ntis_rows(html)[0]
        self.assertEqual(r["status"], "접수예정")
        self.assertEqual((r["start"], r["end"]), ("2026-10-26", "2026-11-09"))
        self.assertEqual(r["url"], "https://www.ntis.go.kr/rndgate/eg/un/ra/view.do?roRndUid=1279968")


class MergeTest(unittest.TestCase):
    cfg = {"keywords": ["AI"], "exclude_keywords": ["채용"], "keep_expired_days": 7}

    def test_first_seen_kept_and_expired_dropped(self):
        today = date(2026, 10, 15)
        old = [
            {"id": "a", "title": "AI 바우처", "first_seen": "2026-10-01", "end": "2026-10-30"},
            {"id": "b", "title": "지난 공고", "first_seen": "2026-09-01", "end": "2026-10-01"},
        ]
        new = [
            {"id": "a", "title": "AI 바우처 (수정)", "end": "2026-10-30"},
            {"id": "c", "title": "신규 공고", "end": None},
            {"id": "d", "title": "인턴 채용", "end": None},
        ]
        out = {it["id"]: it for it in crawl.merge(old, new, self.cfg, today)}
        self.assertEqual(set(out), {"a", "c"})
        self.assertEqual(out["a"]["first_seen"], "2026-10-01")
        self.assertEqual(out["a"]["title"], "AI 바우처 (수정)")
        self.assertEqual(out["a"]["matched"], ["AI"])
        self.assertEqual(out["c"]["first_seen"], "2026-10-15")

    def test_dedupe_and_kind(self):
        today = date(2026, 10, 15)
        new = [
            {"id": "x", "source": "기업마당", "title": "[중기부] 2026년 창업성장기술개발사업 공고"},
            {"id": "y", "source": "NTIS", "title": "2026년 창업성장기술개발사업 공고"},
        ]
        out = crawl.merge([], new, self.cfg, today)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["kind"], "연구과제")
        self.assertEqual(out[0]["also"], ["NTIS"])

    def test_drops_old_open_ended(self):
        new = [
            {"id": "o1", "source": "기업마당", "title": "상시 모집 A", "end": None, "posted": "2023-11-03"},
            {"id": "o2", "source": "기업마당", "title": "상시 모집 B", "end": None, "posted": "2026-09-01"},
        ]
        out = crawl.merge([], new, self.cfg, date(2026, 10, 15))
        self.assertEqual([i["id"] for i in out], ["o2"])

    def test_keeps_same_source_variants(self):
        new = [
            {"id": "p", "source": "NTIS", "title": "2026년 OO사업 신규과제 공고(1차)"},
            {"id": "q", "source": "NTIS", "title": "2026년 OO사업 신규과제 공고(2차)"},
            {"id": "r", "source": "NTIS", "title": "2026년 OO사업 신규과제 공고(1차)"},
        ]
        out = crawl.merge([], new, self.cfg, date(2026, 10, 15))
        self.assertEqual(len(out), 3)



class IrisTest(unittest.TestCase):
    SAMPLE = {"listBsnsAncmBtinSitu": [{
        "ancmId": "024477", "sorgnId": "10001", "rcveStrDe": "2026.10.16", "rcveEndDe": "2026.11.17", "dDay": 28,
        "sorgnNm": "한국연구재단", "ancmTl": "2026년 한미 이공분야 학생인력교류 프로그램(NSF IRES) 운영지원사업 신규과제 공모",
        "ancmNo": "과학기술정보통신부 공고 제2026-1007호", "blngGovdSeNm": "과학기술정보통신부", "ancmDe": "2026-10-16",
        "pbofrTpSeNmLst": "자유공모", "rcveSttSeNmLst": "공고접수중", "rcveStt": "진행중"}],
        "paginationInfo": {"totalPageCount": 2}}

    def test_parse(self):
        [it] = crawl.parse_iris(self.SAMPLE)
        self.assertEqual(it["source"], "IRIS")
        self.assertEqual(it["kind"], "연구과제")
        self.assertEqual((it["start"], it["end"], it["posted"]), ("2026-10-16", "2026-11-17", "2026-10-16"))
        self.assertEqual(it["org"], "과학기술정보통신부 · 한국연구재단")
        self.assertEqual(it["category"], "국가R&D · 접수중")
        self.assertIn("ancmId=024477", it["url"])


class NtisExcelTest(unittest.TestCase):
    HEAD = ["순번", "현황", "형태", "부처명", "공고명", "접수일", "마감일", "접수마감시간", "공고일", "공고기관명",
            "문의처", "공고문 바로가기(URL)", "공고유형", "공고금액", "공고사업명"]
    ROWS = [
        HEAD,
        ["77157.0", "마감", "통합공고", "과학기술정보통신부", "마감된 공고", "2026.09.11", "2026.10.11", "23:59",
         "2026.10.13", "연구개발특구진흥재단", "033-650-3411", "https://www.iris.go.kr/x", "본공고", "8626000000", "-"],
        ["77156.0", "접수예정", "통합공고", "과학기술정보통신부",
         "2026년 지역거점 AX 혁신 기술개발 사업 신규지원 대상과제 공고(표준모델 AX RD)", "2026.10.26", "2026.11.09", "17:00",
         "2026.10.08", "정보통신산업진흥원", "053-215-3607",
         "https://www.iris.go.kr/contents/retrieveBsnsAncmView.do?ancmId=024397&bsnsYyDetail=2026", "본공고",
         "228600000000", "지역거점AX혁신기술개발(R&D)"],
        ["77155.0", "접수중", "통합공고", "산업통상부", "2027년도 제품안전관리기술개발및실증사업 기술수요조사 공고",
         "2026.10.08", "2026.11.06", "23:59", "2026.10.08", "한국산업기술기획평가원", "1544-6633",
         "https://srome.keit.re.kr/x", "수요조사", "0", "관련정보없음"],
    ]

    def test_only_open_rows_with_contact_and_budget(self):
        items = crawl.parse_ntis_excel_rows(self.ROWS)
        self.assertEqual([i["category"] for i in items], ["국가R&D · 접수예정", "국가R&D · 접수중"])
        ax = items[0]
        self.assertEqual((ax["start"], ax["end"], ax["posted"]), ("2026-10-26", "2026-11-09", "2026-10-08"))
        self.assertEqual(ax["org"], "과학기술정보통신부 · 정보통신산업진흥원")
        self.assertEqual(ax["contact"], "053-215-3607")
        self.assertEqual(ax["budget"], "2,286억 원")
        self.assertIn("ancmId=024397", ax["url"])
        self.assertEqual(items[1]["budget"], "")

    def test_won_label(self):
        self.assertEqual(crawl.won_label("50000000"), "5,000만 원")
        self.assertEqual(crawl.won_label("150000000"), "1.5억 원")
        self.assertEqual(crawl.won_label("-"), "")


class MergeSourcesTest(unittest.TestCase):
    CFG = {"keywords": [], "keep_expired_days": 14}

    def test_changed_id_keeps_first_seen_and_iris_twin_dropped(self):
        old = [{"id": "ntis:old", "source": "NTIS", "kind": "연구과제", "title": "AX 사업 공고",
                "end": "2026-11-09", "first_seen": "2026-10-15"}]
        new = [
            {"id": "ntis:77156", "source": "NTIS", "kind": "연구과제", "title": "AX 사업 공고", "end": "2026-11-09",
             "url": "https://www.iris.go.kr/contents/retrieveBsnsAncmView.do?ancmId=024397&x=1"},
            {"id": "iris:024397", "source": "IRIS", "kind": "연구과제", "title": "AX 사업 공고 (IRIS)", "end": "2026-11-09",
             "url": "https://www.iris.go.kr/contents/retrieveBsnsAncmView.do?ancmId=024397&ancmPrg=ancmIng"},
            {"id": "iris:024477", "source": "IRIS", "kind": "연구과제", "title": "NSF IRES", "end": "2026-11-17",
             "url": "https://www.iris.go.kr/contents/retrieveBsnsAncmView.do?ancmId=024477&ancmPrg=ancmIng"},
        ]
        out = crawl.merge(old, new, self.CFG, date(2026, 10, 20))
        ids = sorted(i["id"] for i in out)
        self.assertEqual(ids, ["iris:024477", "ntis:77156"])
        ntis = next(i for i in out if i["id"] == "ntis:77156")
        self.assertEqual(ntis["first_seen"], "2026-10-15")      # 예전에 본 날 유지 → NEW 로 다시 뜨지 않음
        self.assertEqual(ntis["also"], ["IRIS"])

if __name__ == "__main__":
    unittest.main()
