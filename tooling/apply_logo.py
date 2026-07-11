"""Apply the cordless logo across web (PWA/favicon) + Android (launcher/adaptive/splash).
Sources: tooling/logo/icon.png (framed >_<), tooling/logo/mark.png (frameless >_< on dark).
Pure Pillow.
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
ICON = os.path.join(HERE, "logo", "icon.png")
MARK = os.path.join(HERE, "logo", "mark.png")
CLIENT_PUB = os.path.join(ROOT, "client", "public")
DOCS = os.path.join(ROOT, "docs")
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
DARK = (11, 14, 20)  # #0b0e14

def load(p):
    return Image.open(p).convert("RGBA")

def rs(img, size):
    return img.resize((size, size), Image.LANCZOS)

def circle_crop(img):
    n = img.size[0]
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, n - 1, n - 1), fill=255)
    out = img.copy()
    out.putalpha(mask)
    return out

def luminance_key(img):
    """Dark background -> transparent, bright glyph -> opaque (keeps gradient + soft glow)."""
    gray = img.convert("L")
    alpha = gray.point(lambda p: max(0, min(255, int((p - 18) * 2.0))))
    out = img.convert("RGBA")
    out.putalpha(alpha)
    return out

icon = load(ICON)
mark_t = luminance_key(load(MARK))

# ---------- Web (client/public) ----------
os.makedirs(CLIENT_PUB, exist_ok=True)
rs(icon, 512).save(os.path.join(CLIENT_PUB, "icon-512.png"))
rs(icon, 192).save(os.path.join(CLIENT_PUB, "icon-192.png"))
rs(icon, 180).save(os.path.join(CLIENT_PUB, "apple-touch-icon.png"))
rs(icon, 32).save(os.path.join(CLIENT_PUB, "favicon-32.png"))
rs(icon, 16).save(os.path.join(CLIENT_PUB, "favicon-16.png"))
# maskable: framed icon inset on dark so the frame is inside the 80% safe zone
mask = Image.new("RGBA", (512, 512), DARK + (255,))
inner = int(512 * 0.76)
mask.paste(rs(icon, inner), ((512 - inner) // 2, (512 - inner) // 2))
mask.convert("RGB").save(os.path.join(CLIENT_PUB, "icon-maskable-512.png"))
print("web icons written")

# ---------- Docs favicon ----------
rs(icon, 256).save(os.path.join(DOCS, "icon.png"))
print("docs icon written")

# ---------- Android legacy launcher + round ----------
legacy = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
for d, sz in legacy.items():
    folder = os.path.join(RES, f"mipmap-{d}")
    os.makedirs(folder, exist_ok=True)
    rs(icon, sz).save(os.path.join(folder, "ic_launcher.png"))
    circle_crop(rs(icon, sz)).save(os.path.join(folder, "ic_launcher_round.png"))
print("android legacy icons written")

# ---------- Android adaptive foreground (transparent >_< centered in safe zone) ----------
fg = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
for d, sz in fg.items():
    canvas = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
    inner = int(sz * 0.64)
    canvas.paste(rs(mark_t, inner), ((sz - inner) // 2, (sz - inner) // 2), rs(mark_t, inner))
    canvas.save(os.path.join(RES, f"mipmap-{d}", "ic_launcher_foreground.png"))
print("android adaptive foreground written")

# ---------- Splash (mark centered on dark, keep each file's dimensions) ----------
import glob
for sp in glob.glob(os.path.join(RES, "drawable*", "splash.png")):
    w, h = Image.open(sp).size
    canvas = Image.new("RGB", (w, h), DARK)
    side = int(min(w, h) * 0.34)
    m = luminance_key(load(MARK)).resize((side, side), Image.LANCZOS)
    canvas.paste(m, ((w - side) // 2, (h - side) // 2), m)
    canvas.save(sp)
print("splash images written")
print("DONE")
