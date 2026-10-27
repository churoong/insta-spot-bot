#!/data/data/com.termux/files/usr/bin/bash
# 안드로이드 폰(Termux)에 비공식 API 에이전트 설치 — 집 와이파이에 상시 연결해 두는 폰용(2026-10-27).
#   curl -sL https://raw.githubusercontent.com/churoong/insta-spot-bot/main/private/termux-setup.sh | bash
# 끝나면 노트북에서 만든 insta-agent-transfer.zip(로그인 세션·.env)을 폰 '다운로드' 폴더에 넣고:
#   bash ~/insta-spot-bot/private/termux-setup.sh import
set -e

if [ "$1" = "import" ]; then
  termux-setup-storage || true
  sleep 2
  Z=~/storage/downloads/insta-agent-transfer.zip
  [ -f "$Z" ] || { echo "다운로드 폴더에 insta-agent-transfer.zip이 없습니다"; exit 1; }
  unzip -o "$Z" -d ~/insta-spot-bot
  grep -q '^AGENT_ONLINE=' ~/insta-spot-bot/.env || echo 'AGENT_ONLINE=08:30-22:30' >> ~/insta-spot-bot/.env
  rm -f "$Z"   # 비밀이 든 파일이라 옮긴 뒤 바로 지운다
  echo "가져오기 완료 — 폰을 재부팅하거나: bash ~/.termux/boot/insta-agent.sh"
  exit 0
fi

pkg update -y && pkg upgrade -y
# rust·clang: instagrapi가 쓰는 pydantic-core·pycryptodomex를 폰에서 직접 빌드한다(10~20분 걸릴 수 있음)
pkg install -y python git ffmpeg rust clang binutils make python-pillow python-numpy openssl libjpeg-turbo unzip termux-api
pip install --upgrade pip wheel
pip install requests "instagrapi==3.2.1"
# moviepy는 numpy·pillow를 pkg 것으로 쓰고, 영상 처리는 시스템 ffmpeg로(동봉 바이너리는 안드로이드에서 안 돈다)
pip install "moviepy==2.2.1" --no-deps
pip install decorator proglog imageio imageio-ffmpeg python-dotenv tqdm

cd ~
[ -d insta-spot-bot ] || git clone https://github.com/churoong/insta-spot-bot.git

# 부팅 때 자동 시작(Termux:Boot 앱 필요) — 하루 한 번 코드를 받아 에이전트를 새로 띄운다
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/insta-agent.sh <<'BOOT'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
export IMAGEIO_FFMPEG_EXE="$(command -v ffmpeg)"
pkill -f "private/agent.py" 2>/dev/null || true
nohup sh -c 'while true; do
  cd ~/insta-spot-bot && git pull -q || true
  cd ~/insta-spot-bot/private && timeout 86400 python agent.py
  sleep 10
done' >/dev/null 2>&1 &
BOOT
chmod +x ~/.termux/boot/insta-agent.sh
echo "설치 완료. 다음: 노트북에서 만든 insta-agent-transfer.zip을 폰 다운로드 폴더로 옮긴 뒤"
echo "  bash ~/insta-spot-bot/private/termux-setup.sh import"
