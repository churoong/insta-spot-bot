"""계정 활성화 기능 묶음 — 2026-10-27 사용자 결정("하이리스크 하이리턴, 계정 활성화만 된다면 뭐든").

  find_restaurant_account  식당 인스타 계정 찾기 → 릴스 사람 태그(식당이 알림 받고 스토리 공유하길 기대)
  trending_track           맛집 태그 인기 릴스들이 쓴 음원을 세어 오늘의 음원 선택
  reply_own_comments       우리 게시물 댓글에 하트 + 짧은 답글
  pin_hits / add_to_highlight  조회 1,000+ 게시물 프로필 고정, 스토리를 음식별 하이라이트로
  targeted_likes           큰 맛집 계정 최근 게시물에 댓글 단 사람들의 게시물에 좋아요
  auto_comments            남의 맛집 인기 게시물(좋아요 100+ 또는 재생 5천+, 3일 이내)에 내용을 짚는 댓글 + 좋아요(하루 8~12개)

공통 원칙: 하루 상한 + 무작위 간격, 차단 신호가 오면 호출부(agent.pause)가 전부 멈춘다.
댓글은 LLM이 그 게시물·댓글 내용을 보고 쓴다. 생성에 실패하면 '안 단다' — 아무 데나 붙는
템플릿 댓글은 스팸으로 신고·필터되기 쉽다. 홍보·링크·맞팔 요청·조건형 팔로우 유도는 절대 넣지 않는다.
"""
from __future__ import annotations

import json
import random
import re
from collections import Counter

from common import ROOT, db, get_logger, like_too, llm, nap, now_kst, online_slot, state_get, state_set

log = get_logger("agent")

FOOD_TAGS = ["맛집", "맛집추천", "국밥맛집", "먹스타그램", "노포맛집", "전국맛집"]
COMMENT_TAGS = ["국밥맛집", "순대국", "칼국수맛집", "냉면맛집", "해장국", "노포맛집", "서울맛집", "부산맛집"]
REPLIES_PER_DAY = 30
TARGET_LIKES_PER_DAY = (12, 18)
COMMENTS_PER_DAY = (8, 12)
# 남의 게시물 댓글 대상 = 노출이 큰 게시물(2026-10-27 사용자: "너무 비주류 계정 위주") — 최근 게시물 탭은
# 방금 올라온 작은 계정 글이라 우리 댓글을 볼 사람이 거의 없다. 인기 게시물 탭 + 반응 하한 + 3일 이내.
COMMENT_MIN_LIKES = 100
COMMENT_MIN_PLAYS = 5000
COMMENT_MAX_AGE_DAYS = 3


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
            # 같은 사람과 한 게시물에서 답글은 두 번까지 — 첫 답글은 질문으로 끝내 대화를 잇고, 두 번째는 마무리
            nth = int(state_get(f"crn:{media_id}:{cm.user.pk}") or 0)
            if nth >= 2:
                state_set(f"cr:{cm.pk}", "1")
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
            # 댓글에 지역이 나오면 그 지역 맛집 리스트를 DM으로 보내고, 공개 답글은 그 사실만
            import engage
            if engage.dm_commenter(c, str(cm.user.pk), cm.user.username, text):
                c.media_comment(media_id, f"@{cm.user.username} 근처 맛집 DM으로 보내드렸어요 😊", replied_to_comment_id=cm.pk)
                used += 1
                nap(40, 120)
                continue
            reply = llm(
                "인스타 맛집 큐레이션 계정 운영자로서 아래 댓글에 답글 한 문장을 써라. "
                "존댓말, 25자 안팎, 이모지 최대 1개, 링크·해시태그·홍보·팔로우 요청 금지. 식당·음식은 언제나 긍정적으로만 말할 것(단점·아쉬움·비교 우열·호불호 금지). 부정적인 댓글에도 반박 없이 감사·공감으로. "
                + ("공감 뒤 그 사람의 경험·취향을 묻는 짧은 질문으로 끝낼 것(예: '어떤 메뉴가 제일 좋으셨어요?'). " if nth == 0 else "질문 없이 감사로 마무리할 것. ")
                + "답글만 출력.\n"
                f"게시물: {title}\n댓글: {text}", 70)
            if not reply:
                continue
            try:
                c.media_comment(media_id, f"@{cm.user.username} {reply}", replied_to_comment_id=cm.pk)
                state_set(f"crn:{media_id}:{cm.user.pk}", str(nth + 1))
                used += 1
                log.info(f"💬 답글: {reply}")
            except Exception as e:
                log.warning(f"답글 실패: {str(e)[:100]}")
                raise
            nap(40, 120)
        nap(10, 30)
    state_set(f"replies:{today()}", str(used))


# ---------- 계정 이름 변경(2026-10-27 사용자: "맛디깅으로 바꿔줘") ----------
OLD_BRAND, NEW_BRAND = "먹짱", "맛디깅"


def rename_profile(c):
    """프로필 이름·소개의 옛 브랜드를 새 이름으로 1회 바꾼다. 나머지 글자(|전국 맛집 지도… 등)는 그대로.
    인스타 이름 변경은 14일에 2번 — 거부되면 하루 뒤 다시 시도한다(성공 전까지 매일 1회)."""
    if state_get(f"rename:{NEW_BRAND}") or state_get(f"rename-try:{today()}"):
        return
    state_set(f"rename-try:{today()}", "1")
    me = c.account_info()
    name, bio = me.full_name or "", me.biography or ""
    if OLD_BRAND not in name and OLD_BRAND not in bio:
        state_set(f"rename:{NEW_BRAND}", "already")
        return
    state_set("profile:backup-before-rename", json.dumps({"full_name": name, "biography": bio}, ensure_ascii=False))
    new_name = name.replace(OLD_BRAND, NEW_BRAND)
    new_bio = bio.replace(OLD_BRAND, NEW_BRAND)
    try:
        # 빠뜨린 필드가 비워지지 않게 현재 값을 같이 보낸다
        c.account_edit(full_name=new_name, biography=new_bio, external_url=str(me.external_url or ""))
    except Exception as e:
        log.warning(f"프로필 이름 변경 실패(내일 재시도): {str(e)[:150]}")
        if any(k in type(e).__name__ for k in ("Challenge", "PleaseWait", "Feedback", "LoginRequired", "Checkpoint")):
            raise
        return
    state_set(f"rename:{NEW_BRAND}", new_name)
    log.info(f"🪪 프로필 이름 변경: {name} → {new_name}")


# ---------- 아이디 변경(2026-10-27 사용자: 아이디도 맛디깅으로) ----------
HANDLE_CANDIDATES = ["matdigging", "mat.digging", "matdigging.kr"]


def rename_handle(c):
    """아이디를 후보 순서대로 시도해 비어 있는 첫 번째로 바꾼다. 성공하면
    ① config.ig_handle(표지·카드·스레드·공개 페이지가 읽는 값) ② .env IG_USERNAME(다음 로그인용)을 고친다.
    프로필 이름 변경이 끝난 뒤에만 — 같은 날 계정 정보를 두 번 크게 바꾸지 않는다. 실패하면 하루 뒤 재시도."""
    if state_get("handle:done") or state_get(f"handle-try:{today()}"):
        return
    state_set(f"handle-try:{today()}", "1")
    # 사용자가 앱에서 직접 바꿨을 수 있다(2026-10-28 실제로 matdigging으로 직접 변경) — 그러면 맞추기만 한다
    me = c.account_info()
    if me.username in HANDLE_CANDIDATES:
        _handle_done(me.username)
        log.info(f"🪪 아이디가 이미 @{me.username} — config·.env만 맞춤")
        return
    if not state_get(f"rename:{NEW_BRAND}") or state_get(f"rename-try:{today()}"):
        return  # 직접 바꾸는 건 프로필 이름 변경 다음 날 이후
    state_set("profile:username-before", me.username)
    for cand in HANDLE_CANDIDATES:
        try:
            c.account_edit(username=cand, full_name=me.full_name or "", biography=me.biography or "",
                           external_url=str(me.external_url or ""))
        except Exception as e:
            if any(k in type(e).__name__ for k in ("Challenge", "PleaseWait", "Feedback", "LoginRequired", "Checkpoint")):
                raise
            log.warning(f"아이디 @{cand} 실패: {str(e)[:120]}")
            nap(20, 60)
            continue
        _handle_done(cand)
        log.info(f"🪪 아이디 변경: @{me.username} → @{cand}")
        return
    log.warning("아이디 후보가 전부 실패 — 내일 다시 시도")


def _handle_done(handle: str):
    db("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('ig_handle', ?, datetime('now'))", [handle])
    state_set("handle:done", handle)
    env = ROOT.parent / ".env"
    try:
        lines = env.read_text(encoding="utf-8").splitlines()
        lines = [f"IG_USERNAME={handle}" if l.startswith("IG_USERNAME=") else l for l in lines]
        env.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except Exception as e:
        log.warning(f".env IG_USERNAME 갱신 실패 — 직접 고쳐야 다음 로그인이 된다: {e}")


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
        slot = online_slot()
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


# ---------- 큰 맛집 계정 새 게시물에 빠른 첫 댓글(2026-10-27 사용자 결정) ----------
FAST_PER_DAY = 5
FAST_WINDOW_MIN = 20


def fast_first_comments(c):
    """팔로워 5만+ 맛집 계정이 올린 지 20분 안 된 게시물에 내용 있는 댓글을 단다(상위 댓글 노출).
    새 게시물 감지는 홈 피드 한 번으로 한다 — 계정마다 조회하면 호출이 수십 배다. 그래서 큰 계정은 팔로우해 둔다.
    하루 5개, 한 계정에 하루 1개, 09~23시만."""
    import time as _t
    h = now_kst().hour
    if h < 9 or h >= 23:
        return
    used = int(state_get(f"fast:{today()}") or 0)
    if used >= FAST_PER_DAY:
        return
    big = big_food_accounts(c)
    if not big:
        return
    for uid in big[:12]:
        if not state_get(f"followbig:{uid}"):
            c.user_follow(uid)
            state_set(f"followbig:{uid}", "1")
            log.info(f"➕ 큰 맛집 계정 팔로우: {uid}")
            return  # 한 바퀴에 한 계정만 — 몰아서 팔로우하지 않는다
    feed = c.get_timeline_feed()
    bigset = set(big)
    for it in feed.get("feed_items", []):
        m = it.get("media_or_ad") or {}
        uid = str((m.get("user") or {}).get("pk") or "")
        if uid not in bigset or _t.time() - int(m.get("taken_at") or 0) > FAST_WINDOW_MIN * 60:
            continue
        if state_get(f"fast-u:{uid}:{today()}") or state_get(f"fast-m:{m.get('id')}"):
            continue
        cap = str((m.get("caption") or {}).get("text") or "")
        if len(cap) < 15:
            continue
        text = llm(
            "아래 인스타 맛집 게시물에 진짜 사람이 다는 듯한 댓글 한 문장을 써라. 게시물의 음식·가게를 구체적으로 짚을 것. "
            "존댓말, 30자 안팎, 이모지 최대 1개. 식당·음식은 언제나 긍정적으로만 말할 것(단점·아쉬움·비교 우열·호불호 금지). 금지: 링크, 해시태그, 계정 홍보, 맞팔·팔로우 요청, 뻔한 말. 댓글만 출력.\n게시물: " + cap[:400], 70)
        if not text or re.search(r"팔로우|맞팔|선팔|http|#", text):
            continue
        state_set(f"fast-m:{m.get('id')}", "1")
        nap(30, 120)  # 올라오자마자 0초 댓글은 봇 티가 난다
        c.media_comment(str(m.get("id")), text)
        like_too(c, str(m.get("id")), bool(m.get("has_liked")))
        state_set(f"fast-u:{uid}:{today()}", "1")
        state_set(f"fast:{today()}", str(used + 1))
        log.info(f"⚡ 큰 계정 새 게시물 첫 댓글(@{(m.get('user') or {}).get('username')}): {text}")
        return



# ---------- 남의 게시물 자동 댓글 ----------
def _plays(m) -> int:
    return int(getattr(m, "play_count", 0) or getattr(m, "view_count", 0) or 0)


def popular_medias(c, tag: str) -> list:
    """해시태그 인기 게시물 중 반응 하한을 넘고 3일 안 된 것, 반응 큰 순.
    인기 탭이 비거나 다 걸러지면 최근 게시물에서 같은 하한으로 보충한다(하한은 낮추지 않는다 — 못 찾으면 그 태그는 건너뜀)."""
    import time as _t
    out, seen = [], set()
    for fetch in (lambda: c.hashtag_medias_top(tag, amount=9), lambda: c.hashtag_medias_recent(tag, amount=30)):
        if len(out) >= 4:
            break
        for m in fetch():
            if m.id in seen:
                continue
            seen.add(m.id)
            age = _t.time() - m.taken_at.timestamp()
            if age > COMMENT_MAX_AGE_DAYS * 86400:
                continue
            if (m.like_count or 0) >= COMMENT_MIN_LIKES or _plays(m) >= COMMENT_MIN_PLAYS:
                out.append(m)
        nap(3, 8)
    out.sort(key=lambda m: (m.like_count or 0) * 50 + _plays(m), reverse=True)
    return out


def auto_comments(c):
    if state_get(f"acom:{today()}"):
        return
    slot = state_get(f"acom-at:{today()}")
    if not slot:
        slot = online_slot()
        state_set(f"acom-at:{today()}", slot)
    if f"{now_kst():%H:%M}" < slot:
        return
    goal, done = random.randint(*COMMENTS_PER_DAY), 0
    me = str(c.user_id)
    try:
        for tag in random.sample(COMMENT_TAGS, 3):
            if done >= goal:
                break
            medias = popular_medias(c, tag)
            for m in medias[:8]:
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
                    "'좋은 정보 감사합니다' 같은 뻔한 말. 식당·음식은 언제나 긍정적으로만 말할 것(단점·아쉬움·비교 우열·호불호 금지). 댓글만 출력.\n게시물: " + cap[:400], 70)
                if not text or re.search(r"팔로우|맞팔|선팔|http|#", text):
                    continue
                try:
                    c.media_comment(m.id, text)
                    like_too(c, m.id, getattr(m, "has_liked", False))
                    done += 1
                    db("INSERT OR REPLACE INTO private_log (key, value, updated_at) VALUES (?, ?, datetime('now', '+30 days'))", [f"acom-u:{uid}", "1"])
                    log.info(f"🗨 댓글(#{tag} ❤{m.like_count} ▶{_plays(m)}): {text}")
                except Exception as e:
                    log.warning(f"댓글 실패: {str(e)[:100]}")
                    raise
                nap(180, 480)
            nap(60, 180)
    finally:
        state_set(f"acom:{today()}", str(done))
        log.info(f"🗨 오늘 남의 게시물 댓글 {done}개")


# ---------- 검색 수요로 주제 고르기(2026-10-27 사용자 결정) ----------
DEMAND_REGION = re.compile(r"(서울|부산|대구|인천|광주|대전|울산|제주|수원|전주|강릉|경주|여수|춘천|창원|포항|\S+역|\S+동|맛집|근처|추천)")


def demand_snapshot(c):
    """하루 1회(06~10시): 음식 테마마다 ① 인스타 검색 자동완성(지금 사람들이 치는 말) ② '<음식>맛집' 해시태그
    게시물 수를 기록하고, 이를 합쳐 테마 가중치 배수(1.0~2.0)를 DB config 'trend_boost'에 쓴다.
    make-roundup의 themeWeights가 이 배수를 곱한다(3일 넘은 값은 무시).
      - 자동완성 중 '지역·역·맛집·추천' 같은 찾아가려는 검색어가 많을수록 +
      - 해시태그 게시물 수가 지난주보다 빨리 늘수록 +(7일치 쌓인 뒤부터)"""
    h = now_kst().hour
    if h < 6 or now_kst().strftime("%H:%M") >= "11:10" or state_get(f"demand:{today()}"):
        return
    state_set(f"demand:{today()}", "running")
    themes = json.loads((ROOT.parent / "data" / "roundup-themes.json").read_text(encoding="utf-8"))["themes"]
    foods = sorted({t.get("food") or t.get("keyword") for t in themes if t.get("mode") != "area" and not t.get("maxPrice")})
    intent, growth, top = {}, {}, {}
    for f in foods:
        try:
            r = c.fbsearch_keyword_typeahead(f)
            names = [x.get("keyword", {}).get("name", "") for x in (r.get("list") or [])][:15]
            top[f] = names[:5]
            intent[f] = sum(1 for n in names if f in n and DEMAND_REGION.search(n))
            nap(4, 10)
            info = c.hashtag_info(f"{f}맛집")
            state_set(f"tagcnt:{f}:{today()}", str(info.media_count))
            week_ago = state_get(f"tagcnt:{f}:{(now_kst() - __import__('datetime').timedelta(days=7)):%Y-%m-%d}")
            if week_ago and int(week_ago) > 0:
                growth[f] = (info.media_count - int(week_ago)) / int(week_ago)
        except Exception as e:
            log.warning(f"수요 수집 실패({f}): {str(e)[:100]}")
            if any(k in type(e).__name__ for k in ("Challenge", "PleaseWait", "Feedback", "LoginRequired")):
                raise
        nap(8, 20)

    def pct(d: dict) -> dict:
        vals = sorted(d.values())
        return {k: (vals.index(v) / max(1, len(vals) - 1)) for k, v in d.items()} if vals else {}

    pi, pg = pct(intent), pct(growth)
    boost = {f: round(1.0 + 0.5 * pi.get(f, 0) + 0.5 * pg.get(f, 0), 2) for f in foods}
    boost["_at"] = today()
    db("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('trend_boost', ?, datetime('now'))", [json.dumps(boost, ensure_ascii=False)])
    state_set(f"demand:{today()}", json.dumps({"top": top}, ensure_ascii=False)[:4000])
    best = sorted(((v, k) for k, v in boost.items() if k != "_at"), reverse=True)[:5]
    log.info(f"🔎 오늘 검색 수요 상위: {best} (성장률 표본 {len(growth)}개)")
