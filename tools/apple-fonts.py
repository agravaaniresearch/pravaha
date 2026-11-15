#!/usr/bin/env python3
"""Build SF Pro and New York for Pravaha from the community SFWindows collection.

These are Apple's fonts. They are NOT part of this repository and must not be
committed or redistributed (see docs/POLICY.md). This script turns them into
small Latin woff2 files in extension/ui/fonts/apple/, which is git-ignored,
so they travel only inside an extension you build for yourself.

    python3 tools/apple-fonts.py                  # clones SFWindows, then builds
    python3 tools/apple-fonts.py /path/to/SFWindows   # use an existing clone

Needs: git, python3, fonttools and brotli  (pip install fonttools brotli).
"""
import os, subprocess, sys, tempfile

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

REPO = "https://github.com/bradleyhodges/SFWindows.git"
OUT = os.path.join(os.path.dirname(__file__), "..", "extension", "ui", "fonts", "apple")

# Basic Latin, Latin-1, Latin Extended-A, general punctuation, currency (incl. the rupee), arrows used in the UI.
UNICODES = list(range(0x20, 0x7F)) + list(range(0xA0, 0x180)) + list(range(0x2010, 0x2030)) + [0x2039, 0x203A, 0x2044, 0x20AC, 0x20B9, 0x2122, 0x2190, 0x2191, 0x2192, 0x2193, 0x2212, 0x2022, 0x25CF, 0xFB01, 0xFB02]
FEATURES = ["kern", "liga", "calt", "ccmp", "locl", "mark", "mkmk", "tnum", "pnum", "lnum", "onum", "case", "frac", "sups"]

# (source file in SFWindows, output name, axis limits)
JOBS = [
    ("SF Pro/SF-Pro.ttf", "sf-pro-latin-wght-normal.woff2", {"wdth": 100, "wght": (300, 800)}),
    ("SF Pro/SF-Pro-Italic.ttf", "sf-pro-latin-wght-italic.woff2", {"wdth": 100, "wght": (300, 800), "YAXS": 400}),
    ("New York/NewYork.ttf", "new-york-latin-wght-normal.woff2", {"wght": (400, 900), "opsz": (12, 72)}),
    ("New York/NewYorkItalic.ttf", "new-york-latin-wght-italic.woff2", {"wght": (400, 900), "opsz": (12, 72)}),
]


def build(src, dst, limits):
    font = TTFont(src)
    present = {a.axisTag for a in font["fvar"].axes}
    font = instancer.instantiateVariableFont(font, {k: v for k, v in limits.items() if k in present}, inplace=False)
    opts = subset.Options()
    opts.flavor = "woff2"; opts.layout_features = FEATURES; opts.name_IDs = [1, 2, 3, 4, 6]
    opts.notdef_outline = True; opts.hinting = False; opts.desubroutinize = True
    # The source gvar tables miss a few glyphs; a save and reload with lazy loading off makes subsetting tolerant of that.
    import io
    buf = io.BytesIO(); font.save(buf); buf.seek(0)
    font = TTFont(buf, lazy=False)
    if "gvar" in font:
        gv = font["gvar"]; names = set(font.getGlyphOrder())
        for g in names:
            gv.variations.setdefault(g, [])
    sub = subset.Subsetter(opts); sub.populate(unicodes=UNICODES); sub.subset(font)
    font.flavor = "woff2"; font.save(dst)
    print(f"  {os.path.basename(dst)}  {os.path.getsize(dst) // 1024} KB")


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else None
    tmp = None
    if root is None:
        tmp = tempfile.mkdtemp(prefix="sfwindows-")
        print("Cloning", REPO)
        subprocess.run(["git", "clone", "--depth", "1", "-q", REPO, tmp], check=True)
        root = tmp
    os.makedirs(OUT, exist_ok=True)
    print("Building into", os.path.normpath(OUT))
    for src, name, limits in JOBS:
        path = os.path.join(root, src)
        if not os.path.exists(path):
            sys.exit(f"Missing {src} in {root}")
        build(path, os.path.join(OUT, name), limits)
    print("Done. These files are git-ignored. Do not publish them.")


if __name__ == "__main__":
    main()
