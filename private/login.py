"""최초 1회(또는 세션 만료 시) 사람이 직접 실행하는 로그인.
    python private/login.py
보안 확인(코드 입력)이 뜨면 여기서 받는다. 성공하면 private/state/session.json이 생기고,
이후 에이전트는 이 세션만 재사용한다(비밀번호로 반복 로그인하지 않음)."""
from common import SESSION, client

if __name__ == "__main__":
    cl = client(interactive=True)
    cl.dump_settings(SESSION)
    me = cl.account_info()
    print(f"로그인 성공: @{me.username} (세션 저장: {SESSION})")
