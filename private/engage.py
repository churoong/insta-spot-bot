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
from urllib.parse import quote

import requests

from common import ENV, db, get_logger, llm, nap, now_kst, online_slot, state_get, state_set

log = get_logger("agent")
VISITED_LIKES, VISITED_COMMENTS = 15, 5
STORY_USERS_PER_DAY, STORY_LIKES_PER_DAY, STORY_USERS_PER_ROUND = 150, 10, 30
WELCOME_PER_DAY = 20
COMMENTER_DM_PER_DAY = 10
PEER_LIKES_PER_DAY = 15
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


def near_list(name: str, x: float, y: float, food: str = "") -> str:
    """우리가 소개한 집(map_pins) 5km 안 우선, 모자라면 카카오 음식점으로 채운다."""
    rows = db("SELECT name, address, x, y FROM map_pins")["rows"]
    def km(r):
        return math.hypot((float(r["x"]) - x) * 88.2, (float(r["y"]) - y) * 111)
    ours = sorted([r for r in rows if km(r) <= 5], key=km)[:5]
    lines = [f"{i + 1}. {r['name']} — 먹짱 소개 맛집\n   https://map.kakao.com/link/search/{quote(r['name'])}" for i, r in enumerate(ours)]
    if len(lines) < 5:
        q = f"{name} {food or '맛집'}".strip()
        for d in (_kakao(f"/v2/local/search/keyword.json?category_group_code=FD6&query={quote(q)}&x={x}&y={y}&radius=3000&sort=accuracy").get("documents") or []):
            if len(lines) >= 5:
                break
            if any(d["place_name"] in l for l in lines):
                continue
            lines.append(f"{len(lines) + 1}. {d['place_name']} ({d.get('category_name', '').split('>')[-1].strip()})\n   {d.get('place_url', '')}")
    if not lines:
        return ""
    return f"📍 {name} 근처 맛집이에요!\n\n" + "\n".join(lines) + "\n\n맛있는 한 끼 되세요 🍽️"


# ---------- 1·2) 소개한 식당 장소 피드 ----------
def visited_engage(c, find_location):
    if _count("visited-like") >= VISITED_LIKES and _count("visited-cmt") >= VISITED_COMMENTS:
        return
    if not _slot_passed("visited"):
        return
    rows = db("""SELECT m.name, m.address, m.x, m.y, p.place_name AS title FROM map_pins m
                 LEFT JOIN posts p ON p.content_id = m.content_id ORDER BY m.id DESC LIMIT 120""")["rows"]
    me = str(c.user_id)
    for r in random.sample(rows, min(6, len(rows))):
        if _count("visited-like") >= VISITED_LIKES and _count("visited-cmt") >= VISITED_COMMENTS:
            break
        key = f"locpk:{r['name']}"
        pk = state_get(key)
        if pk is None:
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
            if uid == me or (time.time() - m.taken_at.timestamp()) > 14 * 86400:
                continue
            if _count("visited-like") < VISITED_LIKES and not getattr(m, "has_liked", False):
                c.media_like(m.id)
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
        text = f"오늘 저녁 5시 · {SLOT_LABEL[dow]} 맛집 리스트 공개 🍲"
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
            if _count("story-like") < STORY_LIKES_PER_DAY and random.random() < 0.15:
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
        if str(msg.user_id) == me or state_get(f"dmdone:{msg.id}") or not msg.text:
            continue
        state_set(f"dmdone:{msg.id}", "1")
        if time.time() - msg.timestamp.timestamp() > 3 * 86400:
            continue
        g = geocode_text(msg.text)
        if not g:
            continue
        food = next((f for f in ["국밥", "냉면", "칼국수", "곱창", "짬뽕", "삼겹살", "회", "족발", "보쌈", "돈까스", "초밥", "해장국", "순대국"] if f in msg.text), "")
        body = near_list(g[0], g[1], g[2], food)
        if not body:
            continue
        nap(20, 60)
        c.direct_send(body, thread_ids=[int(th.id)])
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
