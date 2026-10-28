"""계정 활동 2차(2026-10-27 사용자 결정 "모두 진행") — 대상을 좁혀 반응이 돌아올 사람에게만.

  visited_engage        우리가 소개한 식당의 인스타 장소 피드 → 최근 방문 게시물에 좋아요 + 긍정 댓글
  daily_note            DM함 맨 위 '노트'(60자)에 오늘 편 예고 / 방금 올라온 편
  story_views           음식 태그 작성자들의 스토리 보기(+ 일부 좋아요)
  welcome_dm            새 팔로워에게 "동네 알려주시면 근처 맛집 보내드려요"
  answer_dms            DM에 동네·음식이 오면 근처 맛집 5곳(우리가 소개한 집 우선) 답장
  dm_commenters         우리 게시물 댓글에 지역이 나오면 그 지역 리스트를 DM으로
  peer_follower_likes   팔로워 1천~1만 맛집 큐레이션 계정의 최근 팔로워 게시물에 좋아요

모든 문구는 식당에 긍정만(CLAUDE.md 절대 규칙). 링크는 카카오맵 검색 링크만, 홍보·팔로우 요청 없음.
하루 상한은 각 함수 상단 상수. 차단 신호면 예외를 올려 agent.growth_round가 전부 멈춘다.
"""
from __future__ import annotations

import json
import math
import random
import re
import time
from datetime import timedelta
from urllib.parse import quote

import requests

from common import ENV, db, get_logger, ig_handle, like_too, llm, nap, now_kst, online_slot, state_get, state_set

log = get_logger("agent")
VISITED_LIKES, VISITED_COMMENTS = 40, 12  # 2026-10-28 확대(15·5 → 25·8 → 40·12, 사용자: 식당 좋아요·댓글이 너무 적다)
STORY_USERS_PER_DAY, STORY_LIKES_PER_DAY, STORY_USERS_PER_ROUND = 150, 10, 30
WELCOME_PER_DAY = 20
COMMENTER_DM_PER_DAY = 10
PEER_LIKES_PER_DAY = 25  # 2026-10-28 확대(15 → 25)
REGION_HINT = re.compile(r"([가-힣]{1,6}(?:역|동|구|시|군|읍|면|시장|거리|길))|(서울|부산|대구|인천|광주|대전|울산|세종|제주|강릉|전주|경주|여수|춘천|수원|창원|포항|원주|천안|청주)")
BLOCK = ("Challenge", "PleaseWait", "Feedback", "LoginRequired", "Checkpoint")


def today() -> str:
    return f"{now_kst():%Y-%m-%d}"


def _blocked(e: Exception) -> bool:
    return any(k in type(e).__name__ for k in BLOCK)


def _count(key: str) -> int:
    return int(state_get(f"{key}:{today()}") or 0)


def _bump(key: str, n: int = 1):
    state_set(f"{key}:{today()}", str(_count(key) + n))


def _slot_passed(key: str) -> bool:
    slot = state_get(f"{key}-at:{today()}")
    if not slot:
        slot = online_slot()
        state_set(f"{key}-at:{today()}", slot)
    return f"{now_kst():%H:%M}" >= slot


def _user_recent(uid: str, days: int = 30) -> bool:
    """같은 사람에게 30일 안에 이미 댓글·DM을 보냈는지(만료 시각을 updated_at에 둔다)."""
    return bool(db("SELECT 1 FROM private_log WHERE key = ? AND updated_at > datetime('now')", [f"touch:{uid}"])["rows"])


def _touch(uid: str, days: int = 30):
    db("INSERT OR REPLACE INTO private_log (key, value, updated_at) VALUES (?, '1', datetime('now', ?))", [f"touch:{uid}", f"+{days} days"])


# ---------- 카카오(지역 → 좌표, 근처 맛집) ----------
def _kakao(path: str) -> dict:
    key = ENV.get("KAKAO_REST_KEY", "")
    if not key:
        return {}
    try:
        return requests.get(f"https://dapi.kakao.com{path}", headers={"Authorization": f"KakaoAK {key}"}, timeout=10).json()
    except Exception:
        return {}


def geocode_text(text: str):
    """'망원동', '부산 서면', '강남역 근처' 같은 말에서 지역을 찾아 (이름, x, y)."""
    cands = [m.group(0) for m in REGION_HINT.finditer(text)]
    for q in ([" ".join(cands[:2])] if len(cands) >= 2 else []) + cands:
        d = (_kakao(f"/v2/local/search/keyword.json?query={quote(q)}").get("documents") or [None])[0]
        if d:
            return q, float(d["x"]), float(d["y"])
    return None


def near_places(name: str, x: float, y: float, food: str = "") -> list:
    """우리가 소개한 집(map_pins) 5km 안 우선, 모자라면 카카오 음식점으로 채운 최대 5곳."""
    rows = db("SELECT name, address, x, y FROM map_pins")["rows"]

    def km(r):
        return math.hypot((float(r["x"]) - x) * 88.2, (float(r["y"]) - y) * 111)
    out = [{"name": r["name"], "x": float(r["x"]), "y": float(r["y"]), "kind": "맛디깅 소개",
            "url": f"https://map.kakao.com/link/search/{quote(r['name'])}"} for r in sorted([r for r in rows if km(r) <= 5], key=km)[:5]]
    if len(out) < 5:
        q = f"{name} {food or '맛집'}".strip()
        for d in (_kakao(f"/v2/local/search/keyword.json?category_group_code=FD6&query={quote(q)}&x={x}&y={y}&radius=3000&sort=accuracy").get("documents") or []):
            if len(out) >= 5:
                break
            if any(o["name"] == d["place_name"] for o in out):
                continue
            out.append({"name": d["place_name"], "x": float(d["x"]), "y": float(d["y"]),
                        "kind": d.get("category_name", "").split(">")[-1].strip() or "맛집", "url": d.get("place_url", "")})
    return out


def near_list(name: str, x: float, y: float, food: str = "", places: list | None = None) -> str:
    places = places if places is not None else near_places(name, x, y, food)
    if not places:
        return ""
    lines = [f"{i + 1}. {p['name']} — {p['kind']}\n   {p['url']}" for i, p in enumerate(places)]
    return f"📍 {name} 근처 맛집이에요!\n\n" + "\n".join(lines) + "\n\n맛있는 한 끼 되세요 🍽️"


def send_cards(c, thread_id, who: str, area: str, cx: float, cy: float, places: list):
    """동네 지도 + 맛집 영수증 이미지(2026-10-27 사용자 결정). 실패해도 글자 답장은 이미 갔다."""
    import tempfile
    from pathlib import Path
    import cards
    try:
        with tempfile.TemporaryDirectory() as tmp:
            m = Path(tmp) / "map.jpg"
            r = Path(tmp) / "receipt.jpg"
            cards.map_card(m, who, area, cx, cy, places)
            cards.receipt_card(r, who, area, places)
            c.direct_send_photo(m, thread_ids=[int(thread_id)])
            nap(5, 15)
            c.direct_send_photo(r, thread_ids=[int(thread_id)])
        log.info(f"🗺🧾 지도·영수증 카드: {area}")
    except Exception as e:
        log.warning(f"카드 전송 실패: {str(e)[:120]}")
        if _blocked(e):
            raise


# ---------- 1·2) 소개한 식당 장소 피드 ----------
def visited_engage(c, find_location):
    if _count("visited-like") >= VISITED_LIKES and _count("visited-cmt") >= VISITED_COMMENTS:
        return
    if not _slot_passed("visited"):
        return
    # 2026-10-28 사용자: "식당 좋아요·댓글이 너무 적다" — 예전엔 최근 핀 120곳 중 무작위 6곳만 봤고, 위치를 못 찾은
    # 식당(빈 값)도 6자리 중 하나를 차지했다. → 전체 핀, 위치를 아는 식당 먼저 12곳 + 모르는 식당 4곳 조회.
    rows = db("""SELECT m.name, m.address, m.x, m.y, p.place_name AS title, l.value AS pk, l.updated_at AS pk_at
                 FROM map_pins m LEFT JOIN posts p ON p.content_id = m.content_id
                 LEFT JOIN private_log l ON l.key = 'locpk:' || m.name""")["rows"]
    known = [r for r in rows if r.get("pk")]
    # 못 찾은 식당은 14일 뒤 다시 찾아본다(예전엔 빈 값이 영구 저장됐다)
    unknown = [r for r in rows if r.get("pk") is None or (not r.get("pk") and str(r.get("pk_at") or "") < f"{now_kst() - timedelta(days=14):%Y-%m-%d}")]
    me = str(c.user_id)
    for r in random.sample(known, min(12, len(known))) + random.sample(unknown, min(4, len(unknown))):
        if _count("visited-like") >= VISITED_LIKES and _count("visited-cmt") >= VISITED_COMMENTS:
            break
        key = f"locpk:{r['name']}"
        pk = r.get("pk")
        if not pk:
            loc = find_location(c, {"query": r["name"], "address": r["address"], "lat": r["y"], "lng": r["x"]})
            pk = str(getattr(loc, "pk", "") or "") if loc else ""
            state_set(key, pk)
            nap(3, 8)
        if not pk:
            continue
        try:
            medias = c.location_medias_recent(int(pk), amount=15)
        except Exception as e:
            if _blocked(e):
                raise
            continue
        for m in medias:
            uid = str(m.user.pk)
            if uid == me or (time.time() - m.taken_at.timestamp()) > 30 * 86400:  # 작은 식당은 글이 드물어 14 → 30일
                continue
            liked = bool(getattr(m, "has_liked", False))
            if _count("visited-like") < VISITED_LIKES and not liked:
                c.media_like(m.id)
                liked = True
                _bump("visited-like")
                nap(25, 70)
            cap = (m.caption_text or "").strip()
            if _count("visited-cmt") < VISITED_COMMENTS and len(cap) >= 10 and not _user_recent(uid):
                text = llm(
                    f"인스타 맛집 큐레이션 계정이 '{r['name']}'에 다녀온 사람의 게시물에 다는 댓글 한 문장. "
                    f"'저희가 {r['title'] or '맛집 리스트'}에 소개한 집'이라는 사실을 자연스럽게 넣고, 게시물 내용을 하나 짚어 공감할 것. "
                    "존댓말 40자 안팎, 이모지 최대 1개. 식당·음식은 긍정만. 금지: 링크, 해시태그, 팔로우·맞팔 요청. 댓글만 출력.\n게시물: " + cap[:300], 90)
                if text and not re.search(r"팔로우|맞팔|선팔|http|#", text):
                    c.media_comment(m.id, text)
                    like_too(c, m.id, liked)
                    _touch(uid)
                    _bump("visited-cmt")
                    log.info(f"🍽 소개 식당 방문자 댓글({r['name']}): {text}")
                    nap(120, 300)
        nap(30, 90)
    log.info(f"🍽 장소 피드: 좋아요 {_count('visited-like')} · 댓글 {_count('visited-cmt')}")


# ---------- 3) 노트 ----------
SLOT_LABEL = {0: "전국 음식", 1: "전국 음식", 2: "동네 상권", 3: "전국 음식", 4: "지하철역", 5: "전국 음식", 6: "지하철역"}


def daily_note(c, just_published: str | None = None):
    """아침: 오늘 저녁 편 예고. 발행 직후(just_published): 방금 올라온 편 제목."""
    if just_published:
        text = f"🆕 {just_published}"[:60]
    else:
        if state_get(f"note:{today()}"):
            return
        dow = (now_kst().weekday() + 1) % 7  # 일=0
        # 홀수 날은 DM 봇 안내(사람들이 DM을 보내게)
        text = (f"오늘 저녁 5시 · {SLOT_LABEL[dow]} 맛집 리스트 공개 🍲" if now_kst().day % 2 == 0
                else "DM으로 동네나 음식 이름 보내면 맛집 리스트 보내드려요 📨")
    try:
        c.create_note(text)
        state_set(f"note:{today()}", text)
        log.info(f"🗒 노트: {text}")
    except Exception as e:
        log.warning(f"노트 실패: {str(e)[:120]}")
        if _blocked(e):
            raise


# ---------- 4) 스토리 보기 ----------
def story_views(c):
    if _count("story-view") >= STORY_USERS_PER_DAY:
        return
    last = float(state_get("story:last") or 0)
    if time.time() - last < 50 * 60:  # 한 번에 몰지 않고 50분마다 30명
        return
    state_set("story:last", str(time.time()))
    tag = random.choice(["맛집", "맛집추천", "먹스타그램", "국밥", "노포맛집", "서울맛집", "부산맛집"])
    medias = c.hashtag_medias_recent(tag, amount=40)
    uids = list({str(m.user.pk) for m in medias} - {str(c.user_id)})
    random.shuffle(uids)
    seen = 0
    for uid in uids[:STORY_USERS_PER_ROUND]:
        try:
            stories = c.user_stories(uid)
        except Exception as e:
            if _blocked(e):
                raise
            continue
        if stories:
            c.story_seen([int(s.pk) for s in stories[:3]])
            seen += 1
            if random.random() < 0.15 and not story_react(c, stories[0], uid) and _count("story-like") < STORY_LIKES_PER_DAY:
                c.story_like(stories[0].id)
                _bump("story-like")
        nap(4, 12)
    _bump("story-view", seen)
    log.info(f"👀 스토리 보기 {seen}명(#{tag}) — 오늘 {_count('story-view')}")


# ---------- 5) 새 팔로워 환영 DM ----------
WELCOME = "팔로우 감사해요 🙌 사시는 동네나 자주 가는 곳(예: 망원동, 부산 서면) 보내주시면 근처 맛집 바로 골라 드릴게요!"


def welcome_dm(c, new_uids: list):
    for uid in new_uids:
        if _count("welcome") >= WELCOME_PER_DAY:
            break
        if state_get(f"welcomed:{uid}") or _user_recent(uid):
            continue
        try:
            c.direct_send(WELCOME, user_ids=[int(uid)])
            state_set(f"welcomed:{uid}", "1")
            _touch(uid)
            _bump("welcome")
            log.info(f"👋 환영 DM: {uid}")
        except Exception as e:
            log.warning(f"환영 DM 실패 {uid}: {str(e)[:100]}")
            if _blocked(e):
                raise
        nap(60, 180)


# ---------- 5·7) DM 답장 ----------
def answer_dms(c):
    last = float(state_get("dm:last") or 0)
    if time.time() - last < 8 * 60:
        return
    state_set("dm:last", str(time.time()))
    me = str(c.user_id)
    for th in c.direct_threads(amount=20, thread_message_limit=3):
        if not th.messages:
            continue
        msg = th.messages[0]  # 가장 최근
        if str(msg.user_id) == me or state_get(f"dmdone:{msg.id}"):
            continue
        # 우리 게시물을 DM으로 공유했거나 스토리에서 우리를 언급한 경우 — 감사 + 그 사람 게시물 좋아요
        if (msg.item_type or "") in SHARE_TYPES:
            state_set(f"dmdone:{msg.id}", "1")
            thank_sharer(c, str(msg.user_id), msg.item_type)
            continue
        if not msg.text:
            continue
        state_set(f"dmdone:{msg.id}", "1")
        if peer_reply(c, str(msg.user_id), msg.text, th.id):  # 맞교환 제안에 대한 답
            continue
        if time.time() - msg.timestamp.timestamp() > 3 * 86400:
            continue
        g = geocode_text(msg.text)
        if not g:
            # 지역 없이 음식만 오면("국밥", "냉면") 그 음식 편 중 조회 최고 편 링크 + 상위 5곳
            food_only = next((f for f in FOODS_DM if f in msg.text), "")
            body = food_reply(food_only) if food_only else ""
            if body:
                nap(20, 60)
                c.direct_send(body, thread_ids=[int(th.id)])
                remember_followup(str(msg.user_id), f"{food_only} 맛집")
                log.info(f"📨 DM 음식 답장: {food_only}")
            continue
        food = next((f for f in ["국밥", "냉면", "칼국수", "곱창", "짬뽕", "삼겹살", "회", "족발", "보쌈", "돈까스", "초밥", "해장국", "순대국"] if f in msg.text), "")
        plist = near_places(g[0], g[1], g[2], food)
        body = near_list(g[0], g[1], g[2], food, plist)
        if not body:
            continue
        nap(20, 60)
        c.direct_send(body, thread_ids=[int(th.id)])
        other = next((u for u in th.users if str(u.pk) == str(msg.user_id)), th.users[0] if th.users else None)
        who = (getattr(other, "full_name", "") or getattr(other, "username", "") or "고객").split(" ")[0][:8]
        send_cards(c, th.id, who, g[0], g[1], g[2], plist)
        remember_followup(str(msg.user_id), f"{g[0]} 맛집")
        log.info(f"📨 DM 답장: {g[0]} {food}")
        nap(10, 30)


def dm_commenter(c, user_id: str, username: str, comment: str) -> bool:
    """우리 게시물 댓글에 지역이 나오면 그 지역 리스트를 DM으로(하루 10). 보냈으면 True."""
    if _count("cmt-dm") >= COMMENTER_DM_PER_DAY or _user_recent(user_id):
        return False
    g = geocode_text(comment)
    if not g:
        return False
    body = near_list(g[0], g[1], g[2])
    if not body:
        return False
    try:
        c.direct_send(body, user_ids=[int(user_id)])
        remember_followup(str(user_id), f"{g[0]} 맛집")
        _touch(user_id)
        _bump("cmt-dm")
        log.info(f"📨 댓글러 DM(@{username}): {g[0]}")
        return True
    except Exception as e:
        log.warning(f"댓글러 DM 실패: {str(e)[:100]}")
        if _blocked(e):
            raise
        return False


# ---------- 6) 비슷한 작은 계정의 새 팔로워 ----------
def peer_accounts(c) -> list:
    k = f"peeracc:{now_kst():%G-%V}"
    cached = state_get(k)
    if cached:
        return json.loads(cached)
    out = []
    for q in ["맛집 큐레이션", "전국맛집", "맛집 리스트", "국밥 맛집", "노포 맛집"]:
        res = c.fbsearch_accounts_v2(q)
        for d in (res.get("users", []) if isinstance(res, dict) else [])[:8]:
            uid = str(d.get("pk") or d.get("pk_id") or "")
            if not uid or uid in out or uid == str(c.user_id):
                continue
            nap(2, 5)
            try:
                info = c.user_info(uid)
            except Exception:
                continue
            if 1000 <= info.follower_count <= 10000 and re.search(r"맛집|먹|food|국밥|노포", f"{info.full_name} {info.biography}", re.I):
                out.append(uid)
        nap(3, 8)
    state_set(k, json.dumps(out[:8]))
    log.info(f"비슷한 작은 맛집 계정 {len(out[:8])}개")
    return out[:8]


def peer_follower_likes(c):
    if _count("peer-like") >= PEER_LIKES_PER_DAY or not _slot_passed("peer"):
        return
    peers = peer_accounts(c)
    if not peers:
        return
    src = random.choice(peers)
    followers = list(c.user_followers(src, amount=40).keys())  # 최근 팔로워가 앞
    for uid in followers:
        if _count("peer-like") >= PEER_LIKES_PER_DAY:
            break
        try:
            ms = c.user_medias(str(uid), amount=1)
            if ms and not getattr(ms[0], "has_liked", False):
                c.media_like(ms[0].id)
                _bump("peer-like")
        except Exception as e:
            if _blocked(e):
                raise
            continue
        nap(40, 110)
    log.info(f"🤝 비슷한 계정 팔로워 좋아요 {_count('peer-like')}")


# ---------- 발행 직후 30분 집중(2026-10-27 사용자 결정) ----------
BURST_KEYS = ["likes-at", "tlikes-at", "acom-at", "visited-at", "peer-at"]


def trigger_burst(why: str):
    """새 편이 올라가면 아직 안 돈 하루 1회 활동들의 시각을 '지금'으로 당긴다 — 알림을 보고 들어온 사람이
    방금 올린 릴스를 맨 위에서 보고, 인스타가 새 게시물을 평가하는 첫 30분에 계정 활동이 몰린다."""
    now = f"{now_kst():%H:%M}"
    for k in BURST_KEYS:
        state_set(f"{k}:{today()}", now)
    state_set("pp:last", "0")  # 다음 바퀴에 바로 growth_round
    state_set("fastreply:until", str(time.time() + 2 * 3600))  # 발행 후 2시간은 댓글을 3분마다 확인
    log.info(f"🚀 발행 직후 집중 활동 시작({why})")


# ---------- 단골 관리 ----------
REGULAR_LIKES, REGULAR_COMMENTS = 10, 3


def regulars(c, own_media: list) -> list:
    """최근 우리 게시물에 댓글·좋아요를 자주 남긴 팔로워 상위 15명(주 1회 갱신)."""
    k = f"regulars:{now_kst():%G-%V}"
    cached = state_get(k)
    if cached:
        return json.loads(cached)
    from collections import Counter
    cnt = Counter()
    me = str(c.user_id)
    for media_id, _t in own_media[:6]:
        try:
            for cm in c.media_comments(media_id, amount=40):
                cnt[str(cm.user.pk)] += 3
            nap(3, 8)
            for u in c.media_likers(media_id)[:100]:
                cnt[str(u.pk)] += 1
        except Exception as e:
            if _blocked(e):
                raise
        nap(5, 15)
    cnt.pop(me, None)
    top = [u for u, n in cnt.most_common(15) if n >= 2]
    state_set(k, json.dumps(top))
    log.info(f"⭐ 단골 {len(top)}명 갱신")
    return top


def regulars_engage(c, own_media: list):
    if _count("reg-like") >= REGULAR_LIKES or not _slot_passed("reg"):
        return
    regs = regulars(c, own_media)
    for uid in random.sample(regs, min(REGULAR_LIKES, len(regs))):
        if _count("reg-like") >= REGULAR_LIKES:
            break
        try:
            ms = c.user_medias(uid, amount=1)
        except Exception as e:
            if _blocked(e):
                raise
            continue
        if not ms or time.time() - ms[0].taken_at.timestamp() > 10 * 86400:
            continue
        m = ms[0]
        if not getattr(m, "has_liked", False):
            c.media_like(m.id)
            _bump("reg-like")
        cap = (m.caption_text or "").strip()
        if _count("reg-cmt") < REGULAR_COMMENTS and len(cap) >= 8 and not _user_recent(uid):
            text = llm("늘 우리 계정에 반응해 주는 팔로워의 게시물에 다는 다정한 댓글 한 문장. 게시물 내용을 하나 짚을 것. "
                       "존댓말 30자 안팎, 이모지 최대 1개, 홍보·링크·팔로우 요청 금지. 음식·식당 얘기면 긍정만. 댓글만 출력.\n게시물: " + cap[:300], 70)
            if text and not re.search(r"팔로우|맞팔|http|#", text):
                c.media_comment(m.id, text)
                _touch(uid, 14)
                _bump("reg-cmt")
                log.info(f"⭐ 단골 댓글: {text}")
        nap(40, 120)
    log.info(f"⭐ 단골 관리: 좋아요 {_count('reg-like')} · 댓글 {_count('reg-cmt')}")


# ---------- 스토리 이모지 반응 ----------
STORY_REACTS_PER_DAY = 15


def story_react(c, story, uid: str) -> bool:
    """스토리에 이모지 반응(앱의 '빠른 반응'). instagrapi에 공식 함수가 없어 앱 내부 호출을 직접 쓴다 —
    검증 전이라 실패하면 그날은 반응을 끄고 스토리 좋아요로 대신한다(2026-10-27)."""
    if state_get(f"react-off:{today()}") or _count("story-react") >= STORY_REACTS_PER_DAY:
        return False
    emoji = random.choice(["😋", "😍", "🔥"])
    try:
        cc = c.generate_uuid()
        c.private_request("direct_v2/threads/broadcast/reel_react/", data={
            "recipient_users": f"[[{uid}]]", "action": "send_item", "client_context": cc, "mutation_token": cc,
            "media_id": f"{story.pk}_{uid}", "reel_id": str(uid), "entry": "reel", "text": emoji,
            "reaction_emoji": emoji, "send_attribution": "reel_feed_timeline", "_uuid": c.uuid,
        })
        _bump("story-react")
        return True
    except Exception as e:
        if _blocked(e):
            raise
        state_set(f"react-off:{today()}", str(e)[:120])
        log.warning(f"스토리 이모지 반응 실패(오늘은 좋아요로 대신): {str(e)[:120]}")
        return False


# ---------- 선정 식당 축하 DM ----------
CONGRATS_PER_DAY = 5


def congrats_dm(c, places: list, title: str):
    """1~3위로 소개한 식당 중 인스타 계정을 확신 있게 찾은 곳에만(growth.find_restaurant_account 캐시)."""
    import growth
    for rank, p in enumerate(places[:3], start=1):
        if _count("congrats") >= CONGRATS_PER_DAY:
            break
        acc = growth.find_restaurant_account(c, p.get("name", ""), p.get("region", ""), p.get("address", ""))
        if not acc or _user_recent(acc["pk"]):
            continue
        msg = (f"안녕하세요! 전국 맛집 큐레이션 계정 맛디깅입니다 🙌 오늘 올린 '{title}'에서 "
               f"{p.get('name')}을(를) {rank}위로 소개해 드렸어요. 축하드려요! 앞으로도 번창하세요 🍲")
        try:
            c.direct_send(msg, user_ids=[int(acc["pk"])])
            _touch(acc["pk"], 60)
            _bump("congrats")
            log.info(f"🎉 축하 DM: @{acc['username']} ({rank}위)")
        except Exception as e:
            log.warning(f"축하 DM 실패: {str(e)[:100]}")
            if _blocked(e):
                raise
        nap(60, 180)


# ---------- 베스트 댓글 고정(2026-10-27 사용자 결정) ----------
def best_comment_pin(c, own_media: list):
    """올린 지 6시간~3일 된 우리 게시물마다 한 번: 남이 단 댓글 중 가장 정성스럽거나 재밌는 걸 LLM이 골라
    고정하고 '베스트 댓글 🏆' 답글. 인스타는 게시물당 3개까지 고정 — '1위 소개' 고정 댓글은 그대로 둔다."""
    me = str(c.user_id)
    for media_id, title in own_media[:5]:
        if state_get(f"bestpin:{media_id}"):
            continue
        try:
            info = c.media_info(media_id)
        except Exception as e:
            if _blocked(e):
                raise
            continue
        age = time.time() - info.taken_at.timestamp()
        if age < 6 * 3600:
            continue
        if age > 3 * 86400:
            state_set(f"bestpin:{media_id}", "expired")
            continue
        cands = [cm for cm in c.media_comments(media_id, amount=50)
                 if str(cm.user.pk) != me and len(re.sub(r"[^\w가-힣]", "", cm.text or "")) >= 6]
        if len(cands) < 2:
            continue
        menu = "\n".join(f"{i + 1}. {cm.text[:120]}" for i, cm in enumerate(cands[:20]))
        pick = llm("아래는 인스타 맛집 게시물의 댓글들이다. 가장 정성스럽거나 재밌고 긍정적인 댓글 하나의 번호만 출력하라. "
                   "식당을 깎아내리거나 광고·맞팔 요청인 댓글은 고르지 말 것. 숫자만 출력.\n" + menu, 10)
        m = re.search(r"\d+", pick or "")
        if not m or not (1 <= int(m.group()) <= min(20, len(cands))):
            continue
        cm = cands[int(m.group()) - 1]
        try:
            c.comment_pin(media_id, cm.pk)
            nap(5, 15)
            c.media_comment(media_id, f"@{cm.user.username} 베스트 댓글 🏆 정성 가득한 댓글 감사해요!", replied_to_comment_id=cm.pk)
            state_set(f"bestpin:{media_id}", str(cm.pk))
            log.info(f"🏆 베스트 댓글 고정({title}): {cm.text[:40]}")
        except Exception as e:
            log.warning(f"베스트 댓글 고정 실패: {str(e)[:120]}")
            if _blocked(e):
                raise
        nap(30, 90)


# ---------- 우리 게시물을 공유·언급한 사람 찾아가기 ----------
SHARE_TYPES = {"media_share", "reel_share", "story_share", "clip", "xma_story_share", "xma_media_share", "xma_clip"}
SHARER_PER_DAY = 10


def thank_sharer(c, uid: str, item_type: str) -> bool:
    """DM으로 우리 게시물을 공유했거나 스토리에서 우리를 언급한 사람: 감사 DM 1통 + 최신 게시물 좋아요(하루 10)."""
    if _count("sharer") >= SHARER_PER_DAY or state_get(f"thanked:{uid}:{now_kst():%Y-%m}"):
        return False
    try:
        c.direct_send("공유해 주셔서 감사해요 🙌 다음 편도 맛있는 곳으로 골라 올게요!", user_ids=[int(uid)])
        nap(10, 30)
        ms = c.user_medias(uid, amount=1)
        if ms and not getattr(ms[0], "has_liked", False):
            c.media_like(ms[0].id)
        state_set(f"thanked:{uid}:{now_kst():%Y-%m}", item_type)
        _bump("sharer")
        log.info(f"🙏 공유·언급 감사: {uid} ({item_type})")
        return True
    except Exception as e:
        log.warning(f"공유자 감사 실패: {str(e)[:100]}")
        if _blocked(e):
            raise
        return False


# ---------- "여기 어디예요?" 질문 댓글에 대신 답하기(2026-10-27) ----------
WHERE_Q = re.compile(r"(여기|이 ?집|이 ?곳|가게).{0,6}(어디|위치|이름|상호)|어디(예요|에요|인가요|죠|야|임)\??|위치.{0,4}(알려|궁금|좀)|상호.{0,4}(알려|궁금)")
NOT_PLACE = re.compile(r"^([가-힣]{1,4}(시|구|군|동|도|읍|면)|서울|부산|대구|인천|광주|대전|울산|제주|대한민국|한국|Korea|Seoul|Busan|South Korea)$", re.I)
WHERE_PER_DAY = 5


def answer_where(c):
    if _count("where") >= WHERE_PER_DAY or not _slot_passed("where"):
        return
    me = str(c.user_id)
    for tag in random.sample(["맛집", "맛집추천", "먹스타그램", "서울맛집", "부산맛집", "국밥맛집"], 3):
        medias = c.hashtag_medias_top(tag, amount=9)
        for m in medias:
            if _count("where") >= WHERE_PER_DAY:
                return
            loc = getattr(m, "location", None)
            name = (getattr(loc, "name", "") or "").strip()
            if not name or len(name) < 2 or NOT_PLACE.match(name) or str(m.user.pk) == me:
                continue
            try:
                comments = c.media_comments(m.id, amount=30)
            except Exception as e:
                if _blocked(e):
                    raise
                continue
            if any(str(cm.user.pk) == str(m.user.pk) for cm in comments):
                continue  # 작성자가 이미 답하는 게시물
            for cm in comments:
                uid = str(cm.user.pk)
                if uid == me or not WHERE_Q.search(cm.text or "") or _user_recent(uid) or state_get(f"where:{cm.pk}"):
                    continue
                c.media_comment(m.id, f"@{cm.user.username} {name}이에요! 📍 https://map.kakao.com/link/search/{quote(name)}", replied_to_comment_id=cm.pk)
                state_set(f"where:{cm.pk}", "1")
                _touch(uid)
                _bump("where")
                log.info(f"📍 위치 질문 답글: {name}")
                nap(90, 240)
                break
            nap(5, 15)
        nap(20, 60)


# ---------- "맛집 추천해 주세요" 게시물 응답 ----------
REQ_TAGS = ["맛집추천해주세요", "맛집추천부탁", "맛집알려주세요", "맛집추천부탁드려요", "맛집추천좀"]
REQ_PER_DAY = 8  # 2026-10-28 확대(5 → 8)


def recommend_requests(c):
    if _count("req") >= REQ_PER_DAY or not _slot_passed("req"):
        return
    me = str(c.user_id)
    rows = db("SELECT name, x, y FROM map_pins")["rows"]
    for tag in random.sample(REQ_TAGS, 3):
        try:
            medias = c.hashtag_medias_recent(tag, amount=20)
        except Exception as e:
            if _blocked(e):
                raise
            continue
        for m in medias:
            if _count("req") >= REQ_PER_DAY:
                return
            uid = str(m.user.pk)
            if uid == me or _user_recent(uid) or time.time() - m.taken_at.timestamp() > 7 * 86400:
                continue
            g = geocode_text(m.caption_text or "")
            if not g:
                continue
            near = sorted(rows, key=lambda r: math.hypot((float(r["x"]) - g[1]) * 88.2, (float(r["y"]) - g[2]) * 111))
            near = [r["name"] for r in near if math.hypot((float(r["x"]) - g[1]) * 88.2, (float(r["y"]) - g[2]) * 111) <= 4][:3]
            if len(near) < 2:
                continue
            c.media_comment(m.id, f"{g[0]} 근처면 {', '.join(near)} 추천드려요! 다 맛있게 드셨으면 좋겠어요 😊")
            like_too(c, m.id, getattr(m, "has_liked", False))
            _touch(uid)
            _bump("req")
            log.info(f"🙋 추천 요청 응답(#{tag} {g[0]}): {', '.join(near)}")
            nap(120, 300)
        nap(20, 60)


# ---------- DM 음식 키워드 ----------
FOODS_DM = ["돼지국밥", "순대국", "국밥", "해장국", "칼국수", "냉면", "밀면", "막국수", "짬뽕", "곱창", "감자탕", "곰탕", "설렁탕",
            "삼계탕", "족발", "보쌈", "갈비", "장어", "게장", "초밥", "돈까스", "김밥", "떡볶이", "만두", "쭈꾸미", "물회", "흑돼지"]


def food_reply(food: str) -> str:
    """그 음식 편 중 조회가 가장 높았던 편의 링크 + 상위 5곳."""
    r = db("""SELECT place_name, address, ig_media_id, views FROM posts WHERE status = 'published'
              AND (content_id LIKE 'roundup-%' OR content_id LIKE 'countdown-%') AND place_name LIKE ?
              ORDER BY COALESCE(views, 0) DESC LIMIT 1""", [f"%{food}%"])["rows"]
    if not r:
        return ""
    p = r[0]
    names = [n.strip() for n, _a in re.findall(r"\d\.\s*(.+?)\s+—\s+(.+?)(?=\s+\d\.\s|$)", str(p["address"] or ""))][:5]
    link = ""
    try:
        from common import GRAPH, graph_token
        link = requests.get(f"{GRAPH}/{p['ig_media_id']}", params={"fields": "permalink", "access_token": graph_token()}, timeout=15).json().get("permalink", "")
    except Exception:
        pass
    lines = "\n".join(f"{i + 1}. {n}" for i, n in enumerate(names))
    return f"🍲 {p['place_name']}\n\n{lines}\n\n{('👉 ' + link) if link else ''}\n동네 이름도 같이 보내주시면 근처로 골라 드려요!".strip()


# ---------- 팔로워 접속 시간(공식 API online_followers) ----------
def refresh_online_hours():
    """주 1회: 시간대별 접속 팔로워 수(태평양 시간 기준) → 한국 시간 가중치로 바꿔 private_log 'online_hours'.
    common.online_slot이 이 가중치로 하루 1회 활동 시각을 고른다(노트북 온라인 시간 안에서)."""
    if state_get(f"onlinehours:{now_kst():%G-%V}"):
        return
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo
    from common import GRAPH, graph_token
    j = requests.get(f"{GRAPH}/me/insights", params={"metric": "online_followers", "period": "lifetime", "access_token": graph_token()}, timeout=20).json()
    vals = next((v["value"] for v in (j.get("data") or [{}])[0].get("values", []) if v.get("value")), None)
    if not vals:
        return
    pt = ZoneInfo("America/Los_Angeles")
    base = datetime.now(pt).replace(minute=0, second=0, microsecond=0)
    kst = {}
    for h, n in vals.items():
        t = base.replace(hour=int(h)).astimezone(ZoneInfo("Asia/Seoul"))
        kst[str(t.hour)] = int(n)
    state_set("online_hours", json.dumps(kst))
    state_set(f"onlinehours:{now_kst():%G-%V}", "1")
    top = sorted(kst.items(), key=lambda kv: -kv[1])[:4]
    log.info(f"🕒 팔로워 접속 많은 시각(KST): {top}")


# ---------- DM 후속 대화(2026-10-27 사용자 결정) ----------
FOLLOWUP_PER_DAY = 10


def remember_followup(uid: str, what: str):
    """맛집 리스트를 DM으로 보낸 사람 — 7일 뒤 한 번 안부를 묻는다(같은 사람은 한 번만)."""
    if state_get(f"dmfu:{uid}"):
        return
    state_set(f"dmfu:{uid}", json.dumps({"at": time.time(), "what": what, "done": False}, ensure_ascii=False))


def dm_followups(c):
    if _count("followup") >= FOLLOWUP_PER_DAY or not _slot_passed("followup"):
        return
    rows = db("SELECT key, value FROM private_log WHERE key LIKE 'dmfu:%'")["rows"]
    for r in rows:
        if _count("followup") >= FOLLOWUP_PER_DAY:
            break
        v = json.loads(r["value"])
        if v.get("done") or time.time() - v["at"] < 7 * 86400:
            continue
        uid = r["key"].split(":", 1)[1]
        what = v.get("what") or "맛집"
        msg = f"지난번 보내드린 {what} 중에 가보신 곳 있으세요? 어떠셨는지 궁금해요 😊 다른 동네나 음식도 언제든 보내주세요!"
        try:
            c.direct_send(msg, user_ids=[int(uid)])
            v["done"] = True
            state_set(r["key"], json.dumps(v, ensure_ascii=False))
            _bump("followup")
            log.info(f"💌 DM 후속: {uid} ({what})")
        except Exception as e:
            log.warning(f"DM 후속 실패: {str(e)[:100]}")
            if _blocked(e):
                raise
        nap(60, 180)


# ---------- 스토리 질문 스티커 "동네 맛집 물어보세요"(2026-10-27 사용자 결정) ----------
QUESTION_DOW = (1, 4)  # 화·금 (월=0)


def _question_image(path):
    """1080x1920 단색 배경 + 안내 문구. 질문 스티커가 안 붙어도 이 문구만으로 DM을 유도한다."""
    from PIL import Image, ImageDraw, ImageFont
    from common import REPO
    img = Image.new("RGB", (1080, 1920), "#1a0f0a")
    d = ImageDraw.Draw(img)
    for i in range(1920):  # 아래로 갈수록 붉게
        d.line([(0, i), (1080, i)], fill=(26 + i * 60 // 1920, 15, 10))
    fb = REPO / "assets" / "fonts" / "Pretendard-ExtraBold.otf"  # G마켓 산스 복원본은 공백 글리프가 없어 네모로 나온다
    fr = REPO / "assets" / "fonts" / "Pretendard-Bold.otf"
    big = ImageFont.truetype(str(fb), 96)
    mid = ImageFont.truetype(str(fr), 46)
    d.text((540, 520), "동네 맛집", font=big, fill="#ffffff", anchor="mm")
    d.text((540, 640), "물어보세요", font=big, fill="#ffffff", anchor="mm")
    d.text((540, 1420), "동네 이름 남기면", font=mid, fill="#ffd9c9", anchor="mm")
    d.text((540, 1490), "근처 맛집 리스트를 DM으로 보내드려요", font=mid, fill="#ffd9c9", anchor="mm")
    d.text((540, 1600), "(DM으로 바로 보내셔도 돼요)", font=ImageFont.truetype(str(fr), 36), fill="#c9a89a", anchor="mm")
    img.save(path, quality=92)


def question_story(c):
    """화·금 하루 1회: 질문 스티커 스토리. instagrapi에 정식 기능이 없어 투표 스티커와 같은 방식(앱 내부 형식)으로
    붙인다 — 검증 전. 실패하면 안내 문구만 있는 스토리로 올린다."""
    import tempfile
    from pathlib import Path
    if now_kst().weekday() not in QUESTION_DOW or state_get(f"qstory:{today()}") or not _slot_passed("qstory"):
        return
    state_set(f"qstory:{today()}", "trying")
    with tempfile.TemporaryDirectory() as tmp:
        img = Path(tmp) / "q.jpg"
        _question_image(img)
        qs = [{"x": 0.5, "y": 0.43, "z": 0, "width": 0.78, "height": 0.2, "rotation": 0.0,
               "question": "어느 동네 맛집이 궁금하세요? 🍲", "viewer_can_interact": True,
               "background_color": "#ffffff", "text_color": "#000000", "question_type": "text",
               "profile_pic_url": "", "is_sticker": True}]
        try:
            story = c.photo_upload_to_story(img, extra_data={"story_questions": json.dumps(qs, ensure_ascii=False),
                                                              "story_sticker_ids": "question_sticker_ma"})
            qid = ""
            try:
                qid = str(c.last_json["media"]["story_questions"][0]["question_sticker"]["question_id"])
            except Exception:
                pass
            state_set(f"qstory:{today()}", json.dumps({"pk": str(story.pk), "qid": qid, "at": time.time()}))
            log.info(f"❓ 질문 스티커 스토리 {'(스티커 확인)' if qid else '(스티커 미확인 — 문구만)'}")
        except Exception as e:
            if _blocked(e):
                raise
            log.warning(f"질문 스티커 실패 — 문구만 올림: {str(e)[:120]}")
            story = c.photo_upload_to_story(img)
            state_set(f"qstory:{today()}", json.dumps({"pk": str(story.pk), "qid": "", "at": time.time()}))


def question_answers(c):
    """살아 있는 질문 스토리(24시간)의 답변을 읽어 동네가 있으면 근처 맛집 리스트를 DM으로(20분마다)."""
    last = float(state_get("qans:last") or 0)
    if time.time() - last < 20 * 60:
        return
    state_set("qans:last", str(time.time()))
    rows = db("SELECT key, value FROM private_log WHERE key LIKE 'qstory:%'")["rows"]
    for r in rows:
        try:
            v = json.loads(r["value"])
        except Exception:
            continue
        if not v.get("qid") or time.time() - v.get("at", 0) > 26 * 3600:
            continue
        try:
            res = c.private_request(f"media/{v['pk']}_{c.user_id}/{v['qid']}/story_question_responses/")
        except Exception as e:
            if _blocked(e):
                raise
            log.warning(f"질문 답변 조회 실패: {str(e)[:120]}")
            continue
        for a in (res.get("responder_info", {}) or {}).get("responders", []):
            uid = str((a.get("user") or {}).get("pk") or "")
            text = a.get("response") or ""
            rid = str(a.get("id") or f"{uid}:{text[:20]}")
            if not uid or state_get(f"qa:{rid}"):
                continue
            state_set(f"qa:{rid}", "1")
            g = geocode_text(text)
            body = near_list(g[0], g[1], g[2]) if g else ""
            if not body:
                food = next((f for f in FOODS_DM if f in text), "")
                body = food_reply(food) if food else ""
            if not body:
                continue
            try:
                c.direct_send(body, user_ids=[int(uid)])
                remember_followup(uid, f"{g[0] if g else '추천'} 맛집")
                log.info(f"❓→📨 질문 답변 DM: {text[:20]}")
            except Exception as e:
                if _blocked(e):
                    raise
            nap(30, 90)


# ---------- 비슷한 작은 계정과 스토리 맞교환(2026-10-27 사용자 결정) ----------
# 상대 게시물을 퍼오지 않는다(리그램 금지 규칙) — 우리 카드에 그 계정을 멘션해 소개하고, 상대도 우리를 소개해 주길 부탁한다.
PEER_PROPOSAL = ("안녕하세요! 전국 맛집 큐레이션 계정 맛디깅입니다 🙌 결이 비슷한 맛집 계정이라 연락드려요. "
                 "매주 서로를 스토리로 한 번씩 소개해 보면 어떨까요? 저희는 '이번 주 추천 맛집 계정'으로 소개해 드릴게요. 좋으시면 편하게 답장 주세요!")
YES = re.compile(r"좋아요|좋습니다|좋네요|그래요|네\b|넵|오케이|ok|OK|콜|감사|함께|해요|하죠|좋죠")
PEER_PROPOSALS_PER_DAY = 2


def peer_proposals(c):
    if _count("peerprop") >= PEER_PROPOSALS_PER_DAY or not _slot_passed("peerprop"):
        return
    for uid in peer_accounts(c):
        if _count("peerprop") >= PEER_PROPOSALS_PER_DAY:
            break
        if state_get(f"peerprop:{uid}"):
            continue
        try:
            c.direct_send(PEER_PROPOSAL, user_ids=[int(uid)])
            state_set(f"peerprop:{uid}", str(time.time()))
            _bump("peerprop")
            log.info(f"🤝 맞교환 제안 DM: {uid}")
        except Exception as e:
            log.warning(f"맞교환 제안 실패: {str(e)[:100]}")
            if _blocked(e):
                raise
        nap(90, 240)


def peer_reply(c, uid: str, text: str, thread_id) -> bool:
    """제안한 계정이 긍정으로 답하면 수락으로 기록하고 감사 답장. 처리했으면 True."""
    if not state_get(f"peerprop:{uid}") or state_get(f"peeraccept:{uid}"):
        return False
    if not YES.search(text or ""):
        return False
    state_set(f"peeraccept:{uid}", str(time.time()))
    c.direct_send("감사해요! 이번 주부터 스토리로 소개해 드릴게요 😊 저희 새 편도 마음에 드시면 한 번씩 소개 부탁드려요!", thread_ids=[int(thread_id)])
    log.info(f"🤝 맞교환 수락: {uid}")
    return True


def peer_shoutout_story(c):
    """금요일 하루 1회: 수락한 계정을 '이번 주 추천 맛집 계정' 카드에 멘션(최대 3개)."""
    import tempfile
    from pathlib import Path
    from PIL import Image, ImageDraw, ImageFont
    from instagrapi.types import StoryMention, UserShort
    from common import REPO
    if now_kst().weekday() != 4 or state_get(f"shoutout:{today()}") or not _slot_passed("shoutout"):
        return
    acc = [r["key"].split(":", 1)[1] for r in db("SELECT key FROM private_log WHERE key LIKE 'peeraccept:%'")["rows"]]
    if not acc:
        return
    state_set(f"shoutout:{today()}", "1")
    users = []
    for uid in random.sample(acc, min(3, len(acc))):
        try:
            users.append(c.user_info(uid))
        except Exception as e:
            if _blocked(e):
                raise
        nap(3, 8)
    if not users:
        return
    with tempfile.TemporaryDirectory() as tmp:
        img = Path(tmp) / "shout.jpg"
        im = Image.new("RGB", (1080, 1920), "#1a0f0a")
        d = ImageDraw.Draw(im)
        fb = ImageFont.truetype(str(REPO / "assets" / "fonts" / "Pretendard-ExtraBold.otf"), 84)
        fr = ImageFont.truetype(str(REPO / "assets" / "fonts" / "Pretendard-Bold.otf"), 52)
        d.text((540, 420), "이번 주", font=fb, fill="#ffffff", anchor="mm")
        d.text((540, 530), "추천 맛집 계정", font=fb, fill="#ffffff", anchor="mm")
        mentions = []
        for i, u in enumerate(users):
            y = 820 + i * 220
            d.text((540, y), f"@{u.username}", font=fr, fill="#ffd9c9", anchor="mm")
            mentions.append(StoryMention(user=UserShort(pk=str(u.pk), username=u.username), x=0.5, y=y / 1920, width=0.6, height=0.07))
        d.text((540, 1600), "결이 맞는 맛집 계정이에요 🍲", font=ImageFont.truetype(str(REPO / "assets" / "fonts" / "Pretendard-Bold.otf"), 40), fill="#c9a89a", anchor="mm")
        im.save(img, quality=92)
        c.photo_upload_to_story(img, mentions=mentions)
    log.info(f"📣 추천 계정 스토리: {[u.username for u in users]}")


# ---------- 릴스 대체 텍스트(검색 노출, 2026-10-27 사용자 결정) ----------
def alt_text(p: dict) -> str:
    """'부산 서면 돼지국밥 맛집 6곳 리스트 — A, B, C …' — 인스타 검색·구글 색인이 읽는 대체 텍스트.
    비공식 업로드(핸드오프·트라이얼)에서만 붙인다. 공식 API 컨테이너에 검증 안 된 필드를 넣으면 발행이 깨질 수 있다."""
    title = (p.get("caption") or "").split("\n")[0].split("| ")[-1].strip()
    names = [x.get("name", "") for x in (p.get("places") or []) if x.get("name")]
    regions = sorted({x.get("region", "").split(" ")[0] for x in (p.get("places") or []) if x.get("region")})
    s = f"{title} 리스트 — {', '.join(names)}" + (f" ({', '.join(regions[:4])})" if regions else "")
    return s[:300]


# ---------- 전국 맛집 지도 하이라이트(매주) ----------
def _map_image(path, rows, recent_names):
    from PIL import Image, ImageDraw, ImageFont
    from common import REPO
    W, H = 1080, 1920
    im = Image.new("RGB", (W, H), "#120b08")
    d = ImageDraw.Draw(im)
    fb = ImageFont.truetype(str(REPO / "assets" / "fonts" / "Pretendard-ExtraBold.otf"), 84)
    fr = ImageFont.truetype(str(REPO / "assets" / "fonts" / "Pretendard-Bold.otf"), 40)
    d.text((W // 2, 170), "전국 맛집 지도", font=fb, fill="#ffffff", anchor="mm")
    d.text((W // 2, 270), f"지금까지 소개한 {len(rows):,}곳", font=fr, fill="#ffd9c9", anchor="mm")
    # 남한 범위 → 지도 영역(위도 36도 기준 경도 축소)
    mw = 860
    mh = int(mw * 5.7 / (4.6 * 0.81))
    x0, y0 = (W - mw) // 2, 360
    def px(x, y):
        return x0 + (x - 125.0) / 4.6 * mw, y0 + (38.7 - y) / 5.7 * mh
    for r in rows:
        x, y = float(r["x"]), float(r["y"])
        if not (124.6 < x < 130 and 32.8 < y < 38.9):
            continue
        cx, cy = px(x, y)
        recent = r["name"] in recent_names
        rad = 9 if recent else 6
        d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill="#e02020" if recent else "#ffffff")
    d.text((W // 2, H - 150), "빨간 점 = 이번 주 새로 소개", font=fr, fill="#c9a89a", anchor="mm")
    d.text((W // 2, H - 90), "@" + ig_handle(), font=ImageFont.truetype(str(REPO / "assets" / "fonts" / "Pretendard-Bold.otf"), 34), fill="#8a7a72", anchor="mm")
    im.save(path, quality=92)


def weekly_map_highlight(c):
    """월요일 하루 1회: 쌓인 지도를 스토리로 올리고 '맛집지도' 하이라이트를 그 한 장으로 교체."""
    import tempfile
    from pathlib import Path
    if now_kst().weekday() != 0 or state_get(f"maphl:{today()}") or not _slot_passed("maphl"):
        return
    state_set(f"maphl:{today()}", "1")
    rows = db("SELECT name, x, y, created_at FROM map_pins")["rows"]
    if not rows:
        return
    # '이번 주'는 핀이 들어간 날이 아니라 그 편이 발행된 날 기준(과거분은 백필로 한꺼번에 들어갔다)
    recent = {r["name"] for r in db("""SELECT m.name FROM map_pins m JOIN posts p ON p.content_id = m.content_id
                                        WHERE p.created_at >= datetime('now', '-7 days')""")["rows"]}
    with tempfile.TemporaryDirectory() as tmp:
        img = Path(tmp) / "map.jpg"
        _map_image(img, rows, recent)
        story = c.photo_upload_to_story(img)
    nap(5, 15)
    title = "맛집지도"
    hl = state_get(f"hl:{title}")
    try:
        if hl:
            old = json.loads(state_get("maphl:stories") or "[]")
            c.highlight_add_stories(hl, [str(story.pk)])
            if old:
                nap(3, 8)
                c.highlight_remove_stories(hl, old)
        else:
            h = c.highlight_create(title, [str(story.pk)])
            state_set(f"hl:{title}", str(h.pk))
        state_set("maphl:stories", json.dumps([str(story.pk)]))
        log.info(f"🗺 지도 하이라이트 갱신: {len(rows)}곳 (이번 주 새 {len(recent)}곳)")
    except Exception as e:
        log.warning(f"지도 하이라이트 실패: {str(e)[:120]}")
        if _blocked(e):
            raise


# ---------- 고정 댓글 해시태그 보강(2026-10-27 사용자 결정) ----------
def comment_hashtags(p: dict) -> list:
    """캡션 해시태그는 5개 제한 — 고정 댓글에 지역 해시태그를 최대 5개 더. 댓글 해시태그가 검색에 잡히는지는
    check_hashtag_visibility가 2시간 뒤 직접 확인해 private_log에 남긴다."""
    theme = p.get("theme") or {}
    food = re.sub(r"\s", "", theme.get("food") or theme.get("keyword") or "")
    tags = []
    if theme.get("mode") == "area" and theme.get("keyword"):
        kw = re.sub(r"\s|·", "", theme["keyword"])
        tags += [f"{kw}맛집", f"{kw}맛집추천"]
    sidos = []
    for pl in p.get("places") or []:
        s = (pl.get("region") or "").split(" ")[0]
        if s and not s.endswith("역") and s not in sidos:
            sidos.append(s)
    for s in sidos[:3]:
        tags.append(f"{s}맛집")
        if food and theme.get("mode") not in ("area", "density"):
            tags.append(f"{s}{food}")
    out = []
    for t in tags:
        if t not in out and re.fullmatch(r"[가-힣A-Za-z0-9]+", t):
            out.append(t)
    return out[:5]


def remember_hashtag_check(media_pk, tags: list):
    if tags:
        state_set(f"htcheck:{media_pk}", json.dumps({"tags": tags, "at": time.time(), "done": False}, ensure_ascii=False))


def check_hashtag_visibility(c):
    """댓글에 단 해시태그 페이지(최근 게시물)에 우리 게시물이 뜨는지 2~24시간 사이에 한 번 확인."""
    for r in db("SELECT key, value FROM private_log WHERE key LIKE 'htcheck:%'")["rows"]:
        v = json.loads(r["value"])
        if v.get("done") or time.time() - v["at"] < 2 * 3600:
            continue
        pk = r["key"].split(":", 1)[1]
        found = {}
        for t in v["tags"][:2]:
            try:
                found[t] = any(str(m.pk) == pk for m in c.hashtag_medias_recent(t, amount=60))
            except Exception as e:
                if _blocked(e):
                    raise
                found[t] = None
            nap(5, 15)
        v.update({"done": True, "found": found})
        state_set(r["key"], json.dumps(v, ensure_ascii=False))
        log.info(f"#️⃣ 댓글 해시태그 노출 확인 {pk}: {found}")
