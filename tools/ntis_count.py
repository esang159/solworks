"""NTIS 국가R&D통합공고를 끝까지 읽어 접수 중·예정 공고가 실제로 몇 건인지 센다 (수동 실행용).

매일 수집은 최신 공고부터 넘기다 열린 공고가 한동안 안 나오면 멈춘다. 그 방식이 빠뜨리는 게 없는지 확인하고,
목록 화면의 검색 양식(상태 필터)과 엑셀 다운로드가 어떤 주소로 가는지도 찍는다.
"""
from __future__ import annotations

import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "crawler"))
import crawl  # noqa: E402

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}


def get(url: str, tries: int = 3) -> str:
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            print(f"  ! {e} ({i + 1}/{tries})")
            time.sleep(3 * (i + 1))
    return ""


def form_info() -> None:
    html = get(crawl.NTIS_LIST)
    print("===== 목록 화면 검색 양식 =====")
    for m in re.finditer(r"<(select|input)[^>]*name=\"([^\"]+)\"[^>]*>", html):
        print("  필드:", m.group(1), m.group(2))
    for m in re.finditer(r"<select[^>]*name=\"([^\"]+)\"[^>]*>(.*?)</select>", html, re.S):
        opts = re.findall(r"<option[^>]*value=\"([^\"]*)\"[^>]*>([^<]*)<", m.group(2))
        print(f"  선택 {m.group(1)}:", opts[:15])
    for m in re.finditer(r"(?i)(excel|xls|down)[^\n]{0,200}", html):
        s = re.sub(r"\s+", " ", m.group(0))
        if "function" in s or ".do" in s or "onclick" in s:
            print("  다운로드 단서:", s[:220])


def full_scan(unit: int) -> None:
    print(f"\n===== 전체 읽기 (한 쪽 {unit}건) =====")
    t0 = time.time()
    status, open_rows, total, page, last_open_page = Counter(), [], 0, 0, 0
    while True:
        page += 1
        html = get(f"{crawl.NTIS_LIST}?pageIndex={page}&pageUnit={unit}&recordCountPerPage={unit}")
        rows = crawl.parse_ntis_rows(html) if html else []
        if not rows:
            print(f"  {page}쪽에서 끝 (행 없음)")
            break
        total += len(rows)
        for r in rows:
            status[r["status"] or "(빈칸)"] += 1
            if r["status"] in ("접수중", "접수예정"):
                open_rows.append((page, r))
                last_open_page = page
        if page % 20 == 0:
            print(f"  {page}쪽까지 {total}건, 열린 공고 {len(open_rows)}건, {time.time() - t0:.0f}초")
        if page >= 400:
            break
    print(f"총 {total}건 / {page - 1}쪽 / {time.time() - t0:.0f}초")
    print("상태별:", dict(status))
    print(f"접수중·예정 {len(open_rows)}건, 마지막으로 나온 쪽: {last_open_page}")
    by_page = Counter(p for p, _ in open_rows)
    print("쪽별 열린 공고 수:", sorted(by_page.items()))
    for p, r in open_rows:
        if p > 7:
            print(f"  뒤쪽({p}쪽) 열린 공고: {r['status']} {r['start']}~{r['end']} {r['title'][:60]}")


if __name__ == "__main__":
    form_info()
    full_scan(int(sys.argv[1]) if len(sys.argv) > 1 else 100)
