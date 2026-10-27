"""계정 활성화 기능 묶음 — 2026-10-27 사용자 결정("하이리스크 하이리턴, 계정 활성화만 된다면 뭐든").

  find_restaurant_account  식당 인스타 계정 찾기 → 릴스 사람 태그(식당이 알림 받고 스토리 공유하길 기대)
  trending_track           맛집 태그 인기 릴스들이 쓴 음원을 세어 오늘의 음원 선택
  reply_own_comments       우리 게시물 댓글에 하트 + 짧은 답글
  pin_hits / add_to_highlight  조회 1,000+ 게시물 프로필 고정, 스토리를 음식별 하이라이트로
  targeted_likes           큰 맛집 계정 최근 게시물에 댓글 단 사람들의 게시물에 좋아요
  auto_comments            남의 맛집 게시물에 그 게시물 내용을 짚는 댓글(하루 8~12개)

공통 원칙: 하루 상한 + 무작위 간격, 차단 신호가 오면 호출부(agent.pause)가 전부 멈춘다.
댓글은 LLM이 그 게시물·댓글 내용을 보고 쓴다. 생성에 실패하면 '안 단다' — 아무 데나 붙는
템플릿 댓글은 스팸으로 신고·필터되기 쉽다. 홍보·링크·맞팔 요청·조건형 팔로우 유도는 절대 넣지 않는다.
"""
from __future__ import annotations

import json
import random
import re
from collections import Counter

from common import ROOT, db, get_logger, llm, nap, now_kst, state_get, state_set

log = get_logger("agent")

FOOD_TAGS = ["맛집", "맛집추천", "국밥맛집", "먹스타그램", "노포맛집", "전국맛집"]
COMMENT_TAGS = ["국밥맛집", "순대국", "칼국수맛집", "냉면맛집", "해장국", "노포맛집", "서울맛집", "부산맛집"]
REPLIES_PER_DAY = 30
TARGET_LIKES_PER_DAY = (12, 18)
COMMENTS_PER_DAY = (8, 12)


def _norm(s: str) -> str:
    return re.sub(r"[\s()·.\-_&]|본점|지점|점$|official|kr$", "", str(s or "").lower())


def today() -> str:
    return f"{now_kst():%Y-%m-%d}"


# ---------- 식당 계정 찾기 + 태그 ----------
def find_restaurant_account(c, name: str, region: str = "", address: str = ""):
    """이름이 맞고(양방향 포함) 식당으로 보이는 계정만. 확신이 없으면 None — 엉뚱한 계정을 태그하면
    그 사람에게 스팸이고 우리 신뢰도도 깎인다. 결과는 DB에 캐시(없음도 캐시)."""
    key = f"igacct:{_norm(name)}:{region}"
    hit = state_get(key)
    if hit is not None:
        return json.loads(hit) or None
    found = None
    try:
        nn = _norm(name)
        if len(nn) >= 2:
            # search_users(검색 v1·fbsearch)는 검색어와 무관한 추천 계정만 돌려준다(2026-10-27 실측).
            # 계정 탭 검색(fbsearch_accounts_v2)은 제대로 동작한다.
            res = c.fbsearch_accounts_v2(name)
            region_tok = [t for t in re.split(r"\s+", f"{region} {address}") if len(t) >= 2 and not re.fullmatch(r"\d.*", t)][:4]
            cands = (res.get("users", []) if isinstance(res, dict) else [])[:8]
            # 계정 이름에 지역이 적힌 후보(예: "팔천순대 종로 광장시장점")를 먼저 본다 — 같은 상호 체인·트럭이 많다
            cands.sort(key=lambda d: not any(t[:2] in str(d.get("full_name", "")) for t in region_tok))
            for d in cands[:5]:
                u = type("U", (), {"pk": str(d.get("pk") or d.get("pk_id") or d.get("id")), "username": d.get("username", ""), "full_name": d.get("full_name", "")})
                un, fn = _norm(u.username), _norm(u.full_name)
                if not (nn in fn or nn in un or (fn and fn in nn and len(fn) >= 3)):
                    continue
                nap(2, 5)
                info = c.user_info(u.pk)
                text = f"{u.full_name} {info.biography or ''} {info.category or ''} {info.city_name or ''} {getattr(info, 'address_street', '') or ''}"
                foodish = bool(re.search(r"음식|식당|맛집|국밥|면|고기|Restaurant|Food|Korean", text, re.I)) or info.is_business
                local = any(t[:2] in text for t in region_tok) if region_tok else False
                if foodish and (local or nn == fn or nn == un):
                    found = {"pk": str(info.pk), "username": info.username}
                    break
    except Exception as e:
        log.warning(f"식당 계정 검색 실패({name}): {str(e)[:120]}")
        raise
    state_set(key, json.dumps(found or {}))
    if found:
        log.info(f"🏷 식당 계정: {name} → @{found['username']}")
    return found


def usertags_for(c, places: list) -> list:
    """그리드 표지 칸 위치(2열×3행)에 맞춰 태그 좌표를 둔다."""
    from instagrapi.types import UserShort, Usertag
    tags = []
    for i, p in enumerate(places[:6]):
        acc = find_restaurant_account(c, p.get("name", ""), p.get("region", ""), p.get("address", ""))
        if not acc:
            continue
        x = 0.25 if i % 2 == 0 else 0.75
        y = [0.42, 0.65, 0.87][min(i // 2, 2)]
        tags.append(Usertag(user=UserShort(pk=acc["pk"], username=acc["username"]), x=x, y=y))
        nap(2, 6)
    return tags


# ---------- 오늘의 음원 ----------
def trending_track(c, skip: int = 0):
    """맛집 태그 인기 릴스들이 쓴 음원(제목·가수)만 센다 — 남의 영상은 쓰지 않는다."""
    k = f"music:{today()}"
    cached = state_get(k)
    if cached is None:
        cnt = Counter()
        for tag in random.sample(FOOD_TAGS, 3):
            try:
                for m in c.hashtag_medias_top(tag, amount=9):
                    cm = m.clips_metadata
                    mi = (cm.get("music_info") if isinstance(cm, dict) else getattr(cm, "music_info", None)) if cm else None
                    asset = (mi or {}).get("music_asset_info") or {}
                    if asset.get("title"):
                        cnt[(asset["title"], asset.get("display_artist", ""))] += 1
            except Exception as e:
                log.warning(f"인기 음원 집계 실패(#{tag}): {str(e)[:100]}")
                if "Challenge" in type(e).__name__ or "PleaseWait" in type(e).__name__:
                    raise
            nap(3, 8)
        top = cnt.most_common(3)
        state_set(k, json.dumps(top, ensure_ascii=False))
        cached = json.dumps(top, ensure_ascii=False)
        if top:
            log.info(f"🎵 오늘 맛집 릴스 인기 음원: {top}")
    for (title, artist), _n in json.loads(cached)[skip:]:
        try:
            for t in c.search_music(f"{title} {artist}".strip())[:5]:
                if _norm(title) in _norm(t.title) and not t.is_explicit and (t.uri or t.progressive_download_url):
                    return t
        except Exception as e:
            log.warning(f"음원 검색 실패({title}): {str(e)[:100]}")
        nap(2, 5)
    return None


# ---------- 하이라이트·고정 ----------
def highlight_title(theme: dict) -> str:
    food = f"{theme.get('food', '')}{theme.get('keyword', '')}"
    if theme.get("mode") == "area":
        return "동네맛집"
    if re.search(r"국밥|탕|국$|순대|해장|찌개|곰탕|설렁|백숙|삼계", food):
        return "국물"
    if re.search(r"면|국수|냉면|짬뽕|칼국수|라면|우동|막국수|밀면", food):
        return "면요리"
    return "맛집"


def add_to_highlight(c, story_pk, theme: dict):
    title = highlight_title(theme or {})
    key = f"hl:{title}"
    try:
        hl = state_get(key)
        if hl:
            c.highlight_add_stories(hl, [str(story_pk)])
        else:
            h = c.highlight_create(title, [str(story_pk)])
            state_set(key, str(h.pk))
        log.info(f"⭐ 하이라이트 '{title}'에 추가")
    except Exception as e:
        log.warning(f"하이라이트 실패: {str(e)[:120]}")


def pin_hits(c, media_pk_of):
    """조회 1,000+ 상위 3개를 프로필에 고정(인스타 고정 한도 3). 하루 1회."""
    if state_get(f"pin:{today()}"):
        return
    state_set(f"pin:{today()}", "1")
    rows = db("""SELECT content_id, ig_media_id, views FROM posts WHERE status = 'published'
                 AND views >= 1000 AND ig_media_id IS NOT NULL ORDER BY views DESC LIMIT 3""")["rows"]
    want = []
    for r in rows:
        pk = media_pk_of(r["ig_media_id"])
        if pk:
            want.append((str(pk), r["content_id"], r["views"]))
    pinned = json.loads(state_get("pinned") or "[]")
    for pk, cid, v in want:
        if pk in pinned:
            continue
        try:
            if len(pinned) >= 3:
                old = pinned.pop(0)
                c.media_unpin(old)
                nap(3, 8)
            c.media_pin(pk)
            pinned.append(pk)
            log.info(f"📍 프로필 고정: {cid} (조회 {v})")
        except Exception as e:
            log.warning(f"고정 실패 {cid}: {str(e)[:120]}")
        nap(5, 15)
    state_set("pinned", json.dumps(pinned))


# ---------- 우리 게시물 댓글 응대 ----------
def reply_own_comments(c, own_media: list):
    """own_media: [(media_id, caption_title)] 최근 7일 우리 게시물."""
    used = int(state_get(f"replies:{today()}") or 0)
    me = str(c.user_id)
    for media_id, title in own_media:
        if used >= REPLIES_PER_DAY:
            break
        try:
            comments = c.media_comments(media_id, amount=30)
        except Exception as e:
            log.warning(f"댓글 조회 실패: {str(e)[:100]}")
            raise
        for cm in comments:
            if used >= REPLIES_PER_DAY:
                break
            if str(cm.user.pk) == me or state_get(f"cr:{cm.pk}"):
                continue
            state_set(f"cr:{cm.pk}", "1")
            text = (cm.text or "").strip()
            try:
                c.comment_like(cm.pk)
            except Exception:
                pass
            nap(5, 20)
            # 이모지·짧은 감탄만 있으면 하트만. '지도' 요청은 웹훅이 DM을 보낸다.
            if len(re.sub(r"[^\w가-힣]", "", text)) < 3 or re.fullmatch(r"\s*지도\s*[!?.~요]*\s*", text):
                continue
            reply = llm(
                "인스타 맛집 큐레이션 계정 운영자로서 아래 댓글에 답글 한 문장을 써라. "
                "존댓말, 25자 안팎, 이모지 최대 1개, 링크·해시태그·홍보·팔로우 요청 금지. 답글만 출력.\n"
                f"게시물: {title}\n댓글: {text}", 60)
            if not reply:
                continue
            try:
                c.media_comment(media_id, f"@{cm.user.username} {reply}", replied_to_comment_id=cm.pk)
                used += 1
                log.info(f"💬 답글: {reply}")
            except Exception as e:
                log.warning(f"답글 실패: {str(e)[:100]}")
                raise
            nap(40, 120)
        nap(10, 30)
    state_set(f"replies:{today()}", str(used))


# ---------- 타깃 좋아요 ----------
def big_food_accounts(c) -> list:
    """맛집 태그 인기 게시물 작성자 중 팔로워 5만+ 계정(주 1회 갱신)."""
    k = f"bigacc:{now_kst():%G-%V}"
    cached = state_get(k)
    if cached:
        return json.loads(cached)
    seen, out = set(), []
    for tag in random.sample(FOOD_TAGS, 2):
        for m in c.hashtag_medias_top(tag, amount=9):
            uid = str(m.user.pk)
            if uid in seen:
                continue
            seen.add(uid)
            nap(2, 5)
            try:
                info = c.user_info(uid)
                if info.follower_count >= 50000:
                    out.append(uid)
            except Exception:
                pass
        nap(3, 8)
    state_set(k, json.dumps(out))
    log.info(f"큰 맛집 계정 {len(out)}개")
    return out


def targeted_likes(c):
    if state_get(f"tlikes:{today()}"):
        return
    slot = state_get(f"tlikes-at:{today()}")
    if not slot:
        slot = f"{random.randint(12, 21):02d}:{random.randint(0, 59):02d}"
        state_set(f"tlikes-at:{today()}", slot)
    if f"{now_kst():%H:%M}" < slot:
        return
    goal, done = random.randint(*TARGET_LIKES_PER_DAY), 0
    try:
        accs = big_food_accounts(c)
        if not accs:
            state_set(f"tlikes:{today()}", "0")
            return
        src = c.user_medias(random.choice(accs), amount=1)
        if not src:
            state_set(f"tlikes:{today()}", "0")
            return
        commenters = {str(cm.user.pk) for cm in c.media_comments(src[0].id, amount=40)} - {str(c.user_id)}
        for uid in random.sample(sorted(commenters), min(len(commenters), goal * 2)):
            if done >= goal:
                break
            try:
                ms = c.user_medias(uid, amount=1)
                if ms and not getattr(ms[0], "has_liked", False):
                    c.media_like(ms[0].id)
                    done += 1
            except Exception as e:
                if "Private" in type(e).__name__ or "NotFound" in type(e).__name__:
                    continue
                raise
            nap(40, 110)
    finally:
        state_set(f"tlikes:{today()}", str(done))
        log.info(f"🎯 타깃 좋아요 {done}개")


# ---------- 남의 게시물 자동 댓글 ----------
def auto_comments(c):
    if state_get(f"acom:{today()}"):
        return
    slot = state_get(f"acom-at:{today()}")
    if not slot:
        slot = f"{random.randint(11, 20):02d}:{random.randint(0, 59):02d}"
        state_set(f"acom-at:{today()}", slot)
    if f"{now_kst():%H:%M}" < slot:
        return
    goal, done = random.randint(*COMMENTS_PER_DAY), 0
    me = str(c.user_id)
    try:
        for tag in random.sample(COMMENT_TAGS, 3):
            if done >= goal:
                break
            medias = c.hashtag_medias_recent(tag, amount=20)
            for m in random.sample(medias, min(len(medias), 8)):
                if done >= goal:
                    break
                uid = str(m.user.pk)
                cap = (m.caption_text or "").strip()
                if uid == me or len(cap) < 20 or getattr(m, "comments_disabled", False):
                    continue
                # 같은 사람에게는 30일 안에 다시 안 단다(updated_at에 만료 시각을 넣어 둔다)
                if db("SELECT 1 FROM private_log WHERE key = ? AND updated_at > datetime('now')", [f"acom-u:{uid}"])["rows"]:
                    continue
                text = llm(
                    "아래 인스타 맛집 게시물에 진짜 사람이 다는 듯한 댓글 한 문장을 써라. 게시물에 나온 음식이나 가게를 "
                    "구체적으로 짚을 것. 존댓말, 30자 안팎, 이모지 최대 1개. 금지: 링크, 해시태그, 계정 홍보, 맞팔·선팔·팔로우 요청, "
                    "'좋은 정보 감사합니다' 같은 뻔한 말. 댓글만 출력.\n게시물: " + cap[:400], 70)
                if not text or re.search(r"팔로우|맞팔|선팔|http|#", text):
                    continue
                try:
                    c.media_comment(m.id, text)
                    done += 1
                    db("INSERT OR REPLACE INTO private_log (key, value, updated_at) VALUES (?, ?, datetime('now', '+30 days'))", [f"acom-u:{uid}", "1"])
                    log.info(f"🗨 댓글(#{tag}): {text}")
                except Exception as e:
                    log.warning(f"댓글 실패: {str(e)[:100]}")
                    raise
                nap(180, 480)
            nap(60, 180)
    finally:
        state_set(f"acom:{today()}", str(done))
        log.info(f"🗨 오늘 남의 게시물 댓글 {done}개")
