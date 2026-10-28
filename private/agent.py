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
import os
import random
import re
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

import requests

from common import (GRAPH, REPO, ROOT, SESSION, STATE, client, db, ensure_tables, get_logger,
                    graph_id_for_code, graph_token, nap, next_weekday_at, now_kst, online_slot,
                    state_get, state_set)
import engage
import follows
import growth

log = get_logger("agent")
START_DATE = "2026-10-27"  # 이 날짜 이후 발행분만 사후 처리(과거 게시물은 건드리지 않는다)
LIKE_TAGS = ["국밥맛집", "순대국", "칼국수맛집", "냉면맛집", "해장국", "짬뽕맛집", "맛집추천", "전국맛집", "노포맛집", "가성비맛집"]
LIKES_PER_DAY = (18, 26)
UNFOLLOW_PER_DAY = 40
UNFOLLOW_PER_RUN = 14

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
def pick_track(c, skip: int = 0):
    try:
        t = growth.trending_track(c, skip)
        if t:
            log.info(f"🎵 음원(맛집 릴스 인기): {t.title} — {t.display_artist}")
            return t
    except Exception as e:
        if is_block(e):
            raise
        log.warning(f"인기 음원 실패(목록으로): {str(e)[:120]}")
    qs = [l.strip() for l in (ROOT / "music.txt").read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]
    random.shuffle(qs)
    for q in qs[skip:skip + 3] or qs[:3]:
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
    """시스템 ffmpeg 우선(안드로이드 Termux는 pkg install ffmpeg) — imageio_ffmpeg 동봉 바이너리는 윈도우·x86 전용."""
    import shutil
    sysff = shutil.which("ffmpeg")
    if sysff:
        return sysff
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def video_seconds(p: Path) -> float:
    out = subprocess.run([ffmpeg(), "-i", str(p)], capture_output=True, text=True, encoding="utf-8", errors="ignore").stderr
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", out)
    return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3]) if m else 8.0


def with_music(c, video: Path, work: Path, skip: int = 0):
    """영상 소리를 인스타 음원으로 바꾼 파일과 음원 메타데이터를 돌려준다. 음원이 없으면 (None, None).
    skip: 오늘의 인기 음원 순위에서 건너뛸 개수 — 트라이얼 변형이 본편과 다른 곡을 쓰게."""
    t = pick_track(c, skip)
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
        claimed_at = time.time()
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
                # 가져간 지 12분이 넘었으면 올리지 않는다 — GitHub는 25분에 공식 API로 직접 발행하므로,
                # 인터넷이 끊겼다 돌아와 늦게 올리면 같은 편이 두 번 나간다.
                if time.time() - claimed_at > 12 * 60:
                    raise RuntimeError("가져간 지 12분 초과 — 이중 발행 방지로 업로드 중단")
                # 대체 텍스트(검색 노출) — 인스타가 거부하면 대체 텍스트만 빼고 한 번 더
                try:
                    media = c.clip_upload(path, caption, thumbnail=cover, usertags=tags, location=loc,
                                          extra_data={**(extra or {}), "custom_accessibility_caption": engage.alt_text(p)})
                except Exception as e:
                    if is_block(e):
                        raise
                    log.warning(f"대체 텍스트 포함 업로드 실패 — 빼고 재시도: {str(e)[:120]}")
                    media = c.clip_upload(path, caption, thumbnail=cover, usertags=tags, location=loc, extra_data=extra)
                state_set(f"mid:{cid}", str(media.id))
                published = True
                log.info(f"✅ 릴스 발행: https://www.instagram.com/reel/{media.code}/")
                gid = graph_id_for_code(media.code) or f"private:{media.pk}"
                db("UPDATE posts SET status = 'published', ig_media_id = ? WHERE content_id = ?", [gid, cid])
                state_set(f"pp:{cid}", "handoff")
                title = (p.get("caption") or "").split("\n")[0].split("| ")[-1].strip()
                engage.trigger_burst(cid)
                try:
                    engage.daily_note(c, title)
                    engage.congrats_dm(c, p.get("places", []), title)
                except Exception as e:
                    log.warning(f"노트·축하 DM 실패: {str(e)[:100]}")
                    if is_block(e):
                        raise
                # 첫 댓글 문구(1위 소개 + 원픽 질문 + 지역 해시태그)는 make-roundup buildFirstComment가 만든다
                after_publish(c, media.id, media.pk, p.get("first_comment"), cover, loc, p.get("theme"))
                engage.remember_hashtag_check(media.pk, engage.comment_hashtags(p))
                enqueue_trials(cid, p)
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
            cm = c.media_comment(media_id, first_comment)  # 해시태그만(2026-10-27)
            nap(3, 8)
            c.comment_pin(media_id, cm.pk)  # 사용자 결정: 해시태그 댓글을 고정
            log.info(f"#️⃣📌 첫 댓글(해시태그) 고정: {first_comment}")
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
    rows = db(f"""SELECT content_id, ig_media_id, address, handoff, created_at FROM posts
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
            # 첫 댓글(해시태그만)은 공식 경로면 GitHub가 발행 직후 이미 달았다. 우리 해시태그 댓글이 없을 때만 단다.
            nap(5, 15)
            mine = [cm for cm in c.media_comments(info.id, amount=30) if str(cm.user.pk) == str(c.user_id) and (cm.text or "").startswith("#")]
            tags = engage.comment_hashtags(p)
            cmh = mine[-1] if mine else None
            if not cmh and tags:
                nap(15, 40)
                cmh = c.media_comment(info.id, " ".join("#" + t for t in tags))
            if cmh:
                nap(3, 8)
                c.comment_pin(info.id, cmh.pk)  # 사용자 결정: 해시태그 댓글을 고정(공식 API로는 고정 불가라 여기서)
                log.info(f"#️⃣📌 해시태그 댓글 고정 {cid}{' (공식 댓글)' if mine else ''}")
            engage.remember_hashtag_check(pk, tags)
            state_set(f"pp:{cid}", "official")
            enqueue_trials(cid, p)
            if row.get("created_at") and (time.time() - _utc_ts(row["created_at"])) < 3600:
                engage.trigger_burst(cid)  # 방금 공식 경로로 올라간 편 — 집중 활동
                title = str(p.get("caption") or "").split("\n")[0].split("| ")[-1].strip()
                if title and p.get("places"):
                    engage.congrats_dm(c, p.get("places", []), title)
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
        slot = online_slot()
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
    auto_q = STATE / "unfollow-auto.txt"  # follows.weekly_cleanup이 채우는 '맞팔 안 하는 계정' 대기열
    if not approved.exists() and not auto_q.exists():
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
    lines = []
    for f in (approved, auto_q):
        if f.exists():
            lines += f.read_text(encoding="utf-8").splitlines()
    todo = [l.split(",")[0].strip() for l in lines if l.strip() and not l.startswith("#")]
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


# ---------- 트라이얼 릴스 대량 시험(2026-10-27 사용자 결정) ----------
TRIALS_PER_POST = 2


def enqueue_trials(cid: str, p: dict):
    """저녁 모음집(음원 붙는 회차)마다 같은 영상을 다른 음원·다른 첫 줄로 트라이얼 릴스 2개 더 올린다.
    트라이얼은 비팔로워에게만 보여 팔로워 피드를 도배하지 않는다. 본편 직후가 아니라 2~4시간 간격."""
    if not p.get("music_ok") or not p.get("reel_url") or state_get(f"trialq-done:{cid}"):
        return
    state_set(f"trialq-done:{cid}", "1")
    q = json.loads(state_get("trialq") or "[]")
    # 노트북은 평일 09:00~11:10에만 확실히 켜져 있다 — 다음 평일 오전 10:15 전후에 1개, 25분 뒤 1개
    q.append({"cid": cid, "n": 1, "at": next_weekday_at(10, 15) + random.randint(0, 600), "p": p})
    state_set("trialq", json.dumps(q, ensure_ascii=False))
    log.info(f"🧪 트라이얼 {TRIALS_PER_POST}개 예약: {cid}")


def alt_first_line(p: dict) -> str | None:
    from common import llm
    title = (p.get("caption") or "").split("\n")[0]
    t = llm("인스타 맛집 릴스 캡션 첫 줄을 같은 뜻의 다른 제목으로 한 줄 써라. 규칙: 'N대 맛집' 형식 유지, "
            "'TOP N'·'N선'·'줄서는'·'웨이팅'·'현지인' 금지, 지역명은 뒤쪽에, 과장·거짓 금지, 이모지 1개로 시작. 식당·음식은 언제나 긍정적으로만 말할 것(단점·아쉬움·비교 우열·호불호 금지). 제목만 출력.\n원래 제목: " + title, 80)
    if not t or "대 맛집" not in t or re.search(r"TOP|\d선|줄서|웨이팅|현지인", t):
        return None
    # 원래 제목에 없던 지역을 지어내면 버린다("전국 국밥 6대 맛집 서울" 실측)
    regions = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "제주", "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남"]
    if any(r in t and r not in title for r in regions):
        return None
    food = (p.get("theme") or {}).get("food") or ""
    return t if not food or food in t else None


def process_trials():
    q = json.loads(state_get("trialq") or "[]")
    if not q or q[0]["at"] > time.time():
        return
    job = q.pop(0)
    p, cid, n = job["p"], job["cid"], job["n"]
    c = cl()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            video = download(p["reel_url"], work / "reel.mp4")
            cover = download(p["cover_url"], work / "cover.jpg") if p.get("cover_url") else None
            mv, extra = with_music(c, video, work, skip=n)  # 본편은 0번째 곡, 트라이얼 n은 n번째 곡
            caption = p["caption"]
            alt = alt_first_line(p)
            if alt:
                caption = alt + "\n" + "\n".join(caption.split("\n")[1:])
            if not mv and p.get("bgm_line"):
                caption += "\n" + p["bgm_line"]
            try:
                media = c.clip_upload(mv or video, caption, thumbnail=cover, extra_data={**(extra or {}), "custom_accessibility_caption": engage.alt_text(p)},
                                      trial=True, trial_graduation_strategy="ss_performance")
            except Exception as e:
                if is_block(e):
                    raise
                log.warning(f"자동 승격 트라이얼 거부 — 수동 승격으로 재시도: {str(e)[:120]}")
                media = c.clip_upload(mv or video, caption, thumbnail=cover, extra_data={**(extra or {}), "custom_accessibility_caption": engage.alt_text(p)}, trial=True)
            state_set(f"trial:{cid}:{n}", json.dumps({"pk": str(media.pk), "code": media.code, "at": time.time()}))
            log.info(f"🧪 트라이얼 {n} 발행: {cid} https://www.instagram.com/reel/{media.code}/")
    except Exception as e:
        log.error(f"트라이얼 실패 {cid}#{n}: {type(e).__name__} {str(e)[:160]}")
        if is_block(e):
            pause(12, "트라이얼 중 차단 신호")
    if n < TRIALS_PER_POST:
        q.insert(0, {**job, "n": n + 1, "at": time.time() + random.randint(20, 30) * 60})
    state_set("trialq", json.dumps(q, ensure_ascii=False))


def report_trials():
    """발행 72시간 지난 트라이얼의 재생 수를 본편과 나란히 기록(하루 1회). 승격 판단 자료."""
    if state_get(f"trialrep:{now_kst():%Y-%m-%d}"):
        return
    state_set(f"trialrep:{now_kst():%Y-%m-%d}", "1")
    rows = db("SELECT key, value FROM private_log WHERE key LIKE 'trial:%' AND key NOT LIKE 'trialq%'")["rows"]
    c = cl()
    for r in rows:
        v = json.loads(r["value"])
        if v.get("views") is not None or time.time() - v["at"] < 72 * 3600:
            continue
        try:
            info = c.media_info(v["pk"])
            v["views"] = int(getattr(info, "play_count", 0) or getattr(info, "view_count", 0) or 0)
            state_set(r["key"], json.dumps(v))
            log.info(f"🧪 트라이얼 결과 {r['key']}: 재생 {v['views']}")
        except Exception as e:
            log.warning(f"트라이얼 결과 조회 실패: {str(e)[:100]}")
        nap(5, 15)


def _utc_ts(s: str) -> float:
    from datetime import datetime, timezone
    return datetime.strptime(str(s)[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()


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
        ("계정 이름 변경", lambda: growth.rename_profile(c)),
        ("아이디 변경", lambda: growth.rename_handle(c)),
        ("프로필 사진", lambda: growth.set_profile_picture(c)),
        ("프로필 링크", lambda: growth.set_profile_link(c)),
        ("댓글 응대", lambda: growth.reply_own_comments(c, own_recent_media())),
        ("프로필 고정", lambda: growth.pin_hits(c, media_pk_of)),
        ("타깃 좋아요", lambda: growth.targeted_likes(c)),
        ("남의 게시물 댓글", lambda: growth.auto_comments(c)),
        ("큰 계정 첫 댓글", lambda: growth.fast_first_comments(c)),
        ("자동 맞팔", lambda: follows.follow_back(c)),
        ("주간 팔로잉 정리", lambda: follows.weekly_cleanup(c)),
        ("검색 수요 수집", lambda: growth.demand_snapshot(c)),
        ("노트", lambda: engage.daily_note(c)),
        ("DM 답장", lambda: engage.answer_dms(c)),
        ("소개 식당 장소 피드", lambda: engage.visited_engage(c, find_location)),
        ("스토리 보기", lambda: engage.story_views(c)),
        ("비슷한 계정 팔로워 좋아요", lambda: engage.peer_follower_likes(c)),
        ("단골 관리", lambda: engage.regulars_engage(c, own_recent_media(14))),
        ("베스트 댓글 고정", lambda: engage.best_comment_pin(c, own_recent_media(4))),
        ("위치 질문 답글", lambda: engage.answer_where(c)),
        ("추천 요청 응답", lambda: engage.recommend_requests(c)),
        ("팔로워 접속 시간", lambda: engage.refresh_online_hours()),
        ("DM 후속 대화", lambda: engage.dm_followups(c)),
        ("좋아요 누른 사람 팔로우", lambda: follows.follow_likers(c, own_recent_media(4))),
        ("질문 스티커 스토리", lambda: engage.question_story(c)),
        ("질문 답변 DM", lambda: engage.question_answers(c)),
        ("맞교환 제안", lambda: engage.peer_proposals(c)),
        ("추천 계정 스토리", lambda: engage.peer_shoutout_story(c)),
        ("지도 하이라이트", lambda: engage.weekly_map_highlight(c)),
        ("댓글 해시태그 노출 확인", lambda: engage.check_hashtag_visibility(c)),
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
    process_trials()
    # 발행 후 2시간은 우리 게시물 댓글을 3분마다 확인해 거의 바로 답한다(평소엔 10분 주기 growth_round)
    if time.time() < float(state_get("fastreply:until") or 0) and time.time() - float(state_get("fastreply:last") or 0) > 180:
        state_set("fastreply:last", str(time.time()))
        try:
            growth.reply_own_comments(cl(), own_recent_media(1))
        except Exception as e:
            log.warning(f"빠른 답글 실패: {str(e)[:100]}")
            if is_block(e):
                pause(6, "빠른 답글 중 차단 신호")
    last_pp = float(state_get("pp:last") or 0)
    if time.time() - last_pp > 600:
        state_set("pp:last", str(time.time()))
        postprocess_recent()
        likes_daily()
        unfollow_batch()
        growth_round()
        report_trials()


def _git(*args) -> str:
    flags = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW — pythonw에서 콘솔 창 깜빡임 방지
    r = subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True, timeout=120, creationflags=flags)
    if r.returncode:
        raise RuntimeError(f"git {args[0]}: {r.stderr.strip()[:160]}")
    return r.stdout.strip()


def self_update():
    """클라우드 세션에서 머지한 변경을 노트북이 켜지면 받아 온다(2026-10-27 사용자 결정 — 노트북 없이 작업).
    main 브랜치이고 추적 파일 변경이 없을 때만 fast-forward로 당기고, private/가 바뀌었으면 스스로 재시작한다."""
    try:
        if _git("rev-parse", "--abbrev-ref", "HEAD") != "main":
            return  # 작업 브랜치에서 돌리는 중 — 건드리지 않는다
        if _git("status", "--porcelain", "--untracked-files=no"):
            return  # 로컬 수정이 있으면 당기지 않는다
        _git("fetch", "-q", "origin", "main")
        old, new = _git("rev-parse", "HEAD"), _git("rev-parse", "origin/main")
        if old == new or subprocess.run(["git", "-C", str(REPO), "merge-base", "--is-ancestor", old, new],
                                        creationflags=0x08000000 if sys.platform == "win32" else 0).returncode:
            return
        _git("merge", "--ff-only", "-q", "origin/main")
        changed = _git("diff", "--name-only", old, new).splitlines()
        log.info(f"⬇️ main 갱신 {old[:7]}→{new[:7]} ({len(changed)}개 파일)")
        if any(f.startswith("private/") for f in changed):
            log.info("🔁 에이전트 코드가 바뀌어 재시작")
            os.execv(sys.executable, [sys.executable, *sys.argv])
    except Exception as e:
        log.warning(f"자동 업데이트 실패(무시): {str(e)[:160]}")


_loop_at = time.time()


def _watchdog():
    """45분 동안 아무 진전이 없으면(인터넷이 끊긴 채 응답 없는 요청에 걸린 경우 등) 스스로 재시작한다.
    진전 = 바퀴 시작 또는 nap()(활동 사이 쉬기 — 가장 긴 게 8분). 바퀴 전체 길이로 재면 안 된다:
    growth_round 한 바퀴는 쉬는 시간 때문에 원래 한두 시간 걸려서 멀쩡한 작업을 죽이게 된다."""
    import threading

    import common

    def run():
        while True:
            time.sleep(60)
            if time.time() - max(_loop_at, common.PROGRESS[0]) > 45 * 60:
                log.error("🐕 45분 동안 진전 없음 — 재시작")
                os.execv(sys.executable, [sys.executable, *sys.argv])

    threading.Thread(target=run, daemon=True).start()


def main():
    global _loop_at
    ensure_tables()
    once = "--once" in sys.argv
    log.info("에이전트 시작" + (" (한 바퀴)" if once else ""))
    if not once:
        _watchdog()
    last_update = 0.0
    while True:
        _loop_at = time.time()
        if not once and time.time() - last_update > 600:
            last_update = time.time()
            self_update()
        try:
            # 생존 신호는 바퀴 시작에 남긴다 — 예전엔 tick() 뒤라 하위 작업 하나가 예외를 내면
            # 에이전트는 멀쩡해도 신호가 끊겨 GitHub가 '꺼짐'으로 보고 핸드오프를 건너뛰었다.
            state_set("agent:alive", f"{now_kst():%m-%d %H:%M:%S}")
            if not SESSION.exists():
                log.info("세션 없음 — private/login.py로 로그인할 때까지 대기")
            tick()
        except Exception as e:
            log.error(f"루프 오류: {type(e).__name__} {str(e)[:200]}\n{traceback.format_exc()[-600:]}")
            if is_block(e):
                pause(6, type(e).__name__)
        if once:
            break
        time.sleep(45 if SESSION.exists() else 600)


if __name__ == "__main__":
    main()
