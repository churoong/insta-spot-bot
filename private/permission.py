"""허락받은 남의 맛집 사진·영상 소개(2026-11-07 사용자 결정).

허락 없이 남의 콘텐츠를 쓰지 않는다(저작권). 대신:
  ask_permissions   맛집 태그 인기 게시물(사진·영상, 위치 태그 있음, 좋아요 300+, 광고 아님) 작성자에게
                    "출처 표기하고 소개해도 될까요?" DM — 하루 6명, 한 사람 90일 1회
  handle_reply      answer_dms가 넘겨 주는 답장 — 분명한 수락만 granted, 거절은 denied, 애매하면 아무것도 안 함
  publish_granted   수락받은 게시물을 하루 1개, 작성자 태그 + 위치 태그 + 출처 문구로 올리고 감사 DM

상태: private_log `perm:<media_pk>`(JSON: uid·username·code·type·location·status·asked_at), `perm-u:<uid>`(→ media_pk).
문구는 식당에 긍정만, 방문을 지어내지 않는다.
"""
from __future__ import annotations

import json
import random
import re
import tempfile
import time
from pathlib import Path

from common import get_logger, llm, nap, now_kst, state_get, state_set

log = get_logger("agent")

ASK_PER_DAY = 6
POST_PER_DAY = 1
MIN_LIKES = 300
MAX_AGE_DAYS = 14
ASK_TAGS = ["맛집", "맛집추천", "맛집탐방", "먹스타그램", "노포맛집", "국밥맛집", "서울맛집", "부산맛집", "해장국", "순대국", "냉면맛집", "짬뽕맛집"]

ASK_TEXT = ("안녕하세요! 전국 맛집을 소개하는 계정 맛디깅이에요 🙌 올려주신 {place} {kind} 너무 좋아서요. "
            "출처(@{username}) 태그하고 저희 계정에 한 번 소개해도 괜찮을까요? 괜찮으시면 '네'라고 답 주세요. "
            "어려우시면 편하게 말씀 주셔도 돼요!")
YES = re.compile(r"^\s*(네|넵|넹|예|응|ㅇㅇ|ㅇㅋ|오케이|ok|okay|yes|좋아요|좋습니다|좋죠|괜찮아요|괜찮습니다|가능|물론|그럼요|당연|그러세요|하세요|올려주세요|써주세요|사용하셔도)", re.I)
NO = re.compile(r"안\s?돼|안됩|어렵|어려|싫|거절|아니요|아뇨|노노|\bno\b|곤란|불가|안\s?할|사양", re.I)


def today() -> str:
    return f"{now_kst():%Y-%m-%d}"


def _count(key: str) -> int:
    return int(state_get(f"{key}:{today()}") or 0)


def _bump(key: str):
    state_set(f"{key}:{today()}", str(_count(key) + 1))


def _get(pk) -> dict | None:
    v = state_get(f"perm:{pk}")
    return json.loads(v) if v else None


def _put(pk, rec: dict):
    state_set(f"perm:{pk}", json.dumps(rec, ensure_ascii=False))


def _blocked(e: Exception) -> bool:
    return any(k in type(e).__name__ for k in ("Challenge", "PleaseWait", "Feedback", "LoginRequired", "Checkpoint"))


def ask_permissions(c):
    import engage

    if _count("permask") >= ASK_PER_DAY or not engage._slot_passed("permask"):
        return
    me = str(c.user_id)
    for tag in random.sample(ASK_TAGS, 3):
        if _count("permask") >= ASK_PER_DAY:
            break
        try:
            medias = c.hashtag_medias_top(tag, amount=12)
        except Exception as e:
            if _blocked(e):
                raise
            continue
        for m in medias:
            if _count("permask") >= ASK_PER_DAY:
                break
            uid, pk = str(m.user.pk), str(m.pk)
            cap = (m.caption_text or "").strip()
            if uid == me or m.media_type not in (1, 2) or (m.like_count or 0) < MIN_LIKES:
                continue
            if time.time() - m.taken_at.timestamp() > MAX_AGE_DAYS * 86400 or engage.AD_RE.search(cap):
                continue
            loc = getattr(m, "location", None)
            if not loc or not getattr(loc, "name", "") or not engage._is_food_review(cap):
                continue
            if not re.search(r"[가-힣]", f"{m.user.full_name or ''}") or _get(pk):
                continue
            last = state_get(f"perm-u:{uid}")
            if last and _get(last) and time.time() - float(_get(last).get("asked_at", 0)) < 90 * 86400:
                continue
            kind = "영상" if m.media_type == 2 else "사진"
            try:
                c.direct_send(ASK_TEXT.format(place=loc.name, kind=kind + "이", username=m.user.username), user_ids=[int(uid)])
            except Exception as e:
                if _blocked(e):
                    raise
                log.warning(f"허락 요청 DM 실패 @{m.user.username}: {str(e)[:100]}")
                continue
            _put(pk, {"uid": uid, "username": m.user.username, "code": m.code, "type": m.media_type,
                      "location": loc.name, "caption": cap[:600], "status": "asked", "asked_at": time.time()})
            state_set(f"perm-u:{uid}", pk)
            _bump("permask")
            log.info(f"🙏 소개 허락 요청: @{m.user.username} · {loc.name} ({kind}, 좋아요 {m.like_count})")
            nap(120, 300)
        nap(20, 60)


def handle_reply(c, uid: str, text: str, thread_id) -> bool:
    """허락 요청에 대한 답장이면 처리하고 True. (answer_dms의 다른 응답이 끼어들지 않게)"""
    pk = state_get(f"perm-u:{uid}")
    rec = _get(pk) if pk else None
    if not rec or rec.get("status") != "asked":
        return False
    t = (text or "").strip()
    if NO.search(t):
        rec["status"] = "denied"
        _put(pk, rec)
        c.direct_send("말씀 감사해요! 앞으로도 좋은 맛집 기록 응원할게요 😊", thread_ids=[int(thread_id)])
        log.info(f"🙅 소개 거절: @{rec['username']}")
    elif YES.search(t) and "?" not in t and "？" not in t:  # "네? 어디서요" 같은 되물음은 수락이 아니다
        rec["status"] = "granted"
        rec["granted_at"] = time.time()
        _put(pk, rec)
        c.direct_send("감사합니다! 올리면 태그해서 알려드릴게요 🙏", thread_ids=[int(thread_id)])
        log.info(f"🙆 소개 허락: @{rec['username']} · {rec['location']}")
    else:
        log.info(f"❔ 허락 답장이 애매해 보류: @{rec['username']}: {t[:40]}")
    return True


def _caption(rec: dict) -> str:
    body = llm(
        "아래는 다른 사람이 올린 맛집 게시물 글이다. 이 가게를 소개하는 인스타 캡션 본문 2~3줄을 존댓말로 써라. "
        "원문에 있는 사실(메뉴·분위기·위치)만 쓰고 지어내지 말 것. 우리가 직접 가 봤다고 말하지 말 것. "
        "식당·음식은 긍정적으로만(단점·비교·호불호 금지). 해시태그·링크·팔로우 요청 금지. 본문만 출력.\n원문: " + rec.get("caption", ""), 220) or ""
    body = re.sub(r"#\S+|https?://\S+", "", body).strip()
    region = re.sub(r"\s.*", "", rec["location"])[:8]
    return (f"📸 @{rec['username']} 님이 흔쾌히 허락해 주셔서 소개해요\n\n"
            f"📍 {rec['location']}\n{body}\n\n"
            f"원본은 @{rec['username']} 님 계정에서 확인해 보세요 🙏\n\n#맛집추천 #{region}맛집 #맛디깅")


def publish_granted(c):
    import engage
    from instagrapi.types import UserShort, Usertag

    if _count("permpost") >= POST_PER_DAY or not engage._slot_passed("permpost"):
        return
    from common import db
    rows = db("SELECT key, value FROM private_log WHERE key LIKE 'perm:%' AND value LIKE '%\"granted\"%' ORDER BY updated_at")["rows"]
    for r in rows:
        pk, rec = r["key"].split(":", 1)[1], json.loads(r["value"])
        if rec.get("status") != "granted":
            continue
        try:
            info = c.media_info(pk)
        except Exception as e:
            if _blocked(e):
                raise
            rec["status"] = "gone"
            _put(pk, rec)
            continue
        tmp = Path(tempfile.mkdtemp())
        try:
            caption = _caption(rec)
            tags = [Usertag(user=UserShort(pk=rec["uid"], username=rec["username"]), x=0.5, y=0.5)]
            loc = getattr(info, "location", None)
            if rec["type"] == 2:
                path = c.clip_download(pk, folder=tmp)
                media = c.clip_upload(path, caption, usertags=tags, location=loc)
            else:
                path = c.photo_download(pk, folder=tmp)
                media = c.photo_upload(path, caption, usertags=tags, location=loc)
        except Exception as e:
            if _blocked(e):
                raise
            log.warning(f"허락 게시 실패 @{rec['username']}: {type(e).__name__} {str(e)[:120]}")
            rec["fail"] = int(rec.get("fail", 0)) + 1
            if rec["fail"] >= 3:
                rec["status"] = "failed"
            _put(pk, rec)
            return
        rec["status"] = "posted"
        rec["our_code"] = media.code
        rec["posted_at"] = time.time()
        _put(pk, rec)
        _bump("permpost")
        log.info(f"📸 허락받은 소개 게시: https://www.instagram.com/p/{media.code}/ (원본 @{rec['username']})")
        try:
            nap(30, 90)
            c.direct_send(f"소개 글 올렸어요! 허락해 주셔서 정말 감사해요 🙏 https://www.instagram.com/p/{media.code}/",
                          user_ids=[int(rec["uid"])])
        except Exception as e:
            if _blocked(e):
                raise
        return
