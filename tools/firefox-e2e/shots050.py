"""0.5.0 screenshots of the new Settings and Sync pages in real Firefox. Synthetic data only."""
import sys, time, os
sys.path.insert(0, os.path.dirname(__file__))
from ff import Browser, build_ext
MF = {"url": "http://127.0.0.1:8799/mf", "token": "good-key"}; DAV = {"url": "http://127.0.0.1:8799/dav", "user": "u", "pass": "p", "root": "pravaha"}
W, H = int(os.environ.get("W", "2370")), int(os.environ.get("H", "1030")); OUT = os.environ.get("OUT", "/tmp/e2e/s050")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
ext = build_ext("/tmp/pv-ext"); A = Browser("A", ext, width=W, height=H)
clickTab = "[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('%s')).click();"
clickSub = "[...document.querySelectorAll('.stab')].find(b => b.textContent.includes('%s')).click();"
try:
    A.open(); A.send({"type": "saveSettings", "patch": {"device": "laptop", "miniflux": MF, "webdav": DAV}}); A.send({"type": "syncNow"}); time.sleep(1)
    A.open(); time.sleep(1.2); A.shot(f"{OUT}-newsfeed-{W}.png")
    A.js(clickTab % "Sync"); time.sleep(1.2); A.shot(f"{OUT}-sync-overview-{W}.png")
    A.js(clickSub % "Firefox Sync"); time.sleep(0.9); A.shot(f"{OUT}-sync-firefox-{W}.png")
    A.js(clickSub % "Machines"); time.sleep(0.9); A.shot(f"{OUT}-sync-machines-{W}.png")
    A.js(clickTab % "Settings"); time.sleep(1.2); A.shot(f"{OUT}-settings-connections-{W}.png")
    for name in ("Look and reading", "Move setup", "This machine"):
        A.js(clickSub % name); time.sleep(0.9); A.shot(f"{OUT}-settings-{name.split()[0].lower()}-{W}.png")
finally:
    A.quit()
