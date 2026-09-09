# insta-spot-bot — 작업 가이드 (Claude 세션용)

@tourist_710 인스타 맛집 계정("먹짱|전국 맛집 큐레이션")의 **완전 자동 발행 봇**.
Next.js 15(App Router) + Turso(libSQL) + Vercel + GitHub Actions. **전부 무료 티어**로 운영.
이 문서는 로컬 세션의 메모리를 대신한다 — 클라우드 세션은 이 문서만 보고 작업한다.

## 절대 규칙 (사용자 확정 — 되묻거나 재제안하지 말 것)
- **무료만**: 유료 API·플랜 추천 금지. 카드 등록은 "과금 0 조건"에서만 허용됨(구글 Places 대기 중).
- **남의 콘텐츠 금지**: 블로그·인스타 사진/영상 스크래핑·리그램 금지(저작권·잡코리아 판례). 비공식 프라이빗 API 금지.
- **재제안 금지 목록**: 폐업 필터(행안부 데이터) / 기상청·천문연 연동 / 릴스에 도장깨기 체크리스트 / 정답 공개 스토리 / 밸런스 게임 / dark 표지.
- **제목 공식**(2026-09-09 유튜브 실측 464건 반영, `buildPunchyTitle`/`buildHookTitle`): "TOP N" 금지(0.56x) → **"N대 맛집"만**. "줄서는·웨이팅·현지인" 수식어 금지(0.45x, 가장 흔하고 가장 약함). 지역편 캡션은 **지역명을 뒤로**("… 6대 맛집 · 원주" — 앞 6글자면 0.50x, 뒤면 1.96x). 훅 컷(3초)은 표지와 **다른** 반문형 문구(물음표 2.02x).
- **표지 문구**: 서술형(~해요) 금지, 개조식 명사구 2~3개. 관형형 종결 금지. 줌인 등 모션 금지(그리드 릴스 총 8초 고정 — 2026-09-07부터 훅 컷 3초 + 그리드 표지 5초, 장면 전환 1회만). "N선"(예: 6선) 금지 → "N대 맛집"/"TOP N".
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
GitHub schedule 크론은 폴백(혼잡기 4~11시간 지연 + 슬롯 드롭 실측). 각 yml 첫 스텝의 **KST 발행 창 게이트**가 창 밖 런을 수 초에 스킵하고, 스크립트의 **하루 1회 가드**(KST 날짜, 'publishing'은 30분 이내만 인정)가 중복을 막는다. 가드→마커 사이가 수 분이라 **yml job-level `concurrency`(직렬 실행)** 가 병렬 런의 이중 발행을 막는 실제 장치(2026-09-07 점검). 발행 중 실패·타임아웃(SIGTERM)은 마커를 `failed`로 정리해 폴백 슬롯이 재시도한다. 수동 실행(workflow_dispatch)은 게이트 통과. 타임아웃 25분(TourAPI 느린 날 15분 초과 실측 9/6).
- 지도 DM: 인스타 DM은 1,000바이트 한도 → `buildMapListDm`은 상호+지역 + 짧은 리다이렉트 `/go/{posts.id}/{n}`(app/go)만 담는다. 긴 주소·네이버 URL을 넣으면 전송이 거부된다. `/go`는 카카오 로컬 API(`KAKAO_REST_KEY`, Vercel 환경변수)로 그 가게의 카카오맵 상세 페이지를 찾아 보내고, 미등록이면 네이버 검색 링크로 폴백한다.
- ❌ 카카오 로컬 카테고리로 카페·주점을 거르는 건 **실익 없음**(2026-09-09 실측: 발행분 28곳 전원 순수 음식점). 현행 상호명+cat3 필터로 충분 — 다시 제안하지 말 것. ❌ 카카오 PlayMCP는 카카오 계정 OAuth 기반 대화형 AI 전용이라 무인 크론 파이프라인에 붙일 수 없다.

## 지금 진행 중인 것 (2026-09-09 기준 — 세션 인계용)
숫자는 스냅샷이라 낡는다. **최신 수치는 `gh workflow run report.yml` → 런 로그**(시크릿 없는 클라우드 세션도 실행·조회 가능).
발행 누락은 `publish-check.yml`이 매일 자동 점검해 GitHub 이슈로 알린다.

| 실험 | 현황 | 판정 조건 |
|---|---|---|
| 서체 A/B (G마켓 vs 잘난체) | gmarket 6 · jalnan 2 | 서체당 5건 이상. ⚠️ **grid만 A/B 대상** — countdown·carousel도 `title_font='gmarket'`으로 기록되니 집계에서 걸러야 한다(그래서 gmarket 쪽이 부풀어 보인다) |
| 훅 컷 A/B (`grid8` vs `hook3+grid5`) | hook3+grid5 1건 (9/8 도입) | **시청 시간** 우선. 도입 전 표본과 조회수 직접 비교 금지 |
| 표지 순환 (classic 10 : pages 2 : hero 1) | classic 9(평균 1,259) · hero 4(75) · pages 1(183) | pages가 얇다 — 5건 모이면 재판정 |

**대기 중(사용자 액션 필요)**: 구글 Places(카드 등록, 과금 0 조건) · 인스타 음악 카탈로그 한국 개방(현재 0곡, CC BGM 폴백 중).

**막혀 있는 데이터 소스(재시도만 하면 되는 것 — 2026-09-09 기준)**
| 소스 | 상태 | 다음 행동 |
|---|---|---|
| 광주·경남 레드테이블 | 토큰 유효(엉터리 키는 `30`, 우리 키는 `2`)·경로 정확한데 **서버 `DB_ERROR`** | 며칠 뒤 `/api/rstr?pageNo=1&serviceKey=…` 재호출. 살아나면 서울판 코드 재사용해 붙인다(토큰은 사용자 보유) |
| 전북 권역별음식점 | 승인 반영 대기(`resultCode 30`) | `openapi.jbfood.go.kr/AreaRestaurantService/getAreaRestaurant` 재시도. `SG_APIM`·`ServiceKey` 둘 다 필요 |
| 대전 `bigdata.daejeon.go.kr` | 키 없이 2만 곳 조회되나 **사진 없음** | 붙이지 말 것(릴스에 사진 필수). 좌표·메뉴 보강이 필요해지면 그때 |

**게시물 아이디어 벤치마킹(2026-09-09 진행 중)**: 유튜브 API 실수집(제목 공식·길이·채널 유형)과 2026 릴스 포맷 트렌드를 조사 중. 기존 월간 리포트(`benchmark-reports/`)의 제안 중 **표지 타이포 컬러 포인트**만 우리 규칙과 충돌이 없어 후보로 남아 있다(미적용). 인물·역동적 컷 제안은 무출연 제약상 불가, 도발 서사형 훅은 확정 훅 규칙과 충돌이라 배제.

## 환경변수·시크릿 맵 (어디에 있어야 하는가)
| 키 | 로컬 .env | GitHub Actions | Vercel | 쓰는 곳 |
|---|---|---|---|---|
| TOUR_API_KEY, GEMINI/GROQ, TURSO_*, IG_*, FB_*, YOUTUBE, JEJU, NAVER_* | ✅ | ✅ | 일부(웹훅·크론용) | 발행 파이프라인 |
| `KAKAO_REST_KEY` | ✅ | 불필요 | ✅ (2026-09-09 등록) | `/go` 지도 링크 전용 |
| `GITHUB_TOKEN`(PAT, Actions 쓰기) + `GITHUB_REPO` | — | — | ✅ | Vercel 크론 → workflow_dispatch |
| (키 불필요) | — | — | — | 원주 `data/wonju-food.json`·경주는 커밋된 파일/공용 TourAPI 키라 클라우드에서도 그대로 동작 |

클라우드 세션에는 시크릿이 없다 — 코드 수정·오프라인 렌더·PR·`gh workflow run`까지가 범위이고, 실발행·DB 조회는 로컬 세션이나 Actions를 거친다.

## 표지·디자인 결정사항
- 스타일 순환 **classic 10 : pages 2 : hero 1** (13주기, `COVER_STYLES` 배열 길이가 곧 주기, dark 제외).
  2026-09-07 실측(cover-report, 17건): classic 조회 평균 1,565(중앙값 약 800) vs hero 150 · pages 181 · dark 256
  → hero를 1/7에서 1/13으로 축소(사용자 지시). hero는 카운트다운형 렌더를 타는 유일한 모음집 경로라 포맷
  비교용으로 남긴다. **주기는 홀수를 유지할 것** — 서체 A/B(font_idx %2)와 표지 포인터가 함께 움직여서
  짝수면 특정 표지에 특정 서체만 붙어 두 실험이 엉킨다.
- 서체: 본문 `FONT`=Pretendard, 제목·상호명·순위 `TFONT`=G마켓 산스. **서체 A/B 진행 중**(G마켓 vs 잘난체, font_idx 교대, posts.title_font 기록) — 판정은 `scripts/cover-report.mjs` 서체별 평균(서체당 5건 이상).
- **그리드 릴스 첫 3초 = 훅 컷**(2026-09-07 사용자 결정): 음식 풀샷 + 제목만(= hero 표지 렌더러
  `composeHeroCover`)을 3초 보여준 뒤 그리드 표지 5초. 총 8초·모션 없음·전환 1회는 그대로.
  이유는 평균 시청 4.9초 — 정보가 빽빽한 그리드를 다 읽기 전에 이탈한다. 훅 컷 생성이 실패하면
  기존 표지 8초 단일컷으로 자동 폴백한다(`buildHookCut` → null).
  단 **프로필 그리드 썸네일은 여전히 그리드 표지**다 — 발행 시 `thumb_offset=4000ms`(훅 다음 1초)을
  지정한다. 안 하면 0프레임(음식 풀샷)이 커버가 되는데, 조회수 실측이 그리드 표지 쪽(classic 1,565
  vs hero 150)이라 커버까지 바꾸지는 않는다. 인스타가 `thumb_offset`을 **동기 거부하든 컨테이너를
  받아 놓고 status=ERROR로 떨어뜨리든**(생성+폴링을 한 덩어리로 묶어 놨다) 커버 지정만 빼고 1회
  재시도하고, 다른 호스트 재업로드 재시도는 아예 커버 지정 없이 간다 — 커버 프레임 하나 때문에
  그날 콘텐츠를 잃지 않기 위해서다.
  카운트다운·hero·pages·캐러셀은 해당 없음(이미 첫 컷이 따로 있다).
- **`posts.reel_format`에 실제로 나간 구성을 기록**(`hook3+grid5` / `grid8` / `pages` / `countdown`).
  `cover_style`만으로는 훅 컷 도입 전후가 구분되지 않아, 훅 실패로 8초 단일컷이 나간 회차가
  같은 `classic` 평균에 섞인다. `cover-report.mjs`가 이 값으로 **릴스 구성별 평균(훅 컷 A/B)** 표를
  따로 찍고, 서체 A/B 표에도 구성을 병기한다.
  ⚠️ 위 **classic 1,565 vs hero 150(17건)은 훅 컷 도입 이전(표지 8초 단일컷) 표본**이다 —
  이후 classic과 직접 평균 비교 금지. 훅 효과 판정은 `grid8` vs `hook3+grid5`, 특히 **시청 시간**으로.
- **사진 없는 칸 = 정보 패널**(2026-09-09): 발굴은 됐는데 사진이 없는 식당을 쓰려고, 빈칸 대신
  `대표메뉴`(없으면 상호명, 최대 2줄) 패널을 그린다(`noPhotoPanel` in composeReelCover).
  **생성 이미지는 쓰지 않는다** — 순위 카드의 사진은 "그 가게의 음식"이라는 진술이라 없는 사실을
  만드는 셈이고, `lib/pexels.ts`가 스톡 사진에 대해 이미 정해 둔 원칙(특정 가게에 붙이지 않음,
  사칭 방지)과 같은 선이다. 메타의 AI 라벨링 정책도 걸린다. 패널 하단 54px은 기존 칩
  (지역·후기/YT·백년가게) 자리라 비워 둔다. 시안: `NOPHOTO_DEMO=1` 또는 `ROUNDUP_NOPHOTO="2,5"`.
  ※ 무사진 칸 개수 상한은 아직 없다 — 3칸부터는 "사진 못 구한 편"으로 보인다(시안 판단).
- 표지 음식명 크기 캡 116px(`ms`). 콘텐츠는 4:5 안전영역(y 285~1635) 안에.
- 그리드 셀에 데이터 배지("🔎 후기·YT"), 캡션에 "🔎 선정 기준" 라인. 도장깨기 체크리스트는 **캐러셀 마지막 장에만**.
- 카운트다운 인트로 "맛집 브리핑, {음식} 톱N" 페르소나. TTS Laomedeia 1.18배속.
- 폰트 파일은 `assets/fonts/`(라이선스 LICENSE.md). 러너·클라우드는 `~/.fonts`에 설치해서 쓴다.

## 데이터 소스·랭킹
- 식당·사진: TourAPI(공용키) + 서울 음식관광 DB(`data/seoul-food.json` 사전 빌드) + 부산맛집 API + 비짓제주 + **경주 먹거리 핫플레이스**(`5050000/eatHtpService`, 61곳 중 사진 생존 41곳 — URL에 스킴이 없어 https 접두 필요, 1/3이 404라 기동 시 병렬 확인해 캐시) + 포토코리아(표지 배경) + 착한가격업소(`data/goodprice.json`). `lib/vision.ts`가 음식 사진 여부를 비전으로 게이트("주제 음식 안 보이면 제외").
- **원주 식당 DB**(강원 유일 사진 소스): `data/wonju-food.json` 300곳 · `lib/wonjufood.ts` · 빌드는 `scripts/build-wonju-db.mjs`. 원본 이미지 호스트가 DNS 소멸이라 빌드 때 서울판 버킷으로 치환한다. 파일데이터 uddi는 `infuser.odcloud.kr/oas/docs?namespace={pk}/v1`에서 얻는다.
- **사진 있는 식당 API 전국 조사 완료(2026-09-09)** — 더 찾지 말 것. 남은 후보는 **광주·경남 레드테이블**(`{gwangju,gyeongnam}.openapi.redtable.global`, 서울판과 동일 스키마·`/rstr/img`·`/food/img` 보유, **지역별 토큰 별도 발급** — 서울 토큰 안 통함)과 **전북 권역별음식점**(`openapi.jbfood.go.kr`, 자동승인)뿐. ❌ 대구푸드(daegufood.go.kr)는 API에 사진이 없고 사진 경로 `/data/`가 **robots.txt 금지**라 제외. ❌ 인천·경기·충북·충남·세종·강릉은 공공 영역에 사진 소스 자체가 없음. ❌ 전주시 자체 API는 목록 조회 오퍼레이션이 없는 반쪽(과거 '빈 응답'의 원인).
- 4축 합성 랭킹 `lib/ranking.ts`: 네이버 블로그·카페 후기 + 유튜브 조회수 + 네이버 리뷰순 진입 보너스. 전 스타일 적용.
- 테마 123개 `data/roundup-themes.json`: 음식 테마 55(전국 40 + 권역×음식 15, areaCodes 배열) + **지역편 68**(`mode:"area"`: 상권 47 + 도시 21).
- **상권 풀 보강**: 상권 수집기가 좌표 반경 안의 부산맛집 API·비짓제주·서울 음식관광 DB 식당을 TourAPI에 합친다(`supplementNearby`, 보조 소스는 풀의 절반 또는 TourAPI 부족분까지). 부산(서면·광안리·남포·경성대·영도)·제주(동문시장·연동·올레시장·중문·성산·함덕·협재) 상권은 이 보강 없이는 불가. 후보 측정은 `scripts/measure-spot.mjs`. 2026-09-03 전국 조사 결과: 서울 외곽·부산 도심·대구·광주·전주·강릉 상권은 TourAPI가 얇아 탈락(카페 제외 후 <20).
- **캡션에 사진 출처 라인 없음**(2026-09-03 사용자 지시 "캡션에 사진 출처 내용은 다 빼"): TourAPI·포토코리아 크레딧 라인 전부 제거. BGM CC BY 크레딧(🎵)은 라이선스 의무라 유지. ※ 공공누리 1·3유형은 출처표시가 이용조건 — 사용자가 인지한 결정.
- **지역편(동네 맛집)**: 음식을 하나로 묶지 않고 "강릉 맛집 TOP 6"·"성수동 맛집 TOP 6"처럼 지역 우선(2026-09-03 사용자 지시). 도시는 TourAPI 시·군·구(`tour.areaCode/sigunguCode`), 상권은 좌표 반경 1.5km(`tour.mapX/mapY/radius`). 카페 제외 후 사진 풀 ≥30(도시)/≥20(상권)만 채택 — 골목 단위·도시×단일음식(춘천 닭갈비 등, 풀 0~9)은 불가. 카페·디저트·주점은 cat3(A05020900/A05021000)+상호 정규식으로 제외. 비전 게이트는 "음식 사진이면 통과"(food 없음), 랭킹 리뷰순 쿼리는 "{지역} 맛집", 포토코리아 배경 미사용.
- **지역 테마 사전 가중치**(2026-09-09): 미시도 테마가 전부 2.0으로 평탄해 인지도 낮은 지역이
  같은 확률로 뽑혔다(대전 유성 조회 95). `lib/visitors.ts`가 한국관광공사 **지역별 방문자수**
  (data.go.kr 15101972, 무료, **해당 데이터셋 활용신청 별도 필요**)로 시군구 규모를 받아
  실측 조회수가 없는 지역편 테마에만 0.8~4.0 사전 가중치를 준다. 테마→시군구는 카카오 로컬로
  해석(`KAKAO_REST_KEY` — 이 브랜치에서 roundup/countdown/carousel.yml에 처음 추가됐다).
  **시군구는 이름만으로 식별되지 않는다**(중구·동구·서구·남구·북구·고성군은 여러 시도에 있다)
  → 시도까지 맞을 때만 값을 주고, 모호하면 포기해 기존 2.0으로 남긴다. 규칙 테스트:
  `npx tsx scripts/test-visitors.mjs`(네트워크 없이 28건). 카카오가 동명 지명을 잘못 잡으면
  (거제→부산 연제구 거제동) 테마의 `region`과 대조해 버린다 — 그럴듯하게 틀린 쌍이 시도 가드를
  우회하기 때문. 응답 스키마 확인됨(2026-09-09 승인 후 실측): 시군구 응답은 시도 이름 없이 signguCode/signguNm/touDivCd(1현지인·2외지인·3외국인)/touNum/baseYmd만 온다 → parseRow가 법정동 코드 앞 2자리로 시도를 복원한다. 최신 월은 데이터가 채워지는 중이라 행 수가 불균일해 폐기되고 2~3개월 전 달이 쓰인다(정상). 검증: 시군구 268곳 전원 시도 확인, 지역편 66/68에 가중치.
  실물 확인은 `report.yml`을 `probe=true`로 실행(`scripts/probe-visitors.mjs`).
  실패는 72시간 음성 캐시라 미승인 상태여도 발행이 느려지지 않는다.
- **저녁 모음집 요일 슬롯**(사용자 우선순위 상권 > 지역 > 전국): 화·목·토 = 상권(spot_idx) / 월·금 = 지역(도시 종합 + 권역×음식, city_idx) / 수·일 = 전국 음식(roundup_idx). `SLOT_BY_DOW` in make-roundup. 큐레이션·캐러셀은 음식 테마만.

## 검증 방법
```bash
# 클라우드 세션 첫 작업: 의존성·폰트·ffmpeg 설치 + 오프라인 렌더까지 한 번에
bash scripts/cloud-setup.sh
# 시크릿 없이 (클라우드 세션 기본) — 표지·캐러셀 카드 렌더
ROUNDUP_OFFLINE=1 npx tsx scripts/make-roundup.mjs      # → roundup-hook-preview.jpg(첫 3초), roundup-reel-preview.jpg, carousel-preview-*.jpg
OFFLINE_RENDER=1 ROUNDUP_OFFLINE=1 npx tsx scripts/make-roundup.mjs  # 위 + 8초 릴스까지 실제 렌더 → roundup-reel-preview.mp4
COVER_TFONT="'Jalnan','Pretendard',sans-serif" ROUNDUP_OFFLINE=1 npx tsx scripts/make-roundup.mjs  # 서체 시안

# 시크릿 있을 때 — 실제 수집 포함 DRY (발행 없음)
ROUNDUP_THEME=gukbap ROUNDUP_DRY=1 npx tsx --env-file=.env scripts/make-roundup.mjs
ROUNDUP_STYLE=countdown ROUNDUP_THEME=naengmyeon ROUNDUP_DRY=1 npx tsx --env-file=.env scripts/make-roundup.mjs
ROUNDUP_STYLE=carousel ROUNDUP_DRY=1 npx tsx --env-file=.env scripts/make-roundup.mjs

npx tsc --noEmit && npx next build   # 웹훅·API·lib 변경 시 (Vercel 배포 대상)
node --check scripts/make-roundup.mjs
npx tsx scripts/test-visitors.mjs    # 시군구 매칭 규칙 (네트워크·시크릿 불필요)
NOPHOTO_DEMO=1 ROUNDUP_OFFLINE=1 npx tsx scripts/make-roundup.mjs  # 무사진 칸 시안
```
- GitHub 러너에서 실경로 렌더 확인: `gh workflow run roundup.yml -f dry=true` → 아티팩트 `dry-preview`.
- 실패한 회차 재발행: `gh workflow run roundup.yml -f theme=<테마키>` (예: area-seongsu). 시작 시 30분 넘은 `publishing` 행은 `failed`로 정리되고, 같은 테마의 failed 행은 지워진 뒤 재시도된다. 시크릿 없는 클라우드 세션도 GitHub MCP로 workflow_dispatch(브랜치 ref 가능)는 할 수 있다 — 단 사용자가 명시적으로 요청했을 때만.
- 디자인 변경 PR에는 렌더한 미리보기 이미지를 첨부/설명할 것 — 사용자는 폰에서 그림으로 판단한다.

## 함정 (실제로 겪은 것)
- `db.execute({ sql })`에 `args`가 없으면 libsql이 크래시 — 인자 없으면 문자열로 호출.
- posts 행은 인스타 발행 **전에** `publishing`으로 선기록된다. 발행 중 예외가 나면 마지막 catch가 `failed`로 바꾼다(2026-09-03 성수 편: 인스타가 사유 없이 컨테이너 ERROR → 행이 `publishing`으로 남아 대시보드엔 게시된 듯 보이고 하루 1회 가드가 재발행을 막았음). 릴스 컨테이너 ERROR는 다른 호스트로 재업로드해 1회 재시도한다.
- `next.config.mjs`의 `outputFileTracingIncludes`에 `fs.readFileSync` 데이터 파일을 안 넣으면 Vercel에서 **조용히** 파일이 없다(`?diag=1`로 검증).
- ffmpeg `-t`를 입력 옵션 위치에 두면 무한 BGM 루프와 `-shortest`가 만나 렌더가 안 끝난다 — 출력 옵션으로.
- 셸 한 줄(node -e)로 한국어·백틱·`${}`가 든 소스를 수정하지 말 것 — 인용이 깨진다. 파일 편집은 편집 도구나 heredoc 스크립트로.
- 소스 파일은 CRLF일 수 있다 — 문자열 앵커 치환 시 `\r\n` 감안.
- 로컬 Windows Git Bash는 tzdata가 없어 `TZ=Asia/Seoul date`가 UTC로 폴백한다(러너는 정상). 시간은 UTC+9 산술로.
- 크론 지연 판단: `gh run list --json createdAt`으로 실측할 것. 추측 금지.
- **클라우드 세션 네트워크 차단 목록**(2026-09 실측): `data.go.kr`·`apis.data.go.kr`·`api.visitkorea.or.kr`·
  `docs.foursquare.com`·`overpass-api.de`·`huggingface.co`·`source.coop`, DuckDB 확장 서버(`extensions.duckdb.org`).
  즉 **공공데이터 API 스펙도 실호출도 클라우드에서는 확인할 수 없다** — 러너(report.yml probe)로 넘길 것.
  열리는 것: `overturemaps-us-west-2.s3.amazonaws.com`(Overture Maps 공개 버킷), npm·pip.
- **클라우드 세션(claude.ai/code) 네트워크**: npm·apt는 되지만 `tong.visitkorea.or.kr` 등 사진 호스트는 403(허용 목록 밖). 오프라인 렌더는 `data/dry-sample-photos/` 캐시(샘플 6장 커밋돼 있음) → 네트워크 → 색 플레이스홀더 순으로 폴백하므로 클라우드에서도 샘플 실사진으로 검증된다. 샘플(data/dry-sample.json)을 바꾸면 로컬에서 `ROUNDUP_OFFLINE=1`을 한 번 돌려 캐시를 다시 채우고 커밋. `apt-get update`는 이미지의 무관한 PPA 때문에 실패하지만 install은 된다.

## 작업 방식
- 브랜치 → PR(사용자가 폰에서 머지). main 머지 시 Vercel 자동 배포, Actions는 다음 발행부터 반영.
- 실발행·DB 변경·트리거 호출은 시크릿이 있을 때만 가능하며, 사용자가 명시적으로 요청했을 때만 한다.
- 새 아이디어 제안보다 **사용자가 정한 것을 정확히 구현**하는 게 우선. 위 재제안 금지 목록을 지킬 것.
