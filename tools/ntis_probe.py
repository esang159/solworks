"""NTIS 과제검색 OpenAPI 가 실제로 무엇을 돌려주는지 확인한다 (수동 실행용).

키는 NTIS_API_KEY 시크릿이 있으면 그것을, 없으면 NTIS 안내에 나온 테스트 키를 쓴다.
응답 XML 을 그대로 찍고, 결과마다 필드 이름과 값을 정리해서 보여준다.
"""
from __future__ import annotations

import os
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

URL = "https://www.ntis.go.kr/rndopen/openApi/public_project"


def call(key: str, query: str, count: int = 3, sort: str = "") -> str:
    params = {"apprvKey": key, "query": query, "userId": "", "collection": "project", "searchField": "",
              "displayCount": count, "startPosition": 1, "naviCount": 30, "sortby": sort,
              "boostquery": "", "addQuery": ""}
    req = urllib.request.Request(URL + "?" + urllib.parse.urlencode(params), headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def main() -> int:
    key = os.environ.get("NTIS_API_KEY") or "DEV_TEST_APPRV_KEY"
    print("[probe] 키:", "시크릿 NTIS_API_KEY" if os.environ.get("NTIS_API_KEY") else "안내용 테스트 키")
    for query, sort in [("인공지능", ""), ("인공지능", "DATE/DESC")]:
        print(f"\n===== 검색어: {query} / 정렬: {sort or '기본'} =====")
        try:
            raw = call(key, query, 3, sort)
        except Exception as e:  # noqa: BLE001
            print("[probe] 호출 실패:", e)
            continue
        print("[probe] 응답 앞부분 원문:\n" + raw[:3000])
        try:
            root = ET.fromstring(raw)
        except ET.ParseError as e:
            print("[probe] XML 아님:", e)
            continue
        hits = root.findall(".//HIT") or root.findall(".//hit") or root.findall(".//item")
        print(f"\n[probe] 결과 {len(hits)}건, 필드 정리:")
        for i, h in enumerate(hits, 1):
            print(f"--- {i} ---")
            for el in h.iter():
                if el is h:
                    continue
                v = (el.text or "").strip()
                print(f"  {el.tag}: {v[:120]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
