"""Finds what makes the page wider than the window (a horizontal scrollbar that comes and goes). Synthetic data only."""
import sys, time, json, os
sys.path.insert(0, os.path.dirname(__file__))
from ff import Browser, build_ext
MF = {"url": "http://127.0.0.1:8799/mf", "token": "good-key"}; DAV = {"url": "http://127.0.0.1:8799/dav", "user": "u", "pass": "p", "root": "pravaha"}
W, H = int(os.environ.get("W", "2370")), int(os.environ.get("H", "1030"))
ext = build_ext("/tmp/pv-ext"); A = Browser("A", ext, width=W, height=H)
SCAN = """
const vw = document.documentElement.clientWidth, out = {vw, sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, vh: document.documentElement.clientHeight, sh: document.documentElement.scrollHeight, wide: []};
for (const el of document.querySelectorAll('body *')) { const r = el.getBoundingClientRect(); if (r.width && r.right > vw + 1) out.wide.push((el.tagName + '.' + (el.className && el.className.baseVal === undefined ? el.className : '') ).slice(0, 60) + ' right=' + Math.round(r.right) + ' w=' + Math.round(r.width) + ' pos=' + getComputedStyle(el).position); }
out.wide = out.wide.slice(0, 12); return out;
"""
try:
    A.open(); A.send({"type": "saveSettings", "patch": {"device": "laptop", "miniflux": MF, "webdav": DAV}}); A.send({"type": "syncNow"})
    for name, js in (("Newsfeed", ""), ("Sync", "[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('Sync')).click();"), ("Stats", "[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('Stats')).click();"), ("Settings", "[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('Settings')).click();")):
        A.open(); time.sleep(1)
        if js: A.js(js); time.sleep(1.2)
        seen = []
        for i in range(25):
            seen.append(A.js(SCAN)); time.sleep(0.4)
        sws = sorted(set(s["sw"] for s in seen)); print(name, "viewport", seen[0]["vw"], "scrollWidth values seen:", sws, "| scrollHeight", sorted(set(s["sh"] for s in seen))[:3], "of", seen[0]["vh"])
        if max(sws) > seen[0]["vw"]: print("   wide elements:", seen[-1]["wide"])
    A.shot("/tmp/e2e/overflow-last.png")
finally:
    A.quit()
