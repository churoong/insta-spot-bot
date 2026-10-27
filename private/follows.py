"""팔로우 관리 — 2026-10-27 사용자 결정("누가 날 팔로우하면 자동 맞팔, 주기적으로 팔로잉 정리, 기준은 알아서").

자동 맞팔(3시간마다): 팔로워 목록을 지난번과 비교해 새 팔로워를 맞팔한다. 단 외국 계정 신호가 강한
  계정(외국 문자 이름·소개, 해외 전화번호)과 이미 정리한 계정은 맞팔하지 않는다 — 맞팔했다가 정리 대상이
  되면 팔로우/언팔 반복이 되고, 그게 가장 흔한 스팸 탐지 패턴이다. 하루 40명까지.

팔로잉 정리(주 1회): 우리를 팔로우하지 않는 계정을 언팔 대기열(state/unfollow-auto.txt)에 넣는다.
  예외 — 우리가 일부러 팔로우한 큰 맛집 계정, 태그용으로 찾은 식당 계정, 맞팔한 지 14일이 안 된 계정.
  실제 언팔은 agent.unfollow_batch가 사용자 승인 목록과 합쳐 하루 40명까지 천천히 한다.
"""
from __future__ import annotations

import json
import re
import time

from common import STATE, db, get_logger, nap, now_kst, state_get, state_set

log = get_logger("agent")
FOLLOWERS_F = STATE / "followers.json"
AUTO_Q = STATE / "unfollow-auto.txt"
FOLLOWBACK_PER_DAY = 40
HANGUL = re.compile(r"[가-힣]")
FOREIGN = re.compile(r"[ऀ-ॿ฀-๿؀-ۿЀ-ӿ぀-ヿ一-鿿ঀ-৿ក-៿]")


def _done_set() -> set:
    s = set()
    for f in (STATE / "unfollowed.txt",):
        if f.exists():
            s |= set(f.read_text(encoding="utf-8").split())
    return s


def _approved_ids() -> set:
    f = STATE / "unfollow-approved.txt"
    if not f.exists():
        return set()
    return {l.split(",")[0].strip() for l in f.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")}


def follow_back(c):
    last = float(state_get("fb:last") or 0)
    if time.time() - last < 3 * 3600:
        return
    state_set("fb:last", str(time.time()))
    followers = {str(k): v for k, v in c.user_followers(str(c.user_id), amount=0).items()}
    known = set(json.loads(FOLLOWERS_F.read_text(encoding="utf-8"))) if FOLLOWERS_F.exists() else None
    FOLLOWERS_F.write_text(json.dumps(sorted(followers)), encoding="utf-8")
    if known is None:
        log.info(f"팔로워 기준선 저장: {len(followers)}명 (다음 확인부터 새 팔로워 맞팔)")
        return
    new = [uid for uid in followers if uid not in known]
    if not new:
        return
    today = f"{now_kst():%Y-%m-%d}"
    used = int(state_get(f"fb:{today}") or 0)
    skip = _done_set() | _approved_ids()
    following = set(state_get("fb:following-cache") and json.loads(state_get("fb:following-cache")) or [])
    n = 0
    for uid in new:
        if used + n >= FOLLOWBACK_PER_DAY:
            break
        if uid in skip or uid in following:
            continue
        u = followers[uid]
        name = f"{u.full_name or ''} {u.username or ''}"
        try:
            if not HANGUL.search(u.full_name or ""):
                nap(2, 6)
                info = c.user_info(uid)
                bio = info.biography or ""
                cc = str(info.public_phone_country_code or "")
                if (cc and cc != "82") or (FOREIGN.search(name + bio) and not HANGUL.search(bio)):
                    log.info(f"맞팔 안 함(외국 신호): @{u.username}")
                    continue
            c.user_follow(uid)
            state_set(f"fbat:{uid}", str(time.time()))
            n += 1
            log.info(f"🤝 맞팔: @{u.username}")
        except Exception as e:
            log.warning(f"맞팔 실패 @{u.username}: {str(e)[:100]}")
            if any(k in type(e).__name__ for k in ("Challenge", "PleaseWait", "Feedback", "LoginRequired")):
                raise
        nap(30, 90)
    state_set(f"fb:{today}", str(used + n))


def weekly_cleanup(c):
    week = f"{now_kst():%G-%V}"
    if state_get(f"cleanup:{week}"):
        return
    state_set(f"cleanup:{week}", "1")
    following = {str(k): v for k, v in c.user_following(str(c.user_id), amount=0).items()}
    state_set("fb:following-cache", json.dumps(sorted(following)))
    nap(10, 30)
    followers = set(str(k) for k in c.user_followers(str(c.user_id), amount=0))
    FOLLOWERS_F.write_text(json.dumps(sorted(followers)), encoding="utf-8")
    keep = set()
    for r in db("SELECT key, value FROM private_log WHERE key LIKE 'followbig:%' OR key LIKE 'igacct:%'")["rows"]:
        if r["key"].startswith("followbig:"):
            keep.add(r["key"].split(":", 1)[1])
        else:
            try:
                v = json.loads(r["value"] or "{}")
                if v.get("pk"):
                    keep.add(str(v["pk"]))
            except Exception:
                pass
    fresh = set()
    for r in db("SELECT key, value FROM private_log WHERE key LIKE 'fbat:%'")["rows"]:
        if time.time() - float(r["value"]) < 14 * 86400:
            fresh.add(r["key"].split(":", 1)[1])
    queued = set(AUTO_Q.read_text(encoding="utf-8").split()) if AUTO_Q.exists() else set()
    skip = _done_set() | _approved_ids() | queued
    add = [uid for uid in following if uid not in followers and uid not in keep and uid not in fresh and uid not in skip]
    with AUTO_Q.open("a", encoding="utf-8") as f:
        for uid in add:
            f.write(uid + "\n")
    log.info(f"🧹 주간 팔로잉 정리: 팔로잉 {len(following)} · 팔로워 {len(followers)} · 맞팔 안 하는 계정 {len(add)}명 언팔 대기열 추가(예외 {len(keep & set(following))}명)")
