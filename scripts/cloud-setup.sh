#!/usr/bin/env bash
# 클라우드 세션(claude.ai/code) / 새 리눅스 환경 초기 셋업.
# 시크릿 없이도 "코드 수정 → 오프라인 렌더로 눈 검증 → PR" 까지 가능하게 만든다.
#   bash scripts/cloud-setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ 의존성 설치"
npm ci --no-audit --no-fund

echo "▶ 동봉 폰트 설치 (Pretendard·G마켓 산스·잘난체 — 표지·카드 서체)"
mkdir -p ~/.fonts && cp assets/fonts/*.otf ~/.fonts/
if command -v fc-cache >/dev/null 2>&1; then fc-cache -f >/dev/null; else echo "  (fc-cache 없음 — sharp가 ~/.fonts를 못 볼 수 있음)"; fi

# 한글 시스템 폰트·ffmpeg는 있으면 좋고 없어도 오프라인 렌더는 됨 (ffmpeg는 실발행 렌더에만 필요)
if command -v apt-get >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
  echo "▶ (선택) 한글 폰트·이모지·ffmpeg"
  sudo apt-get update -qq >/dev/null 2>&1 && sudo apt-get install -y -qq fonts-noto-cjk fonts-noto-color-emoji ffmpeg >/dev/null 2>&1 \
    || echo "  (apt 설치 실패 — 건너뜀)"
fi

echo "▶ 검증: 오프라인 렌더 (시크릿 불필요)"
ROUNDUP_OFFLINE=1 npx tsx scripts/make-roundup.mjs
echo "✅ 셋업 완료 — roundup-reel-preview.jpg 를 열어 서체·레이아웃 확인"
