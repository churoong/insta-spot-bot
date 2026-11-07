"""활동별 팔로우 전환율과 활동량 자동 배분(2026-11-04 사용자 결정 — "추천대로 진행").

- mark(kind, uid): 우리가 그 사람에게 처음 한 활동을 private_log `src:<kind>:<uid>`에 남긴다(처음 시각 유지).
- new_followers(uids): 새 팔로워를 `newf:<uid>`에 남긴다(follows.follow_back이 3시간마다 부른다).
- 전환 = 활동한 뒤 14일 안에 그 사람이 우리를 팔로우함. 관리 페이지(/)가 같은 키로 표를 그린다.
- update_mults(): 월요일 1회, 최근 21일 기록으로 활동별 배수(0.5~1.5)를 계산해 `quota-mult`에 쓴다.
  표본이 150건 미만인 활동은 1.0(판단 보류). 배수는 전환율 ÷ 전체 평균 — 잘 되는 활동에 몫을 몰아준다.
- apply(): 기본 상한 × 배수를 각 모듈 상수에 다시 넣는다(growth_round 시작마다). 하루 총량은 크게 안 변한다.
"""
from __future__ import annotations

import json

from common import db, get_logger, now_kst, state_get, state_set

log = get_logger("agent")

# 활동 종류 → (모듈 이름, 상수 이름, 기본값). 기본값은 여기 한 곳이 기준이다.
QUOTAS = {
    "hlike": ("agent", "LIKES_PER_DAY", (18, 26)),
    "tlike": ("growth", "TARGET_LIKES_PER_DAY", (25, 35)),
    "acom": ("growth", "COMMENTS_PER_DAY", (16, 22)),
    "vlike": ("engage", "VISITED_LIKES", 40),
    "vcmt": ("engage", "VISITED_COMMENTS", 12),
    "fplike": ("engage", "FOOD_POST_LIKES", 30),
    "fpcmt": ("engage", "FOOD_POST_COMMENTS", 10),
    "fpfollow": ("engage", "FOOD_FOLLOWS", 25),
    "peerlike": ("engage", "PEER_LIKES_PER_DAY", 25),
    "likerfollow": ("follows", "LIKER_FOLLOW_PER_DAY", 20),
    "tfollow": ("growth", "TARGET_FOLLOWS_PER_DAY", (90, 110)),
}
MIN_SAMPLE = 150

# 관리 페이지와 같은 계산(src 시각 이후 14일 안에 newf가 생겼으면 전환)
STATS_SQL = """
SELECT kind, COUNT(*) AS acted, SUM(CASE WHEN n.key IS NOT NULL THEN 1 ELSE 0 END) AS conv FROM (
  SELECT substr(key, 5, instr(substr(key, 5), ':') - 1) AS kind,
         substr(key, 5 + instr(substr(key, 5), ':')) AS uid, updated_at AS t
  FROM private_log WHERE key LIKE 'src:%' AND updated_at > datetime('now', ?) AND updated_at < datetime('now', '-3 days')
) s LEFT JOIN private_log n ON n.key = 'newf:' || s.uid AND n.updated_at >= s.t AND n.updated_at <= datetime(s.t, '+14 days')
GROUP BY kind
"""


def mark(kind: str, uid) -> None:
    try:
        db("INSERT OR IGNORE INTO private_log (key, value, updated_at) VALUES (?, '1', datetime('now'))", [f"src:{kind}:{uid}"])
    except Exception:
        pass  # 기록 실패가 활동을 막으면 안 된다


def new_followers(uids) -> None:
    for uid in uids:
        try:
            db("INSERT OR IGNORE INTO private_log (key, value, updated_at) VALUES (?, '1', datetime('now'))", [f"newf:{uid}"])
        except Exception:
            pass


def update_mults() -> None:
    week = f"{now_kst():%G-%V}"
    if now_kst().weekday() != 0 or state_get("quota-mult-week") == week:
        return
    rows = db(STATS_SQL, ["-21 days"])["rows"]
    stats = {r["kind"]: (int(r["acted"] or 0), int(r["conv"] or 0)) for r in rows if r["kind"] in QUOTAS}
    judged = {k: v for k, v in stats.items() if v[0] >= MIN_SAMPLE}
    total_a = sum(a for a, _ in judged.values())
    total_c = sum(c for _, c in judged.values())
    mults = {}
    if total_a and total_c:
        avg = total_c / total_a
        for k, (a, c) in judged.items():
            mults[k] = round(min(1.5, max(0.5, (c / a) / avg)), 2)
    state_set("quota-mult", json.dumps({**mults, "_at": f"{now_kst():%Y-%m-%d}", "_stats": stats}, ensure_ascii=False))
    state_set("quota-mult-week", week)
    log.info(f"📊 활동 배분 갱신: {mults or '표본 부족 — 기본값 유지'} / 표본 {stats}")


def apply() -> None:
    import sys
    try:
        mults = json.loads(state_get("quota-mult") or "{}")
    except Exception:
        mults = {}
    for kind, (mod_name, const, base) in QUOTAS.items():
        mod = sys.modules.get(mod_name) or sys.modules.get("__main__" if mod_name == "agent" else mod_name)
        if mod is None or not hasattr(mod, const):
            continue
        m = float(mults.get(kind, 1.0))
        val = tuple(max(1, round(x * m)) for x in base) if isinstance(base, tuple) else max(1, round(base * m))
        setattr(mod, const, val)
