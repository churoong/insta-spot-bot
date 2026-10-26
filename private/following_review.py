"""팔로잉 중 '외국 계정으로 보이는' 후보를 뽑아 사용자 확인용 CSV로 쓴다. 언팔은 하지 않는다.
    python private/following_review.py            # → private/state/unfollow-candidates.csv
사용자가 CSV를 보고 끊을 줄만 private/state/unfollow-approved.txt로 옮기면(첫 칸 user_id),
에이전트가 하루 30명까지 천천히 언팔한다.

판별은 추측이다 — 인스타는 계정 국가를 알려주지 않는다. 그래서 확신 단계를 나눠 적는다:
  strong: 이름·소개에 한글이 없고 다른 문자(데바나가리·태국·아랍·키릴·한자/가나 등)가 있음,
          또는 공개 전화 국가번호가 82가 아님
  weak:   이름·소개에 한글이 없고 영문뿐(한국인도 영문 이름을 많이 써서 오판 가능)
"""
from __future__ import annotations

import csv
import re

from common import STATE, client, get_logger, nap

log = get_logger("following")
HANGUL = re.compile(r"[가-힣ㄱ-ㆎ]")
OTHER = re.compile(r"[ऀ-ॿ฀-๿؀-ۿЀ-ӿ぀-ヿ一-鿿ঀ-৿ក-៿ༀ-࿿]")
MAX_INFO = 400  # 상세 조회 상한(한 번 실행당) — 넘치면 다음 실행에서 이어 본다


def main():
    c = client(interactive=False)
    following = c.user_following(str(c.user_id), amount=0)
    log.info(f"팔로잉 {len(following)}명")
    rows, looked = [], 0
    for uid, u in following.items():
        name = f"{u.full_name or ''} {u.username or ''}"
        if HANGUL.search(u.full_name or ""):
            continue
        reason, conf = "", ""
        bio, phone_cc = "", ""
        if looked < MAX_INFO:
            try:
                info = c.user_info(uid)
                bio = (info.biography or "").replace("\n", " ")
                phone_cc = str(info.public_phone_country_code or "")
                looked += 1
            except Exception as e:
                log.warning(f"상세 조회 실패 @{u.username}: {str(e)[:100]}")
                if "Challenge" in type(e).__name__ or "PleaseWait" in type(e).__name__:
                    break
            nap(3, 8)
        if HANGUL.search(bio):
            continue
        if phone_cc and phone_cc != "82":
            reason, conf = f"전화 국가번호 +{phone_cc}", "strong"
        elif OTHER.search(name + bio):
            reason, conf = "한글 없음 + 외국 문자", "strong"
        elif phone_cc == "82":
            continue
        else:
            reason, conf = "한글 없음(영문뿐)" + ("" if looked <= MAX_INFO else ", 소개 미확인"), "weak"
        rows.append({"user_id": uid, "username": u.username, "full_name": u.full_name, "confidence": conf, "reason": reason, "bio": bio[:80]})
    out = STATE / "unfollow-candidates.csv"
    with out.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["user_id", "username", "full_name", "confidence", "reason", "bio"])
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: r["confidence"] != "strong"))
    strong = sum(r["confidence"] == "strong" for r in rows)
    log.info(f"후보 {len(rows)}명(strong {strong} · weak {len(rows) - strong}) → {out}")


if __name__ == "__main__":
    main()
