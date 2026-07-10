# 배포 가이드 — 전 구간 무료 · 카드 불필요 · 24시간

구성: **Vercel**(웹 호스팅) + **Turso**(SQLite) + **cron-job.org**(매시 트리거) + **Meta Graph API**(게시·DM) + **Gemini 무료 등급 또는 내장 템플릿**(캡션)

로컬은 `local.db` 파일, 배포는 Turso를 **같은 코드**로 씁니다. 순서대로 따라오세요.

---

## 현재 상태 체크리스트

| 항목 | 상태 |
|---|---|
| TourAPI 키 | ✅ 발급·검증 완료 (`.env`에 저장됨) |
| CRON_SECRET / WEBHOOK_VERIFY_TOKEN | ✅ 자동 생성·저장됨 |
| 로컬 미리보기(드라이런) | ✅ 작동 확인 |
| 인스타 프로페셔널 + FB 페이지 | ⬜ 직접 진행 |
| Meta 개발자 앱 + 토큰 4종 | ⬜ 개발자 계정 차단 풀린 뒤 |
| Turso DB | ⬜ 아래 1번 |
| Gemini 키 | ⬜ 선택 (없어도 템플릿으로 작동) |
| Vercel 배포 | ⬜ 아래 3번 |

> **미리보기 모드**: Meta 토큰(`IG_ACCESS_TOKEN`)이 비어 있으면 봇은 실제 업로드
> 없이 캡션만 생성해 대시보드에 보여줍니다. 토큰을 채우면 자동으로 실제 발행으로 전환됩니다.

---

## 0. GitHub에 올리기
```powershell
cd D:\workspace\insta-spot-bot
gh auth login
gh repo create insta-spot-bot --private --source=. --remote=origin --push
```

## 1. Turso DB 만들기 (무료 SQLite, 카드 X)
```bash
turso auth login                          # 브라우저 로그인
turso db create insta-spot-bot
turso db show insta-spot-bot --url        # → TURSO_DATABASE_URL (libsql://...)
turso db tokens create insta-spot-bot     # → TURSO_AUTH_TOKEN
```
> CLI 설치가 번거로우면 https://turso.tech 웹 대시보드에서 DB를 만들고 URL·토큰을
> 복사해도 됩니다. 테이블은 앱이 첫 실행 때 자동 생성합니다.

## 2. (선택) Gemini 키
https://aistudio.google.com → **Get API key** → `GEMINI_API_KEY`에 입력.
건너뛰면 내장 템플릿으로 캡션이 생성됩니다(품질 예시는 로컬 미리보기에서 확인).

## 3. Vercel 배포
1. https://vercel.com → **Add New… ▸ Project** → GitHub의 `insta-spot-bot` import
2. Framework: **Next.js** 자동 감지
3. **Environment Variables**에 `.env`의 모든 값을 등록:
   - `TOUR_API_KEY`, `CRON_SECRET`, `WEBHOOK_VERIFY_TOKEN`, `DM_KEYWORD`, `POSTS_PER_DAY_LIMIT`
   - `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
   - (선택) `GEMINI_API_KEY`, `GEMINI_MODEL`
   - Meta 토큰 4종은 발급 후 추가: `IG_USER_ID`, `IG_ACCESS_TOKEN`, `META_APP_SECRET`
4. **Deploy** → 배포 주소 확인 (예: `https://insta-spot-bot.vercel.app`)

## 4. Meta Graph API 토큰 (개발자 계정 차단 풀린 뒤)
README의 "3. Meta 개발자 앱" 절차대로 아래 4개를 발급해 Vercel 환경변수에 추가:
- `IG_USER_ID`, `IG_ACCESS_TOKEN`, `META_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`(이미 생성됨)

## 5. 웹훅 등록 (댓글 → 자동 DM)
1. Meta 앱 → **Webhooks** → **Instagram** 구독
2. 콜백 URL: `https://<배포주소>/api/webhook/instagram`
3. Verify Token: `.env`의 `WEBHOOK_VERIFY_TOKEN` 값
4. **comments** 필드 구독 체크

## 6. 매시 크론 등록 (무료)
Vercel Hobby 크론은 하루 1회 제한이라 외부 크론 사용:
1. https://cron-job.org 가입 (무료)
2. URL `https://<배포주소>/api/cron/post`, 매시 정각
3. 헤더 추가: `Authorization: Bearer <CRON_SECRET>`

---

## 로컬에서 미리 확인하기
```powershell
cd D:\workspace\insta-spot-bot
$env:Path = "C:\Program Files\nodejs;$env:Path"
npm install
npm run dev    # http://localhost:3200
```
다른 터미널에서 게시물 미리보기 생성:
```powershell
curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3200/api/cron/post
```
브라우저에서 대시보드를 열면 봇이 만들 캡션·해시태그를 미리 볼 수 있습니다.

> ⚠️ `npm run dev`가 실행 중일 때 `npm run build`를 돌리면 `.next`가 깨집니다.
> 빌드는 dev 서버를 끄고 하세요.

## 운영 팁
- 새 계정은 처음 2~4주 `POSTS_PER_DAY_LIMIT=6~8`로 시작 → 서서히 올리기 (스팸 탐지 회피)
- Meta 토큰은 **60일 만료** → 만료 전 갱신 필요
- 팔로우 여부는 API로 확인 불가 → 키워드 댓글 단 사람 모두에게 DM 발송
