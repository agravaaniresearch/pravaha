"""Two established machines, both active, with Firefox Sync simulated both ways. Counts what the reader redraws while idle."""
import sys, time, json, os
sys.path.insert(0, os.path.dirname(__file__))
from ff import Browser, build_ext
MF = {"url": "http://127.0.0.1:8799/mf", "token": "good-key"}; DAV = {"url": "http://127.0.0.1:8799/dav", "user": "u", "pass": "p", "root": "pravaha"}
WINDOW = int(os.environ.get("WINDOW", "100"))
ext = build_ext("/tmp/pv-ext"); A = Browser("A", ext); B = Browser("B", ext)
def mirror():
    for src, dst in ((A, B), (B, A)):
        a = src.call("return await browser.storage.sync.get(null);"); b = dst.call("return await browser.storage.sync.get(null);")
        take = {k: v for k, v in a.items() if k.startswith("pv:") and (k not in b or (b[k].get("at", 0) < v.get("at", 0)))}
        if take: dst.call("await browser.storage.sync.set(arguments[0]); return true;", take)
INSTR = """
window.__m = {toast:0, savebar:0, pill:0, banner:0, app:0, kinds:[]};
const o = new MutationObserver(ms => { for (const m of ms) { window.__m.app++;
  for (const n of m.addedNodes) { if (n.nodeType !== 1) continue;
    if (n.matches('.toast') || n.querySelector?.('.toast')) { window.__m.toast++; window.__m.kinds.push((n.textContent||'').slice(0,60)); }
    if (n.matches('.savebar') || n.querySelector?.('.savebar')) window.__m.savebar++;
    if (n.matches('.banner')) window.__m.banner++; }
  if (m.target.closest && m.target.closest('.pill')) window.__m.pill++; } });
o.observe(document.body, {subtree:true, childList:true, characterData:true, attributes:false});
"""
try:
    A.open()
    A.send({"type": "saveSettings", "patch": {"device": "laptop", "miniflux": MF, "webdav": DAV, "pollMinutes": 1}})
    A.send({"type": "saveUi", "ui": {"theme": "oled", "readFont": "ubuntu"}}); A.send({"type": "syncNow"})
    B.open(); time.sleep(1); mirror(); time.sleep(4); mirror()
    B.send({"type": "saveSettings", "patch": {"device": "home"}}); B.send({"type": "syncNow"}); A.send({"type": "syncNow"}); mirror()
    A.send({"type": "train", "kind": "tag", "key": "warm", "value": 1}); A.send({"type": "syncNow"}); B.send({"type": "syncNow"}); A.send({"type": "syncNow"}); B.send({"type": "syncNow"})  # warm up: first arrivals are announced once, outside the measured window
    print("B has keys:", B.send({"type": "boot"})["settings"]["miniflux"]["token"] == "good-key")
    for name, hash_, js in (("Newsfeed", "", ""), ("Settings, Connections", "", "[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('Settings')).click();"),
                            ("Settings, Move setup", "", "[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('Settings')).click(); setTimeout(()=>[...document.querySelectorAll('.stab')].find(b => b.textContent.trim()==='Move setup').click(),300);")):
        B.open(hash_); time.sleep(1)
        if js: B.js(js); time.sleep(1.2)
        B.js(INSTR); t0 = time.time(); n = 0
        while time.time() - t0 < WINDOW:
            time.sleep(10); n += 1; mirror()
            if n % 2 == 0: A.send({"type": "train", "kind": "tag", "key": f"k{n}", "value": 1}); A.send({"type": "syncNow"})
        m = B.js("return window.__m"); print(f"{name}: {WINDOW}s ->", json.dumps(m))
finally:
    A.quit(); B.quit()
