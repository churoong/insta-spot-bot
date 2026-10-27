"""비공식 API 에이전트 — 사용자 PC에서 상주(작업 스케줄러가 로그온 시 실행).
    python private/agent.py          # 상주 루프
    python private/agent.py --once   # 한 바퀴만(점검용)

하는 일(2026-10-27 사용자 결정 "본계정으로 다 진행해"):
  1) 발행 핸드오프: GitHub가 영상까지 만들어 posts.status='handoff'로 넘기면 가져가서
     인스타 음원 + 위치 태그를 붙여 릴스 발행 → 스토리(게시물·위치 스티커) → 첫 댓글 고정.
     에이전트가 10분 안에 안 가져가면 GitHub가 공식 API로 직접 발행한다(make-roundup handoffToPrivate).
  2) 사후 처리: 공식 경로로 나간 회차에도 위치 태그(게시물 수정)와 첫 댓글 고정.
  3) 자동 좋아요: 하루 1회, 음식 태그 최신 게시물 20개 안팎.
  4) 팔로잉 정리: 사용자가 확인한 목록(state/unfollow-approved.txt)만 하루 30개까지.
"""
from __future__ import annotations

import json
import random
import re
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

import requests

from common import (GRAPH, ROOT, SESSION, STATE, client, db, ensure_tables, get_logger,
                    graph_id_for_code, graph_token, nap, now_kst, state_get, state_set)
import growth

log = get_logger("agent")
START_DATE = "2026-10-27"  # 이 날짜 이후 발행분만 사후 처리(과거 게시물은 건드리지 않는다)
LIKE_TAGS = ["국밥맛집", "순대국", "칼국수맛집", "냉면맛집", "해장국", "짬뽕맛집", "맛집추천", "전국맛집", "노포맛집", "가성비맛집"]
LIKES_PER_DAY = (18, 26)
UNFOLLOW_PER_DAY = 30
UNFOLLOW_PER_RUN = 10

_cl = None
_paused_until = 0.0


def cl():
    global _cl
    if _cl is None:
        _cl = client(interactive=False)
    return _cl


def pause(hours: float, why: str):
    """보안 확인·활동 제한이 걸리면 비공식 호출을 한동안 완전히 멈춘다(계속 두드리면 더 나빠진다)."""
    global _paused_until, _cl
    _paused_until = time.time() + hours * 3600
    _cl = None
    log.error(f"⏸ {hours}시간 정지 — {why}")
    try:
        state_set("agent:paused", f"{now_kst():%m-%d %H:%M} {why}")
    except Exception:
        pass


def is_block(e: Exception) -> bool:
    n = type(e).__name__
    return any(k in n for k in ("Challenge", "LoginRequired", "Feedback", "PleaseWait", "RateLimit", "Checkpoint", "ClientForbidden"))


# ---------- 위치 ----------
def _norm(s: str) -> str:
    return re.sub(r"[\s()·.\-]|본점|지점|점$", "", str(s or ""))


def find_location(c, loc: dict | None):
    """상호(또는 동네) 이름으로 인스타 장소를 찾는다. 이름이 맞는 후보만 쓴다 — 엉뚱한 장소를 태그하느니 안 한다."""
    if not loc or not loc.get("query"):
        return None
    q = loc["query"]
    try:
        cands = []
        if loc.get("lat") and loc.get("lng"):
            cands = c.location_search(float(loc["lat"]), float(loc["lng"]))
        cands += c.fbsearch_places(q, lat=float(loc.get("lat") or 37.5665), lng=float(loc.get("lng") or 126.978))
        nq = _norm(q)
        city = (loc.get("address") or "").split(" ")[1:2]
        for x in cands:
            if nq and (nq in _norm(x.name) or _norm(x.name) in nq):
                if not city or not (x.address or x.city) or city[0][:2] in f"{x.address or ''} {x.city or ''}":
                    return x
        return None
    except Exception as e:
        log.warning(f"위치 검색 실패({q}): {str(e)[:120]}")
        if is_block(e):
            raise
        return None


# ---------- 음원 ----------
def pick_track(c):
    try:
        t = growth.trending_track(c)
        if t:
            log.info(f"🎵 음원(맛집 릴스 인기): {t.title} — {t.display_artist}")
            return t
    except Exception as e:
        if is_block(e):
            raise
        log.warning(f"인기 음원 실패(목록으로): {str(e)[:120]}")
    qs = [l.strip() for l in (ROOT / "music.txt").read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]
    random.shuffle(qs)
    for q in qs[:3]:
        try:
            for t in c.search_music(q):
                if not t.is_explicit and (t.uri or t.progressive_download_url):
                    log.info(f"🎵 음원: {t.title} — {t.display_artist} (검색어 {q})")
                    return t
        except Exception as e:
            log.warning(f"음원 검색 실패({q}): {str(e)[:120]}")
            if is_block(e):
                raise
        nap(2, 5)
    return None


def ffmpeg() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def video_seconds(p: Path) -> float:
    out = subprocess.run([ffmpeg(), "-i", str(p)], capture_output=True, text=True, encoding="utf-8", errors="ignore").stderr
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", out)
    return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3]) if m else 8.0


def with_music(c, video: Path, work: Path):
    """영상 소리를 인스타 음원으로 바꾼 파일과 음원 메타데이터를 돌려준다. 음원이 없으면 (None, None)."""
    t = pick_track(c)
    if not t:
        return None, None
    audio = c.track_download_by_url(str(t.uri or t.progressive_download_url), "track", work)
    dur = video_seconds(video)
    start = (t.highlight_start_times_in_ms or [0])[0] / 1000
    if t.duration_in_ms and start + dur > t.duration_in_ms / 1000:
        start = max(0.0, t.duration_in_ms / 1000 - dur)
    out = work / "reel_music.mp4"
    subprocess.run([ffmpeg(), "-y", "-i", str(video), "-ss", f"{start:.2f}", "-i", str(audio),
                    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
                    "-shortest", "-movflags", "+faststart", str(out)], check=True, capture_output=True)
    extra = c.clip_music_extra_data(t, audio_asset_start_time=int(start * 1000), overlap_duration=int(dur * 1000), original_volume=0.0)
    return out, extra


def download(url: str, dest: Path) -> Path:
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    dest.write_bytes(r.content)
    return dest


# ---------- 1) 발행 핸드오프 ----------
def handle_handoffs():
    rows = db("""SELECT content_id, handoff FROM posts WHERE status = 'handoff'
                 AND created_at >= datetime('now', '-3 hours') ORDER BY id""")["rows"]
    for row in rows:
        cid = row["content_id"]
        # 원자적 가져가기 — GitHub 쪽 되찾기(WHERE status='handoff')와 경합해도 한쪽만 이긴다
        got = db("UPDATE posts SET status = 'handoff_claimed' WHERE content_id = ? AND status = 'handoff'", [cid])
        if not got["affected"]:
            continue
        log.info(f"▶ 핸드오프 가져감: {cid}")
        published = False
        try:
            p = json.loads(row["handoff"] or "{}")
            c = cl()
            with tempfile.TemporaryDirectory() as tmp:
                work = Path(tmp)
                video = download(p["reel_url"], work / "reel.mp4")
                cover = download(p["cover_url"], work / "cover.jpg") if p.get("cover_url") else None
                loc = find_location(c, p.get("location"))
                log.info(f"📍 위치: {loc.name if loc else '없음'}")
                path, extra, caption = video, {}, p["caption"]
                if p.get("music_ok"):
                    try:
                        mv, mextra = with_music(c, video, work)
                        if mv:
                            path, extra = mv, mextra
                    except Exception as e:
                        if is_block(e):
                            raise
                        log.warning(f"음원 합치기 실패(기존 BGM으로): {str(e)[:160]}")
                if path is video and p.get("bgm_line"):
                    caption += "\n" + p["bgm_line"]  # 저작권 무료 BGM 그대로면 출처 표기 의무
                tags = []
                try:
                    tags = growth.usertags_for(c, p.get("places", []))
                    log.info(f"🏷 식당 태그 {len(tags)}곳")
                except Exception as e:
                    if is_block(e):
                        raise
                    log.warning(f"식당 태그 실패(태그 없이): {str(e)[:120]}")
                media = c.clip_upload(path, caption, thumbnail=cover, usertags=tags, location=loc, extra_data=extra)
                state_set(f"mid:{cid}", str(media.id))
                published = True
                log.info(f"✅ 릴스 발행: https://www.instagram.com/reel/{media.code}/")
                gid = graph_id_for_code(media.code) or f"private:{media.pk}"
                db("UPDATE posts SET status = 'published', ig_media_id = ? WHERE content_id = ?", [gid, cid])
                state_set(f"pp:{cid}", "handoff")
                after_publish(c, media.id, media.pk, p.get("first_comment"), cover, loc, p.get("theme"))
        except Exception as e:
            log.error(f"핸드오프 실패 {cid}: {type(e).__name__} {str(e)[:200]}")
            if not published:
                db("UPDATE posts SET status = 'handoff_failed' WHERE content_id = ? AND status = 'handoff_claimed'", [cid])
            if is_block(e):
                pause(6, f"핸드오프 중 차단 신호({type(e).__name__})")


def after_publish(c, media_id, media_pk, first_comment, cover, loc, theme=None):
    """첫 댓글 고정 → 스토리(게시물 스티커 + 위치 스티커). 실패해도 발행은 이미 끝났다."""
    from instagrapi.types import StoryLocation, StoryMedia
    if first_comment:
        try:
            nap(20, 50)
            cm = c.media_comment(media_id, first_comment)
            nap(3, 8)
            c.comment_pin(media_id, cm.pk)
            log.info(f"📌 첫 댓글 고정: {first_comment}")
        except Exception as e:
            log.warning(f"첫 댓글 실패: {str(e)[:160]}")
    if cover:
        try:
            nap(30, 90)
            medias = [StoryMedia(media_pk=int(media_pk), x=0.5, y=0.80, width=0.42, height=0.27)]
            locs = [StoryLocation(location=loc, x=0.5, y=0.11, width=0.5, height=0.06)] if loc else []
            story = c.photo_upload_to_story(cover, medias=medias, locations=locs)
            log.info("📣 스토리(게시물·위치 스티커) 공유")
            nap(5, 15)
            growth.add_to_highlight(c, story.pk, theme or {})
        except Exception as e:
            log.warning(f"스토리 실패: {str(e)[:160]}")


# ---------- 2) 공식 경로 발행분 사후 처리 ----------
def postprocess_recent():
    rows = db(f"""SELECT content_id, ig_media_id, address, handoff FROM posts
                  WHERE status = 'published' AND ig_media_id IS NOT NULL
                    AND (content_id LIKE 'roundup-%' OR content_id LIKE 'countdown-%')
                    AND created_at >= datetime('now', '-2 days') AND created_at >= '{START_DATE}'""")["rows"]
    for row in rows:
        cid = row["content_id"]
        if state_get(f"pp:{cid}") or str(row["ig_media_id"]).startswith("private:"):
            continue
        try:
            p = json.loads(row["handoff"] or "{}")
            perm = requests.get(f"{GRAPH}/{row['ig_media_id']}", params={"fields": "permalink", "access_token": graph_token()}, timeout=20).json().get("permalink", "")
            m = re.search(r"/(?:reel|p)/([^/]+)/", perm)
            if not m:
                continue
            c = cl()
            pk = c.media_pk_from_code(m[1])
            info = c.media_info(pk)
            loc_q = p.get("location")
            first = p.get("first_comment")
            if not loc_q:  # 핸드오프 재료가 없는 회차 — posts.address 첫 항목("1. 상호 — 주소")에서
                m2 = re.match(r"\s*1\.\s*(.+?)\s+—\s+(.+?)(?:\s+2\.|$)", str(row["address"] or ""))
                if m2:
                    loc_q = {"query": m2[1], "address": m2[2]}
                    first = first or f"🥇 1위 {m2[1]}"
            state_set(f"mid:{cid}", str(info.id))
            loc = find_location(c, loc_q)
            places = p.get("places") or [
                {"name": a, "address": b} for a, b in re.findall(r"\d\.\s*(.+?)\s+—\s+(.+?)(?=\s+\d\.\s|$)", str(row["address"] or ""))]
            tags = []
            try:
                tags = growth.usertags_for(c, places)
            except Exception as e:
                if is_block(e):
                    raise
            if (loc and not info.location) or tags:
                nap(5, 15)
                c.media_edit(info.id, info.caption_text, usertags=tags, location=loc if loc else info.location)
                log.info(f"📍 위치·식당 태그 {cid}: {loc.name if loc else '-'} / {len(tags)}곳")
            if first:
                nap(20, 50)
                cm = c.media_comment(info.id, first)
                nap(3, 8)
                c.comment_pin(info.id, cm.pk)
                log.info(f"📌 첫 댓글 고정 {cid}")
            state_set(f"pp:{cid}", "official")
        except Exception as e:
            log.warning(f"사후 처리 실패 {cid}: {str(e)[:160]}")
            if is_block(e):
                pause(6, f"사후 처리 중 차단 신호({type(e).__name__})")
                return
        nap(30, 90)


# ---------- 3) 자동 좋아요 ----------
def likes_daily():
    today = f"{now_kst():%Y-%m-%d}"
    if state_get(f"likes:{today}"):
        return
    slot = state_get(f"likes-at:{today}")
    if not slot:
        slot = f"{random.randint(11, 20):02d}:{random.randint(0, 59):02d}"
        state_set(f"likes-at:{today}", slot)
    if f"{now_kst():%H:%M}" < slot:
        return
    c = cl()
    goal = random.randint(*LIKES_PER_DAY)
    done = 0
    for tag in random.sample(LIKE_TAGS, 3):
        try:
            medias = c.hashtag_medias_recent(tag, amount=20)
        except Exception as e:
            log.warning(f"태그 조회 실패(#{tag}): {str(e)[:120]}")
            if is_block(e):
                state_set(f"likes:{today}", str(done))
                pause(12, "좋아요 중 차단 신호")
                return
            continue
        for m in random.sample(medias, min(len(medias), 10)):
            if done >= goal:
                break
            if str(m.user.pk) == str(c.user_id) or getattr(m, "has_liked", False):
                continue
            try:
                c.media_like(m.id)
                done += 1
            except Exception as e:
                log.warning(f"좋아요 실패: {str(e)[:120]}")
                if is_block(e):
                    state_set(f"likes:{today}", str(done))
                    pause(12, "좋아요 중 차단 신호")
                    return
            nap(25, 75)
        nap(60, 180)
    state_set(f"likes:{today}", str(done))
    log.info(f"❤️ 오늘 좋아요 {done}개")


# ---------- 4) 팔로잉 정리(사용자 승인 목록만) ----------
def unfollow_batch():
    approved = STATE / "unfollow-approved.txt"
    if not approved.exists():
        return
    last = state_get("unfollow:last")
    if last and time.time() - float(last) < 3 * 3600:
        return
    today = f"{now_kst():%Y-%m-%d}"
    used = int(state_get(f"unfollow:{today}") or 0)
    if used >= UNFOLLOW_PER_DAY:
        return
    done_f = STATE / "unfollowed.txt"
    done = set(done_f.read_text(encoding="utf-8").split()) if done_f.exists() else set()
    todo = [l.split(",")[0].strip() for l in approved.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]
    todo = [u for u in todo if u not in done][: min(UNFOLLOW_PER_RUN, UNFOLLOW_PER_DAY - used)]
    if not todo:
        return
    c = cl()
    n = 0
    for uid in todo:
        try:
            c.user_unfollow(uid)
            n += 1
            with done_f.open("a", encoding="utf-8") as f:
                f.write(uid + "\n")
        except Exception as e:
            log.warning(f"언팔 실패 {uid}: {str(e)[:120]}")
            if is_block(e):
                pause(24, "언팔 중 차단 신호")
                break
        nap(40, 120)
    state_set(f"unfollow:{today}", str(used + n))
    state_set("unfollow:last", str(time.time()))
    log.info(f"👋 언팔 {n}명 (오늘 누적 {used + n})")


def own_recent_media(days: int = 7) -> list:
    rows = db(f"""SELECT content_id, place_name FROM posts WHERE status = 'published'
                  AND (content_id LIKE 'roundup-%' OR content_id LIKE 'countdown-%')
                  AND created_at >= datetime('now', '-{days} days') ORDER BY id DESC""")["rows"]
    out = []
    for r in rows:
        mid = state_get(f"mid:{r['content_id']}")
        if mid:
            out.append((mid, r["place_name"]))
    return out


def media_pk_of(graph_id: str):
    try:
        perm = requests.get(f"{GRAPH}/{graph_id}", params={"fields": "permalink", "access_token": graph_token()}, timeout=20).json().get("permalink", "")
        m = re.search(r"/(?:reel|p)/([^/]+)/", perm)
        return cl().media_pk_from_code(m[1]) if m else None
    except Exception:
        return None


def growth_round():
    """하루 단위 활성화 작업 — 각자 하루 1회 상한·시각이 있어 10분마다 불려도 대부분 바로 끝난다."""
    c = cl()
    for name, fn in (
        ("댓글 응대", lambda: growth.reply_own_comments(c, own_recent_media())),
        ("프로필 고정", lambda: growth.pin_hits(c, media_pk_of)),
        ("타깃 좋아요", lambda: growth.targeted_likes(c)),
        ("남의 게시물 댓글", lambda: growth.auto_comments(c)),
    ):
        try:
            fn()
        except Exception as e:
            log.warning(f"{name} 실패: {type(e).__name__} {str(e)[:140]}")
            if is_block(e):
                pause(12, f"{name} 중 차단 신호({type(e).__name__})")
                return


def tick():
    if time.time() < _paused_until or not SESSION.exists():
        return
    handle_handoffs()
    last_pp = float(state_get("pp:last") or 0)
    if time.time() - last_pp > 600:
        state_set("pp:last", str(time.time()))
        postprocess_recent()
        likes_daily()
        unfollow_batch()
        growth_round()


def main():
    ensure_tables()
    once = "--once" in sys.argv
    log.info("에이전트 시작" + (" (한 바퀴)" if once else ""))
    while True:
        try:
            if not SESSION.exists():
                log.info("세션 없음 — private/login.py로 로그인할 때까지 대기")
            tick()
            state_set("agent:alive", f"{now_kst():%m-%d %H:%M:%S}")
        except Exception as e:
            log.error(f"루프 오류: {type(e).__name__} {str(e)[:200]}\n{traceback.format_exc()[-600:]}")
            if is_block(e):
                pause(6, type(e).__name__)
        if once:
            break
        time.sleep(45 if SESSION.exists() else 600)


if __name__ == "__main__":
    main()
