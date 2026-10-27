"""DM 답장용 공유 카드(2026-10-27 사용자 결정 — "내 동네 맛집 지도"·"맛집 영수증").

DM으로 동네를 물으면 글자 목록과 함께 이미지 두 장을 보낸다. 받은 사람만을 위한 이미지라 캡처·공유되고,
구석의 우리 아이디(@…)가 같이 퍼진다.
  map_card     OpenStreetMap 타일 위에 번호 핀 — 타일 이용 정책상 User-Agent·출처 표기 필수, 소량만 쓴다
  receipt_card 영수증 디자인 리스트
"""
from __future__ import annotations

import io
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from common import REPO, ig_handle

FONT_B = str(REPO / "assets" / "fonts" / "Pretendard-ExtraBold.otf")
FONT_M = str(REPO / "assets" / "fonts" / "Pretendard-Bold.otf")
FONT_R = str(REPO / "assets" / "fonts" / "Pretendard-Regular.otf")
UA = {"User-Agent": "insta-spot-bot/1.0 (+https://github.com/churoong/insta-spot-bot)"}
RED = (224, 32, 32)


def _font(path, size):
    return ImageFont.truetype(path, size)


def _deg2num(lat, lng, z):
    n = 2 ** z
    x = (lng + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def _basemap(cx: float, cy: float, places: list, size: int = 1080):
    """중심(경도 cx, 위도 cy)과 장소들이 다 들어가는 줌을 골라 OSM 타일을 이어 붙인다."""
    pts = [(cy, cx)] + [(p["y"], p["x"]) for p in places]
    for z in range(17, 11, -1):
        xs, ys = zip(*[_deg2num(la, lo, z) for la, lo in pts])
        if (max(xs) - min(xs)) * 256 < size * 0.8 and (max(ys) - min(ys)) * 256 < size * 0.8:
            break
    mx, my = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    half = size / 2 / 256
    tx0, ty0 = int(math.floor(mx - half)), int(math.floor(my - half))
    tx1, ty1 = int(math.floor(mx + half)), int(math.floor(my + half))
    canvas = Image.new("RGB", ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256), (230, 230, 230))
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            try:
                r = requests.get(f"https://tile.openstreetmap.org/{z}/{tx}/{ty}.png", headers=UA, timeout=15)
                canvas.paste(Image.open(io.BytesIO(r.content)).convert("RGB"), ((tx - tx0) * 256, (ty - ty0) * 256))
            except Exception:
                pass
    left, top = (mx - half - tx0) * 256, (my - half - ty0) * 256
    img = canvas.crop((int(left), int(top), int(left) + size, int(top) + size))

    def to_px(lat, lng):
        x, y = _deg2num(lat, lng, z)
        return (x - tx0) * 256 - left, (y - ty0) * 256 - top
    return img, to_px


def map_card(path: Path, who: str, area: str, cx: float, cy: float, places: list):
    """places: [{'name','x','y'}] 최대 5곳. 1080x1350."""
    W, H = 1080, 1350
    base, to_px = _basemap(cx, cy, places, 1080)
    base = Image.blend(base, Image.new("RGB", base.size, (255, 255, 255)), 0.15)
    img = Image.new("RGB", (W, H), (18, 11, 8))
    img.paste(base, (0, 170))
    d = ImageDraw.Draw(img)
    d.text((48, 30), f"{who}님의", font=_font(FONT_M, 36), fill=(255, 217, 201))
    d.text((48, 80), f"{area} 맛집 지도", font=_font(FONT_B, 56), fill=(255, 255, 255))
    for i, p in enumerate(places[:5], start=1):
        x, y = to_px(p["y"], p["x"])
        y += 170
        d.ellipse([x - 26, y - 26, x + 26, y + 26], fill=RED, outline=(255, 255, 255), width=4)
        d.text((x, y), str(i), font=_font(FONT_B, 30), fill=(255, 255, 255), anchor="mm")
    d.rectangle([0, 1250, W, H], fill=(18, 11, 8))
    names = "  ".join(f"{i}. {p['name']}" for i, p in enumerate(places[:5], start=1))
    d.text((48, 1282), names[:60], font=_font(FONT_M, 26), fill=(255, 255, 255))
    d.text((48, 1320), "© OpenStreetMap contributors", font=_font(FONT_R, 20), fill=(150, 140, 135))
    d.text((W - 48, 1320), "@" + ig_handle(), font=_font(FONT_M, 24), fill=(200, 190, 185), anchor="ra")
    img.save(path, quality=92)


def receipt_card(path: Path, who: str, area: str, places: list):
    """영수증 디자인. places: [{'name','kind'}] 최대 5곳. 1080x1350."""
    W, H = 1080, 1350
    bg = Image.new("RGB", (W, H), (34, 22, 18))
    paper = Image.new("RGB", (760, 1150), (250, 248, 242))
    d = ImageDraw.Draw(paper)
    mono_b, mono = _font(FONT_B, 44), _font(FONT_M, 30)
    small = _font(FONT_R, 24)
    now = datetime.now(timezone(timedelta(hours=9)))
    d.text((380, 70), "맛디깅 맛집 영수증", font=mono_b, fill=(20, 20, 20), anchor="mm")
    d.text((380, 125), f"{now:%Y.%m.%d %H:%M}  ·  {who}님", font=small, fill=(90, 90, 90), anchor="mm")
    y = 175
    d.line([(40, y), (720, y)], fill=(120, 120, 120), width=2)
    d.text((40, y + 25), f"주문 동네  {area}", font=mono, fill=(20, 20, 20))
    y += 95
    d.line([(40, y), (720, y)], fill=(180, 180, 180), width=1)
    y += 30
    for i, p in enumerate(places[:5], start=1):
        name = p["name"] if len(p["name"]) <= 12 else p["name"][:11] + "…"
        d.text((40, y), f"{i}. {name}", font=mono, fill=(20, 20, 20))
        d.text((720, y), p.get("kind") or "추천", font=mono, fill=(20, 20, 20), anchor="ra")
        y += 88
    y += 20
    d.line([(40, y), (720, y)], fill=(120, 120, 120), width=2)
    y += 30
    d.text((40, y), "합계", font=mono_b, fill=(20, 20, 20))
    d.text((720, y), "오늘 한 끼 해결 ✓", font=mono_b, fill=RED, anchor="ra")
    y += 130
    for i in range(0, 680, 12):  # 바코드 느낌
        w = 3 if (i // 12) % 3 else 6
        d.rectangle([40 + i, y, 40 + i + w, y + 110], fill=(20, 20, 20))
    # Pretendard에 이모지 글리프가 없어 글자만 쓴다
    d.text((380, y + 160), f"@{ig_handle()}  ·  감사합니다", font=_font(FONT_M, 28), fill=(90, 90, 90), anchor="mm")
    # 아래 톱니
    for x in range(0, 760, 40):
        d.polygon([(x, 1150), (x + 20, 1130), (x + 40, 1150)], fill=(34, 22, 18))
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rectangle([170, 125, 930, 1275], fill=(0, 0, 0, 120))
    bg.paste(shadow.filter(ImageFilter.GaussianBlur(18)), (0, 0), shadow.filter(ImageFilter.GaussianBlur(18)))
    bg.paste(paper.rotate(-2, expand=False, fillcolor=(34, 22, 18)), (160, 100))
    bg.save(path, quality=92)
