"""비공식 API(instagrapi) 에이전트 공용 모듈 — 2026-10-27 사용자 결정으로 도입.

⚠️ 인스타 이용약관 위반이라 계정 제한·정지 위험이 있다(사용자가 감수하기로 함).
이 폴더의 스크립트는 사용자 PC에서만 돈다. GitHub 러너(데이터센터 IP)에서 비공식 로그인을
하면 거의 확실히 보안 확인에 걸리기 때문이다.

비밀: 로그인 정보는 ../.env의 IG_USERNAME / IG_PASSWORD(사용자가 직접 입력),
세션은 private/state/session.json — 둘 다 공개 저장소에 올라가면 안 된다(.gitignore).
"""
from __future__ import annotations

import json
import logging
import os
import random
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
STATE = ROOT / "state"
LOGS = ROOT / "logs"
STATE.mkdir(exist_ok=True)
LOGS.mkdir(exist_ok=True)
SESSION = STATE / "session.json"
KST = timezone(timedelta(hours=9))
GRAPH = "https://graph.instagram.com/v23.0"


def load_env() -> dict:
    env = {}
    f = REPO / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.split(" #")[0].strip().strip('"').strip("'")
            env[k.strip()] = v
    env.update({k: v for k, v in os.environ.items() if k.startswith(("IG_", "TURSO_", "PRIVATE_"))})
    return env


ENV = load_env()


def get_logger(name: str) -> logging.Logger:
    log = logging.getLogger(name)
    if not log.handlers:
        log.setLevel(logging.INFO)
        fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
        fh = logging.FileHandler(LOGS / f"{name}.log", encoding="utf-8")
        fh.setFormatter(fmt)
        sh = logging.StreamHandler()
        sh.setFormatter(fmt)
        log.addHandler(fh)
        log.addHandler(sh)
    return log


def now_kst() -> datetime:
    return datetime.now(KST)


def nap(lo: float, hi: float) -> None:
    """사람처럼 쉬기 — 비공식 API 호출 사이 간격은 늘 무작위로."""
    time.sleep(random.uniform(lo, hi))


# ---------- Turso (libSQL HTTP) ----------
def _turso_url() -> str:
    u = ENV.get("TURSO_DATABASE_URL", "")
    return u.replace("libsql://", "https://").rstrip("/") + "/v2/pipeline"


def _arg(v):
    if v is None:
        return {"type": "null"}
    if isinstance(v, bool):
        return {"type": "integer", "value": str(int(v))}
    if isinstance(v, int):
        return {"type": "integer", "value": str(v)}
    if isinstance(v, float):
        return {"type": "float", "value": v}
    return {"type": "text", "value": str(v)}


def db(sql: str, args: list | None = None) -> dict:
    """SQL 한 문장 실행 → {'rows': [dict], 'affected': n}"""
    body = {"requests": [{"type": "execute", "stmt": {"sql": sql, "args": [_arg(a) for a in (args or [])]}}, {"type": "close"}]}
    r = requests.post(_turso_url(), json=body, headers={"Authorization": f"Bearer {ENV.get('TURSO_AUTH_TOKEN', '')}"}, timeout=30)
    r.raise_for_status()
    res = r.json()["results"][0]
    if res.get("type") == "error":
        raise RuntimeError(f"DB 오류: {res.get('error')}")
    result = res["response"]["result"]
    cols = [c["name"] for c in result["cols"]]
    rows = [{c: (cell.get("value") if isinstance(cell, dict) else cell) for c, cell in zip(cols, row)} for row in result["rows"]]
    return {"rows": rows, "affected": result.get("affected_row_count", 0)}


def ensure_tables() -> None:
    db("""CREATE TABLE IF NOT EXISTS private_log (
            key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))""")
    # posts.handoff는 원래 lib/db.ts 마이그레이션이 만들지만, 그건 다음 GitHub 발행 때에야 돈다.
    # 에이전트가 먼저 켜지면 "no such column"으로 매 바퀴 실패했다(2026-10-27 실측) — 여기서도 만든다.
    try:
        db("ALTER TABLE posts ADD COLUMN handoff TEXT")
    except Exception:
        pass  # 이미 있음


def state_get(key: str) -> str | None:
    r = db("SELECT value FROM private_log WHERE key = ?", [key])["rows"]
    return r[0]["value"] if r else None


def state_set(key: str, value: str) -> None:
    db("INSERT OR REPLACE INTO private_log (key, value, updated_at) VALUES (?, ?, datetime('now'))", [key, value])


def graph_token() -> str:
    try:
        r = db("SELECT value FROM config WHERE key = 'ig_token'")["rows"]
        if r and r[0]["value"]:
            return r[0]["value"]
    except Exception:
        pass
    return ENV.get("IG_ACCESS_TOKEN", "")


def graph_id_for_code(code: str, tries: int = 6) -> str | None:
    """비공식 업로드 결과(shortcode)를 공식 Graph 미디어 ID로 바꾼다 — 조회수 수집(/api/cron/metrics)이
    Graph ID를 쓰기 때문. 막 올린 게시물은 목록에 늦게 뜨므로 몇 번 다시 본다."""
    tok = graph_token()
    for _ in range(tries):
        try:
            j = requests.get(f"{GRAPH}/me/media", params={"fields": "id,permalink", "limit": 15, "access_token": tok}, timeout=20).json()
            for m in j.get("data", []):
                if f"/{code}/" in str(m.get("permalink", "")):
                    return str(m["id"])
        except Exception:
            pass
        time.sleep(20)
    return None


# ---------- instagrapi 로그인 ----------
def client(interactive: bool = False):
    """세션 파일을 우선 재사용한다. 매번 비밀번호로 새로 로그인하면 그게 가장 큰 탐지 신호다."""
    from instagrapi import Client
    from instagrapi.exceptions import LoginRequired

    cl = Client()
    cl.delay_range = [2, 6]
    cl.set_locale("ko_KR")
    cl.set_country("KR")
    cl.set_country_code(82)
    cl.set_timezone_offset(9 * 3600)
    user, pw = ENV.get("IG_USERNAME", ""), ENV.get("IG_PASSWORD", "")
    if SESSION.exists():
        cl.load_settings(SESSION)
        try:
            cl.get_timeline_feed()
            return cl
        except LoginRequired:
            old = cl.get_settings()
            cl = Client()
            cl.delay_range = [2, 6]
            cl.set_uuids(old.get("uuids", {}))
    if not (user and pw):
        raise RuntimeError(".env에 IG_USERNAME / IG_PASSWORD가 없습니다 — private/login.py를 먼저 실행하세요")
    if not interactive:
        # 무인 실행에서 새 로그인은 하지 않는다 — 보안 확인 코드를 받을 사람이 없다.
        raise RuntimeError("세션 만료 — private/login.py로 다시 로그인하세요")
    code = input("2단계 인증 코드(없으면 Enter): ").strip()
    cl.login(user, pw, verification_code=code or "")
    cl.dump_settings(SESSION)
    return cl


def llm(prompt: str, max_chars: int = 120) -> str | None:
    """짧은 한국어 문장 생성(Gemini 무료 등급, lib/llm.ts와 같은 기본 모델). 실패하면 None — 호출부는
    그때 아무것도 안 하는 쪽으로 처리한다(뻔한 템플릿 댓글은 스팸으로 보이므로 쓰지 않는다)."""
    key = ENV.get("GEMINI_API_KEY", "")
    if not key:
        return None
    m = ENV.get("GEMINI_MODEL") or "gemini-flash-lite-latest"
    if m == "gemini-flash-latest":
        m = "gemini-flash-lite-latest"
    try:
        r = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={key}",
            json={"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0.9, "maxOutputTokens": 120}},
            timeout=30,
        )
        t = r.json()["candidates"][0]["content"]["parts"][0]["text"].strip().strip('"').strip()
        t = t.splitlines()[0].strip()
        return t[:max_chars] if t else None
    except Exception:
        return None


# ---------- 노트북이 켜져 있는 시간(2026-10-27 사용자) ----------
# 평일 09:00~11:10, 13:10~17:40만 인터넷이 된다(11:20~13:00·저녁·주말은 없음).
# 하루 1회 작업의 시각은 이 안에서만 고른다 — 밖에서 고르면 그날 작업이 통째로 사라진다.
# 다른 기계(예: 집 와이파이에 둔 안드로이드 폰, 24시간)로 옮기면 .env의 AGENT_ONLINE으로 바꾼다.
#   AGENT_ONLINE=08:30-22:30          (여러 구간은 쉼표: 09:00-11:10,13:10-17:40)
def _windows():
    spec = ENV.get("AGENT_ONLINE", "")
    out = []
    for part in [s for s in spec.split(",") if "-" in s]:
        a, b = part.strip().split("-")
        (h1, m1), (h2, m2) = map(int, a.split(":")), map(int, b.split(":"))
        out.append((h1, m1, h2, m2))
    return out or [(9, 0, 11, 10), (13, 10, 17, 40)]


ONLINE_WINDOWS = _windows()


def online_slot() -> str:
    """온라인 시간 안에서 하루 1회 활동 시각을 고른다. 팔로워 접속 시간(engage.refresh_online_hours가
    공식 API online_followers로 매주 갱신)이 있으면 접속이 많은 시각일수록 잘 뽑히게 가중한다."""
    import json as _j
    import random as _r
    try:
        w = _j.loads(state_get("online_hours") or "{}")
    except Exception:
        w = {}
    minutes = []
    for h1, m1, h2, m2 in ONLINE_WINDOWS:
        minutes += list(range(h1 * 60 + m1, h2 * 60 + m2 - 20, 5))
    if not minutes:
        return "10:00"
    weights = [max(1, int(w.get(str(t // 60), 1))) for t in minutes]
    t = _r.choices(minutes, weights=weights, k=1)[0]
    return f"{t // 60:02d}:{t % 60:02d}"


def next_weekday_at(hour: int, minute: int) -> float:
    """다음 평일 hh:mm(KST)의 타임스탬프. 오늘이 평일이고 아직 그 시각 전이면 오늘."""
    t = now_kst().replace(hour=hour, minute=minute, second=0, microsecond=0)
    while t <= now_kst() or t.weekday() >= 5:
        t += timedelta(days=1)
        t = t.replace(hour=hour, minute=minute)
    return t.timestamp()
