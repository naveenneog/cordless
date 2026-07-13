#!/usr/bin/env python3
# Render the cordless install flow as terminal screenshots + an animated GIF.
#   python make_install_demo.py <cordless_once.txt> <out_dir>
# Produces: out_dir/install-setup.png, install-qr.png, install.gif
import sys, os
from PIL import Image, ImageDraw, ImageFont

ONCE = sys.argv[1]
OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)

# ---- theme (matches the cordless site) ----
BG = (11, 14, 20)          # #0b0e14
PANEL = (17, 21, 31)
FG = (199, 208, 224)       # #c7d0e0
DIM = (123, 134, 156)      # #7b869c
PROMPT = (122, 162, 247)   # #7aa2f7
CMD = (230, 233, 239)
GREEN = (158, 206, 106)    # #9ece6a
VIOLET = (177, 140, 255)   # #bb9af7
CYAN = (125, 207, 255)
YELLOW = (224, 175, 104)

FONT_PATH = r"C:\Windows\Fonts\CascadiaMono.ttf"
SIZE = 20
font = ImageFont.truetype(FONT_PATH, SIZE)
# monospace cell metrics
CW = int(round(font.getlength("M")))
CH = SIZE + 8
PAD = 24
COLS = 84
TITLEBAR = 40

def color_for(line):
    s = line.rstrip("\n")
    t = s.strip()
    if t.startswith(">_<"):
        return VIOLET
    if "installed and running" in t:
        return GREEN
    if t.startswith("removed old install") or t.startswith("copied binary") or t.startswith("added to PATH") or t.startswith("started the cordless"):
        return DIM
    if t.startswith("Registered scheduled task") or t.startswith("start now") or t.startswith("logs"):
        return DIM
    if t.startswith("Installing cordless"):
        return FG
    if t.startswith("Daemon"):
        return FG
    if t.startswith("Reach"):
        return CYAN
    if t.startswith("── Pair a phone"):
        return DIM
    if t.startswith("(that opens") or t.startswith("scan"):
        return DIM
    if "▄" in s or "█" in s or "▀" in s:
        return FG
    return FG

def render(lines, cursor=None, rows=30):
    # keep the last `rows` lines (scroll)
    disp = list(lines)
    if cursor is not None:
        disp = disp + [cursor]
    disp = disp[-rows:]
    W = PAD * 2 + CW * COLS
    H = TITLEBAR + PAD * 2 + CH * rows
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # title bar
    d.rectangle([0, 0, W, TITLEBAR], fill=PANEL)
    for i, c in enumerate([(0xf7,0x76,0x8e),(0xe0,0xaf,0x68),(0x9e,0xce,0x6a)]):
        d.ellipse([PAD + i*22, TITLEBAR//2-6, PAD + i*22+12, TITLEBAR//2+6], fill=c)
    d.text((W//2 - 90, TITLEBAR//2 - SIZE//2), "cordless — install", font=font, fill=DIM)
    y = TITLEBAR + PAD
    for (text, col) in disp:
        d.text((PAD, y), text, font=font, fill=col)
        y += CH
    return img

# ---- build the terminal "script" ----
PROMPT_STR = "PS C:\\Users\\navg> "

setup_out = [
    "Installing cordless 0.8.2 -> C:\\Users\\navg\\AppData\\Local\\Programs\\cordless",
    "  removed old install: C:\\Users\\navg\\...\\cordless-old",
    "  copied binary + resources",
    "  added to PATH: C:\\Users\\navg\\AppData\\Local\\Programs\\cordless",
    "Registered scheduled task 'cordless' (starts hidden at logon).",
    "  started the cordless daemon (pid 12840)",
    "",
    "cordless 0.8.2 is installed and running. Open a NEW terminal and run:  cordless",
    "(that opens the dashboard with a QR to pair your phone.)",
]

with open(ONCE, encoding="utf-8") as f:
    once_lines = [ln.rstrip("\n") for ln in f]
# trim trailing blanks
while once_lines and not once_lines[-1].strip():
    once_lines.pop()

# a line is (text, color)
term = []
frames = []   # (image, duration_ms)

def push_frame(cursor=None, dur=90, rows=30):
    frames.append((render(term, cursor, rows), dur))

def type_command(cmd):
    for i in range(0, len(cmd)+1, 2):
        cur = (PROMPT_STR + cmd[:i] + "\u2588", CMD)
        frames.append((render(term, cur, 30), 55))
    # commit
    term.append((PROMPT_STR + cmd, CMD))
    push_frame(dur=250)

def reveal(lines, dur=110, batch=1):
    buf = []
    i = 0
    while i < len(lines):
        for _ in range(batch):
            if i < len(lines):
                ln = lines[i]
                term.append((ln, color_for(ln)))
                i += 1
        push_frame(dur=dur)

# render() expects cursor as (text,color) OR text; normalize
_orig_render = render
def render(lines, cursor=None, rows=30):
    cur = None
    if cursor is not None:
        cur = cursor if isinstance(cursor, tuple) else (cursor, CMD)
    return _orig_render(lines, cur, rows)

# Step 1 — cordless setup
term.append(("# 1. install (one command: to PATH + autostart + starts the daemon)", DIM))
push_frame(dur=500)
type_command("cordless setup")
reveal(setup_out, dur=140)
push_frame(dur=1500)

# still: setup done
img_setup = render(term, rows=len(term)+1)
img_setup.save(os.path.join(OUT, "install-setup.png"))

# Step 2 — cordless (QR)
term.append(("", None))
term.append(("# 2. open the dashboard — scan the QR with the phone app", DIM))
push_frame(dur=700)
type_command("cordless")
reveal(once_lines, dur=70, batch=3)
push_frame(dur=2600)

# still: QR
img_qr = _orig_render([(l, color_for(l)) for l in once_lines], None, rows=len(once_lines)+1)
img_qr.save(os.path.join(OUT, "install-qr.png"))

# ---- write GIF ----
imgs = [f[0] for f in frames]
durs = [f[1] for f in frames]
# unify canvas size to the largest frame
W = max(im.width for im in imgs); H = max(im.height for im in imgs)
canvas = []
for im in imgs:
    if im.size != (W, H):
        c = Image.new("RGB", (W, H), BG); c.paste(im, (0, 0)); canvas.append(c)
    else:
        canvas.append(im)
canvas[0].save(os.path.join(OUT, "install.gif"), save_all=True, append_images=canvas[1:],
               duration=durs, loop=0, optimize=True)
print("frames:", len(canvas), "size:", W, "x", H)
print("wrote install-setup.png, install-qr.png, install.gif to", OUT)
