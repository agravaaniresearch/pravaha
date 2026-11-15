"""Reproduce the home-machine symptoms in real Firefox: a fresh install with nothing configured."""
import sys, time, json, os
sys.path.insert(0, os.path.dirname(__file__))
from ff import Browser, build_ext
ext = build_ext("/tmp/pv-ext")
b = Browser("A", ext)
try:
    b.open()
    b.js("window.__changed = 0; browser.runtime.onMessage.addListener(m => { if (m && m.type === 'changed') window.__changed++; }); window.__renders = 0; new MutationObserver(() => window.__renders++).observe(document.body, {subtree: true, childList: true});")
    print("pill:", b.text(".pill"))
    print("status overall:", b.send({"type": "status"}).get("overall"))
    t0 = time.time()
    for i in range(7):
        time.sleep(30)
        print(f"t={int(time.time()-t0)}s changed={b.js('return window.__changed')} dom-mutations={b.js('return window.__renders')} pill={b.text('.pill')}")
    b.shot("/tmp/symptom-fresh.png")
finally:
    b.quit()
