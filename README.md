# 📍 Insta Spot Bot

맛집·여행지를 **1시간에 하나씩** 인스타그램에 자동 포스팅하는 봇.

- 사진·정보: **한국관광공사 TourAPI** (공공데이터 — 출처 표기 조건으로 합법적 이용 가능)
- 캡션·해시태그: **Gemini API 무료 등급** 자동 생성 (상호명 미노출 티저 스타일).
  키가 없으면 내장 템플릿으로 생성 — 어느 쪽이든 무료
- 댓글에 키워드(기본 `어디야`)를 남기면 **자동으로 DM**으로 장소를 알려줌
- 모든 게시글에 출처 명시: `📷 사진·정보 출처: 한국관광공사 TourAPI`
- 스택: Next.js + Turso + Vercel + cron-job.org — **전 구간 무료, 카드 등록 불필요**

> ⚠️ 인스타그램/네이버에서 남의 사진을 긁어 재업로드하는 것은 출처를 적어도
> **저작권 침해 + 플랫폼 약관 위반(계정 정지 사유)** 입니다.
> 이 봇은 그래서 공공데이터(관광공사)를 사용합니다.

---

## 동작 구조

```
[cron-job.org 매시 정각]
   → GET /api/cron/post
   → TourAPI에서 새 장소 선정 (중복 제외, 하루 한도 체크)
   → Gemini(또는 내장 템플릿)가 캡션+해시태그 생성 (상호명 숨김)
   → Instagram Graph API로 발행
   → Turso에 media_id ↔ 장소 매핑 저장

[누군가 댓글 작성]
   → Meta 웹훅 → POST /api/webhook/instagram
   → 키워드("어디야") 포함 여부 확인
   → Private Reply API로 장소 정보 DM 발송 + 댓글 답글
```

## 셋업 (순서대로)

### 1. TourAPI 키 발급 (5분, 무료)
1. [공공데이터포털](https://www.data.go.kr) 회원가입
2. **"한국관광공사_국문 관광정보 서비스_GW"** 검색 → 활용신청 (자동승인)
3. 마이페이지에서 **일반 인증키(Decoding)** 값을 `TOUR_API_KEY`에

### 2. 인스타그램 준비
1. 인스타그램 계정을 **프로페셔널(비즈니스) 계정**으로 전환
2. Facebook 페이지를 하나 만들고 인스타그램 계정과 연결

### 3. Meta 개발자 앱 (가장 손이 많이 감)
1. [developers.facebook.com](https://developers.facebook.com) → 앱 만들기 (유형: Business)
2. 제품 추가: **Instagram Graph API** + **Webhooks**
3. Graph API 탐색기에서 아래 권한으로 토큰 발급:
   - `instagram_basic`, `instagram_content_publish`
   - `instagram_manage_comments`, `instagram_manage_messages`
   - `pages_show_list`, `pages_read_engagement`
4. 토큰을 [장기 토큰(60일)으로 교환](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived) → `IG_ACCESS_TOKEN`
5. `GET /me/accounts` → 페이지 ID → `GET /{page-id}?fields=instagram_business_account` → 숫자 ID를 `IG_USER_ID`에
6. 앱 설정 → 기본 설정의 **앱 시크릿** → `META_APP_SECRET`

> 본인 계정만 쓰면 앱을 개발 모드로 두고 본인을 관리자/테스터로 등록하면 됨
> (앱 심사 불필요). 토큰은 60일마다 갱신 필요.

### 3.5 Gemini API 키 (무료, 카드 불필요, 선택사항)
1. [aistudio.google.com](https://aistudio.google.com) → **Get API key** → 키 생성
2. `GEMINI_API_KEY`에 입력 (무료 등급: 하루 1,500회 — 우리는 24회/일)
3. 건너뛰어도 됨 — 키가 없으면 내장 템플릿으로 캡션 생성

### 4. Turso DB (무료)
```bash
turso db create insta-spot-bot
turso db show insta-spot-bot --url      # → TURSO_DATABASE_URL
turso db tokens create insta-spot-bot   # → TURSO_AUTH_TOKEN
```
테이블은 첫 실행 시 자동 생성됩니다.

### 5. 배포 (Vercel)
```bash
npm i -g vercel
vercel --prod
```
Vercel 대시보드에서 `.env.example`의 모든 변수를 환경변수로 등록.

### 6. 웹훅 등록 (댓글 → DM)
1. Meta 앱 → Webhooks → **Instagram** 구독
2. 콜백 URL: `https://<배포주소>/api/webhook/instagram`
3. Verify Token: `.env`의 `WEBHOOK_VERIFY_TOKEN`과 같은 값 입력
4. **comments** 필드 구독 체크

### 7. 시간별 크론 (무료)
Vercel Hobby 플랜의 크론은 하루 1회 제한이라 외부 크론을 사용:
1. [cron-job.org](https://cron-job.org) 가입 (무료)
2. 새 작업: URL `https://<배포주소>/api/cron/post`, 매시 정각
3. 헤더 추가: `Authorization: Bearer <CRON_SECRET>`

## 미리보기(드라이런) 모드

`IG_ACCESS_TOKEN`이 비어 있으면 봇은 **실제 인스타그램 업로드 없이 캡션만 생성**해
대시보드에 보여줍니다. Meta 계정 준비 전에 결과물을 미리 확인하는 용도이며,
토큰을 채우면 자동으로 실제 발행 모드로 전환됩니다. DB도 로컬에선 `local.db`
파일로 자동 폴백돼서 Turso 없이도 테스트할 수 있습니다.

## 로컬 테스트

```bash
npm install
cp .env.example .env   # 값 채우기 (TourAPI 키만 있어도 미리보기 동작)
npm run dev            # http://localhost:3200
# 수동으로 미리보기 1건 생성:
curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3200/api/cron/post
```

자세한 배포 절차는 **[DEPLOY.md](./DEPLOY.md)** 참고.

## 설정값

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `DM_KEYWORD` | `어디야` | 댓글에 이 단어가 있으면 DM 발송 |
| `POSTS_PER_DAY_LIMIT` | `24` | 하루 최대 발행 수 (API 한도 50/일) |
| `GEMINI_API_KEY` | (없음) | 있으면 Gemini로 캡션 생성, 없으면 내장 템플릿 |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini 무료 등급 모델 |

## 알아둘 것

- **팔로우 여부는 API로 확인 불가** — Instagram API는 특정 유저의 팔로우 여부를
  조회할 수 없어서, 키워드 댓글을 단 사람 모두에게 DM을 보냅니다.
  캡션의 "팔로우하면"은 참여 유도 문구로 동작합니다 (ManyChat 등 상용 툴도 동일).
- **새 계정 + 시간당 1개(24개/일)는 스팸으로 찍힐 위험**이 있습니다.
  처음 2~4주는 `POSTS_PER_DAY_LIMIT=6~8` 정도로 시작해서 서서히 올리는 걸 권장.
- Private Reply는 **댓글 1개당 DM 1회**만 허용 (Meta 정책).
- 토큰 만료(60일) 시 갱신 필요 — 만료 임박 알림을 원하면 크론 응답을 모니터링.
