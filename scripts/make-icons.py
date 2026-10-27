"""Draws ZYVEN's Android launcher icons and splash images from the app's logo.

The logo is the one in src/app.html (const LOGO): a rounded square in the
default accent colour (white) with four black sound-wave bars, viewBox 32x32.
Output goes to resources/android/res and is already committed, so you only
need this if you change the logo.  Usage:  python3 scripts/make-icons.py
Requires Pillow (pip install pillow).
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "resources" / "android" / "res"
WHITE, BLACK = (255, 255, 255, 255), (0, 0, 0, 255)
SS = 4  # supersampling for smooth edges

# Logo geometry in the 32x32 viewBox, copied from src/app.html.
BARS = [(10, 14, 18), (14, 10, 22), (18, 12.5, 19.5), (22, 14.5, 17.5)]  # x, y1, y2
STROKE, RADIUS = 2.6, 10


def logo(size):
    """The logo as an RGBA image, size x size pixels, transparent outside."""
    big = size * SS
    k = big / 32
    im = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=RADIUS * k, fill=WHITE)
    w = STROKE * k
    for x, y1, y2 in BARS:  # round-capped lines
        d.rounded_rectangle([(x * k) - w / 2, (y1 * k) - w / 2, (x * k) + w / 2, (y2 * k) + w / 2], radius=w / 2, fill=BLACK)
    return im.resize((size, size), Image.LANCZOS)


def canvas(w, h, bg=(0, 0, 0, 0)):
    return Image.new("RGBA", (w, h), bg)


def paste_center(base, img):
    base.alpha_composite(img, ((base.width - img.width) // 2, (base.height - img.height) // 2))
    return base


def save(img, rel):
    p = RES / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    img.save(p, optimize=True)


DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}

for name, s in DENS.items():
    # Legacy icon (Android 7 and older): the logo itself, 48dp with a small margin.
    px = round(48 * s)
    save(paste_center(canvas(px, px), logo(round(44 * s))), f"mipmap-{name}/ic_launcher.png")
    # Legacy round icon: logo on a black circle.
    big = px * SS
    c = canvas(big, big)
    ImageDraw.Draw(c).ellipse([0, 0, big - 1, big - 1], fill=BLACK)
    c = c.resize((px, px), Image.LANCZOS)
    save(paste_center(c, logo(round(30 * s))), f"mipmap-{name}/ic_launcher_round.png")
    # Adaptive foreground (Android 8+): 108dp canvas, logo inside the 66dp safe zone.
    fx = round(108 * s)
    save(paste_center(canvas(fx, fx), logo(round(54 * s))), f"mipmap-{name}/ic_launcher_foreground.png")

# Splash images: black with the logo centred (portrait and landscape).
SPLASH = {"mdpi": (320, 480), "hdpi": (480, 800), "xhdpi": (720, 1280), "xxhdpi": (960, 1600), "xxxhdpi": (1280, 1920)}
for name, (w, h) in SPLASH.items():
    mark = logo(round(min(w, h) * 0.22))
    save(paste_center(canvas(w, h, BLACK), mark), f"drawable-port-{name}/splash.png")
    save(paste_center(canvas(h, w, BLACK), mark), f"drawable-land-{name}/splash.png")
save(paste_center(canvas(480, 320, BLACK), logo(80)), "drawable/splash.png")

# Adaptive icon definitions and the black icon background.
adaptive = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
"""
for f in ("ic_launcher.xml", "ic_launcher_round.xml"):
    p = RES / "mipmap-anydpi-v26" / f
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(adaptive)
(RES / "values").mkdir(parents=True, exist_ok=True)
(RES / "values" / "ic_launcher_background.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#000000</color>\n</resources>\n')

# Full-size copies for app stores or reuse.
logo(1024).save(ROOT / "resources" / "icon-1024.png", optimize=True)
(ROOT / "resources" / "logo.svg").write_text(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 32 32">\n'
    '  <rect width="32" height="32" rx="10" fill="#FFFFFF"/>\n'
    '  <g stroke="#000000" stroke-width="2.6" stroke-linecap="round">\n'
    '    <path d="M10 14v4"/><path d="M14 10v12"/><path d="M18 12.5v7"/><path d="M22 14.5v3"/>\n'
    '  </g>\n</svg>\n')
print("make-icons: wrote", sum(1 for _ in RES.rglob("*") if _.is_file()), "files to", RES.relative_to(ROOT))
