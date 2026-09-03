# insta-spot-bot — 작업 가이드 (Claude 세션용)

@tourist_710 인스타 맛집 계정("먹짱|전국 맛집 큐레이션")의 **완전 자동 발행 봇**.
Next.js 15(App Router) + Turso(libSQL) + Vercel + GitHub Actions. **전부 무료 티어**로 운영.
이 문서는 로컬 세션의 메모리를 대신한다 — 클라우드 세션은 이 문서만 보고 작업한다.

## 절대 규칙 (사용자 확정 — 되묻거나 재제안하지 말 것)
- **무료만**: 유료 API·플랜 추천 금지. 카드 등록은 "과금 0 조건"에서만 허용됨(구글 Places 대기 중).
- **남의 콘텐츠 금지**: 블로그·인스타 사진/영상 스크래핑·리그램 금지(저작권·잡코리아 판례). 비공식 프라이빗 API 금지.
- **재제안 금지 목록**: 폐업 필터(행안부 데이터) / 기상청·천문연 연동 / 릴스에 도장깨기 체크리스트 / 정답 공개 스토리 / 밸런스 게임 / dark 표지.
- **표지 문구**: 서술형(~해요) 금지, 개조식 명사구 2~3개. 관형형 종결 금지. 줌인 등 모션 금지(표지 8초 고정). "N선"(예: 6선) 금지 → "N대 맛집"/"TOP N".
- **훅 문구**: 감탄사·명사형·반문. 서술형 종결 금지, "이유" 단어 금지, 설명에 없는 숫자 금지.
- **조건형 팔로우 유도 문구 금지** ("팔로우하면 ~해줄게").
- 성과 판단은 좋아요가 아니라 **조회수·도달·저장**.

## 현재 발행 구성 (KST)
| 무엇 | 언제 | 워크플로 | 스크립트 |
|---|---|---|---|
| 일반 릴스(트라이얼) | 매일 08:00 (창 08~12) | reels.yml | scripts/make-reel.mjs |
| 모음집 릴스 + 표지 스토리 | 매일 17:30 (창 17:30~22:00) | roundup.yml | scripts/make-roundup.mjs |
| 큐레이션(카운트다운) | 월·금 12:30 (창 12:30~16) | countdown.yml | make-roundup (ROUNDUP_STYLE=countdown) |
| 캐러셀(저장형) | 토 12:30 (창 12:30~16) | carousel.yml | make-roundup (ROUNDUP_STYLE=carousel) |
| 월간 쇼츠 벤치마크 | 매월 1일 | benchmark.yml | scripts/benchmark-shorts.mjs |

**관리 페이지**(`/`, app/page.tsx): 게시물 목록에 ❤️💬 외에 👁 조회·도달·저장을 표시. 조회수 TOP3·주간 리포트·추천 시간대도 조회수 기준(2026-09-03). 값은 `/api/cron/metrics`(Vercel 크론 07:00·19:00 KST, CRON_SECRET)가 인스타 인사이트로 갱신해 posts.views/reach/saved/metrics_at에 저장. 좋아요는 `/api/cron/post`가 별도 갱신.

**발행 시각 구조**: Vercel Cron(vercel.json, ±59분) → `/api/cron/trigger/[wf]` → GitHub `workflow_dispatch` 즉시 실행이 주 경로.
GitHub schedule 크론은 폴백(혼잡기 4~11시간 지연 + 슬롯 드롭 실측). 각 yml 첫 스텝의 **KST 발행 창 게이트**가 창 밖 런을 수 초에 스킵하고, 스크립트의 **하루 1회 가드**가 중복을 막는다. 수동 실행(workflow_dispatch)은 게이트 통과.

## 표지·디자인 결정사항
- 스타일 순환 **classic 6 : hero 1** (cover_idx %7, dark 제외). classic 흰 카드 그리드가 실측 압승.
- 서체: 본문 `FONT`=Pretendard, 제목·상호명·순위 `TFONT`=G마켓 산스. **서체 A/B 진행 중**(G마켓 vs 잘난체, font_idx 교대, posts.title_font 기록) — 판정은 `scripts/cover-report.mjs` 서체별 평균(서체당 5건 이상).
- 표지 음식명 크기 캡 116px(`ms`). 콘텐츠는 4:5 안전영역(y 285~1635) 안에.
- 그리드 셀에 데이터 배지("🔎 후기·YT"), 캡션에 "🔎 선정 기준" 라인. 도장깨기 체크리스트는 **캐러셀 마지막 장에만**.
- 카운트다운 인트로 "맛집 브리핑, {음식} 톱N" 페르소나. TTS Laomedeia 1.18배속.
- 폰트 파일은 `assets/fonts/`(라이선스 LICENSE.md). 러너·클라우드는 `~/.fonts`에 설치해서 쓴다.

## 데이터 소스·랭킹
- 식당·사진: TourAPI(공용키) + 서울 음식관광 DB(`data/seoul-food.json` 사전 빌드) + 부산맛집 API + 비짓제주 + 포토코리아(표지 배경) + 착한가격업소(`data/goodprice.json`). `lib/vision.ts`가 음식 사진 여부를 비전으로 게이트("주제 음식 안 보이면 제외").
- 4축 합성 랭킹 `lib/ranking.ts`: 네이버 블로그·카페 후기 + 유튜브 조회수 + 네이버 리뷰순 진입 보너스. 전 스타일 적용.
- 테마 83개 `data/roundup-themes.json`: 음식 테마 55(권역 시리즈 15 포함, areaCodes 배열) + **지역편 28**(`mode:"area"`).
- **지역편(동네 맛집)**: 음식을 하나로 묶지 않고 "강릉 맛집 TOP 6"·"성수동 맛집 TOP 6"처럼 지역 우선(2026-09-03 사용자 지시). 도시 21곳은 TourAPI 시·군·구(`tour.areaCode/sigunguCode`), 상권 7곳은 좌표 반경 1.5km(`tour.mapX/mapY/radius`). 실측 기준 사진 풀 ≥30(도시)/≥20(상권)만 채택 — 더 좁은 골목 단위는 풀이 안 나온다. 카페·디저트·주점은 cat3(A05020900/A05021000)+상호 정규식으로 제외. **화·목·토 저녁 모음집**이 지역편 풀(area_idx 포인터)에서 나가고 나머지 요일은 음식 테마. 비전 게이트는 "음식 사진이면 통과"(food 없음), 랭킹 리뷰순 쿼리는 "{지역} 맛집", 포토코리아 배경 미사용.

## 검증 방법
```bash
# 클라우드 세션 첫 작업: 의존성·폰트·ffmpeg 설치 + 오프라인 렌더까지 한 번에
bash scripts/cloud-setup.sh
# 시크릿 없이 (클라우드 세션 기본) — 표지·캐러셀 카드 렌더
ROUNDUP_OFFLINE=1 npx tsx scripts/make-roundup.mjs      # → roundup-reel-preview.jpg, carousel-preview-*.jpg
COVER_TFONT="'Jalnan','Pretendard',sans-serif" ROUNDUP_OFFLINE=1 npx tsx scripts/make-roundup.mjs  # 서체 시안

# 시크릿 있을 때 — 실제 수집 포함 DRY (발행 없음)
ROUNDUP_THEME=gukbap ROUNDUP_DRY=1 npx tsx --env-file=.env scripts/make-roundup.mjs
ROUNDUP_STYLE=countdown ROUNDUP_THEME=naengmyeon ROUNDUP_DRY=1 npx tsx --env-file=.env scripts/make-roundup.mjs
ROUNDUP_STYLE=carousel ROUNDUP_DRY=1 npx tsx --env-file=.env scripts/make-roundup.mjs

npx tsc --noEmit && npx next build   # 웹훅·API·lib 변경 시 (Vercel 배포 대상)
node --check scripts/make-roundup.mjs
```
- GitHub 러너에서 실경로 렌더 확인: `gh workflow run roundup.yml -f dry=true` → 아티팩트 `dry-preview`.
- 디자인 변경 PR에는 렌더한 미리보기 이미지를 첨부/설명할 것 — 사용자는 폰에서 그림으로 판단한다.

## 함정 (실제로 겪은 것)
- `db.execute({ sql })`에 `args`가 없으면 libsql이 크래시 — 인자 없으면 문자열로 호출.
- `next.config.mjs`의 `outputFileTracingIncludes`에 `fs.readFileSync` 데이터 파일을 안 넣으면 Vercel에서 **조용히** 파일이 없다(`?diag=1`로 검증).
- ffmpeg `-t`를 입력 옵션 위치에 두면 무한 BGM 루프와 `-shortest`가 만나 렌더가 안 끝난다 — 출력 옵션으로.
- 셸 한 줄(node -e)로 한국어·백틱·`${}`가 든 소스를 수정하지 말 것 — 인용이 깨진다. 파일 편집은 편집 도구나 heredoc 스크립트로.
- 소스 파일은 CRLF일 수 있다 — 문자열 앵커 치환 시 `\r\n` 감안.
- 로컬 Windows Git Bash는 tzdata가 없어 `TZ=Asia/Seoul date`가 UTC로 폴백한다(러너는 정상). 시간은 UTC+9 산술로.
- 크론 지연 판단: `gh run list --json createdAt`으로 실측할 것. 추측 금지.
- **클라우드 세션(claude.ai/code) 네트워크**: npm·apt는 되지만 `tong.visitkorea.or.kr` 등 사진 호스트는 403(허용 목록 밖). 오프라인 렌더는 `data/dry-sample-photos/` 캐시(샘플 6장 커밋돼 있음) → 네트워크 → 색 플레이스홀더 순으로 폴백하므로 클라우드에서도 샘플 실사진으로 검증된다. 샘플(data/dry-sample.json)을 바꾸면 로컬에서 `ROUNDUP_OFFLINE=1`을 한 번 돌려 캐시를 다시 채우고 커밋. `apt-get update`는 이미지의 무관한 PPA 때문에 실패하지만 install은 된다.

## 작업 방식
- 브랜치 → PR(사용자가 폰에서 머지). main 머지 시 Vercel 자동 배포, Actions는 다음 발행부터 반영.
- 실발행·DB 변경·트리거 호출은 시크릿이 있을 때만 가능하며, 사용자가 명시적으로 요청했을 때만 한다.
- 새 아이디어 제안보다 **사용자가 정한 것을 정확히 구현**하는 게 우선. 위 재제안 금지 목록을 지킬 것.
