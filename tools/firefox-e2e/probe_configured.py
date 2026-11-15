"""With Miniflux and WebDAV configured and nothing happening, how often does the page refresh and how much traffic is there?"""
import sys, time, json, os, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
from ff import Browser, build_ext
def hits(): return json.load(urllib.request.urlopen("http://127.0.0.1:8799/ctl/hits"))
urllib.request.urlopen("http://127.0.0.1:8799/ctl/reset")
b = Browser("A", build_ext("/tmp/pv-ext"))
try:
    b.open()
    b.send({"type": "saveSettings", "patch": {"device": "home", "pollMinutes": 1, "miniflux": {"url": "http://127.0.0.1:8799/mf", "token": "good-key"}, "webdav": {"url": "http://127.0.0.1:8799/dav", "user": "u", "pass": "p", "root": "pravaha"}}})
    b.open()
    b.js("window.__changed = 0; browser.runtime.onMessage.addListener(m => { if (m && m.type === 'changed') window.__changed++; }); window.__mut = 0; new MutationObserver(() => window.__mut++).observe(document.body, {subtree: true, childList: true});")
    time.sleep(8); b.shot("/tmp/probe-configured-1.png")
    t0 = time.time(); last = 0
    for i in range(5):
        time.sleep(30); h = hits()
        print(f"t={int(time.time()-t0)}s requests: miniflux={h['mf']} webdav={h['dav']}  changed-messages={b.js('return window.__changed')} dom-mutations={b.js('return window.__mut')} pill={b.text('.pill')}")
    print("last requests:", h["tail"][-12:])
finally:
    b.quit()
