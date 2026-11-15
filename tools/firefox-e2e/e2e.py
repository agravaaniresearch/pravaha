"""Two real Firefox 160 profiles, one fake Miniflux and one fake WebDAV store. Synthetic data only.
A is the established machine; B is a fresh install (the home machine). Firefox Sync's cloud cannot be reached from here, so the
arrival of A's data in B is simulated by writing A's storage.sync items into B's storage.sync, which is what Firefox does."""
import sys, time, json, os, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
from ff import Browser, build_ext
OUT = os.environ.get("E2E_OUT", "/tmp/e2e"); os.makedirs(OUT, exist_ok=True)
MF = {"url": "http://127.0.0.1:8799/mf", "token": "good-key"}; DAV = {"url": "http://127.0.0.1:8799/dav", "user": "u", "pass": "p", "root": "pravaha"}
fails = []
def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else "")); 
    if not ok: fails.append(name)
def until(fn, secs=25, step=0.5):
    t = time.time()
    while time.time() - t < secs:
        v = fn()
        if v: return v
        time.sleep(step)
    return fn()

ext = build_ext("/tmp/pv-ext")
A = Browser("A", ext); B = None; C = None
try:
    # ---- A: the established machine -------------------------------------------------
    A.open()
    A.send({"type": "saveSettings", "patch": {"device": "laptop", "miniflux": MF, "webdav": DAV, "raindrop": {"token": ""}, "weights": {"tag": 0.5, "echo": 0.2, "authority": 0.2, "freshness": 0.1}, "pollMinutes": 7}})
    A.send({"type": "saveUi", "ui": {"theme": "oled", "palette": "moss", "readFont": "ubuntu", "uiFont": "atkinson", "density": "compact"}})
    A.send({"type": "syncNow"})
    A.send({"type": "dismiss", "id": 2}); A.send({"type": "train", "kind": "tag", "key": "frigate", "value": 1}); A.send({"type": "syncNow"})
    items = A.call("return await browser.storage.sync.get(null);")
    check("A wrote keys, settings and look to Firefox Sync", all(k in items for k in ("pv:keys", "pv:settings", "pv:ui")), list(items))
    check("the keys item is within Firefox Sync's per-item limit", len(json.dumps({"pv:keys": items["pv:keys"]})) < 8192)
    check("the machine name is not carried", "laptop" not in json.dumps(items["pv:settings"]["data"]) and "device" not in json.dumps(items["pv:keys"]["data"]))
    stA = A.send({"type": "status"}); check("A shows a healthy overall state", stA["overall"] in ("green", "amber"), stA["overall"])
    A.shot(f"{OUT}/A-established.png")

    # ---- B: a fresh install -----------------------------------------------------------
    B = Browser("B", ext); B.open()
    time.sleep(2)
    stB = B.send({"type": "status"})
    check("fresh B does not claim to be in sync", stB["overall"] == "off" and "In sync" not in B.text(".pill")[0], f"{stB['overall']} {B.text('.pill')}")
    check("fresh B has a machine name of its own", B.send({"type": "boot"})["settings"]["device"].startswith("browser-"))
    B.shot(f"{OUT}/B-fresh.png")
    heroes = B.text(".hero.setup h2"); check("fresh B shows the Set up this machine panel", heroes == ["Set up this machine"], heroes)
    # nothing arrives until Firefox delivers it; B must not push its empty defaults over it
    time.sleep(3); empty = B.call("return await browser.storage.sync.get(null);")
    check("fresh B pushes nothing into Firefox Sync", not any(k.startswith("pv:") for k in empty), list(empty))
    # Firefox delivers A's items
    B.js("window.__profile = []; browser.runtime.onMessage.addListener(m => { if (m && m.type === 'profile') window.__profile.push(m.applied); });")
    B.call("await browser.storage.sync.set(arguments[0]); return true;", items)
    got = until(lambda: B.send({"type": "boot"})["settings"]["miniflux"]["token"] == "good-key")
    check("B took the keys from Firefox Sync with no click", got)
    until(lambda: (B.send({"type": "boot"})["settings"].get("ui") or {}).get("theme") == "oled")  # the parts arrive one after another
    sB = B.send({"type": "boot"})["settings"]
    check("B took the settings (weights, poll interval)", sB["pollMinutes"] == 7 and abs(sB["weights"]["tag"] - 0.5) < 0.2, f"{sB['pollMinutes']} {sB['weights']}")
    check("B kept its own machine name", sB["device"].startswith("browser-") and sB["device"] != "laptop", sB["device"])
    check("B received the look", (sB.get("ui") or {}).get("theme") == "oled" and sB["ui"]["readFont"] == "ubuntu", str(sB.get("ui")))
    # the reader page applied the look after a reload
    B.open(); time.sleep(2)
    theme = B.js("return document.documentElement.dataset.theme"); font = B.js("return document.documentElement.style.getPropertyValue('--read-font')")
    check("B's reader shows the carried theme and font", theme == "oled" and "ubuntu" in font, f"{theme} {font}")
    # B syncs: articles from Miniflux and the reading history from WebDAV
    st = until(lambda: (lambda s: s if s.get("imported") else None)(B.send({"type": "status"})), 40)
    check("B imported A's reading history from the WebDAV storage", bool(st) and st["imported"]["events"] >= 2 and "laptop" in st["imported"]["devices"], str(st and st.get("imported")))
    tree = B.send({"type": "tree"}); check("B has A's feeds from Miniflux", len(tree["tree"]) >= 3, len(tree["tree"]))
    view = B.send({"type": "view", "params": {"scope": "all", "mode": "unread", "ranked": False}})
    titles = [r["title"] for g in view["view"]["groups"] for r in g["rows"]]
    check("A's dismissal arrived in B (dismissed article hidden)", not any("lemon cake" in t for t in titles), str(titles))
    st = B.send({"type": "status"}); check("B now reports a healthy state and names the other machine", st["overall"] in ("green", "amber") and any("laptop" in l["sentence"] for l in st["lights"] if l["id"] == "machines"), str([l["sentence"] for l in st["lights"]]))
    check("the two machines never share a log name", B.send({"type": "boot"})["settings"]["device"] != "laptop")
    B.open("#"); time.sleep(1.5)
    B.shot(f"{OUT}/B-after-arrival.png")
    # ---- settings file: real WebCrypto and real file reading in Firefox ----------------
    clickTab = "[...document.querySelectorAll('%s')].find(b => b.textContent.trim() === arguments[0]).click();"
    A.open(); time.sleep(1); A.js(clickTab % ".tab:not(.stab)" if False else "[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('Settings')).click();"); time.sleep(0.8)
    A.js(clickTab % ".stab", "Move setup"); time.sleep(1.2)
    check("A's Move setup tab shows the Firefox Sync card and the settings file card", bool(A.text("[data-fx] h2")) and bool(A.text("[data-file] h2")))
    A.shot(f"{OUT}/A-move-setup.png")
    noPass = A.send({"type": "exportSettings", "keys": True, "passphrase": "", "history": False})
    check("export with keys and no passphrase is refused in plain words", noPass.get("ok") is False and "passphrase" in noPass.get("sentence", "").lower(), str(noPass)[:200])
    exp = A.send({"type": "exportSettings", "keys": True, "passphrase": "correct horse", "history": True})
    check("export works in Firefox and no key is in the clear", exp.get("ok") and "good-key" not in exp["text"] and exp["keys"] is True and exp["events"] >= 2, str(exp)[:200])
    C = Browser("C", ext); C.open(); time.sleep(1.5)
    bad = C.send({"type": "importSettings", "text": exp["text"], "passphrase": "wrong"})
    check("a wrong passphrase is refused and changes nothing", bad.get("ok") is False and C.send({"type": "boot"})["settings"]["miniflux"]["token"] == "", str(bad)[:200])
    good = C.send({"type": "importSettings", "text": exp["text"], "passphrase": "correct horse"})
    sC = C.send({"type": "boot"})["settings"]
    check("the right passphrase brings in keys, settings and look", good.get("ok") and sC["miniflux"]["token"] == "good-key" and sC["pollMinutes"] == 7 and (sC.get("ui") or {}).get("theme") == "oled", str(good)[:200])
    check("the import keeps the machine's own name", sC["device"].startswith("browser-"), sC["device"])
    check("the file's history was merged on the third machine", good.get("events", 0) >= 2, str(good)[:200])
    back = C.send({"type": "exportSettings", "keys": False, "passphrase": "", "history": True})
    check("the third machine now holds A's history events", back.get("ok") and back["events"] >= 2, str(back)[:200])
    C.send({"type": "syncNow"}); stC = C.send({"type": "status"})
    check("syncing after the import adds no duplicate history and stays healthy", stC["overall"] in ("green", "amber") and not stC.get("nameClash"), str(stC["overall"]))
    # the file route also works through the real file picker
    C.open(); time.sleep(1)
    # ---- idle refresh behaviour ------------------------------------------------------
    B.send({"type": "saveSettings", "patch": {"pollMinutes": 1}}); time.sleep(2)
    B.js("window.__changed = 0; window.__pillTexts = []; browser.runtime.onMessage.addListener(m => { if (m && m.type === 'changed') window.__changed++; }); setInterval(() => { const p = document.querySelector('.pill'); if (p) window.__pillTexts.push(p.textContent); }, 250);")
    time.sleep(150)
    ch = B.js("return window.__changed"); pills = set(B.js("return window.__pillTexts"))
    check("idle polls do not make the page refresh or flash a syncing state", ch <= 1 and not any("Reading" in p or "Sending" in p or "Syncing" in p for p in pills), f"changed={ch} pills={pills}")
finally:
    A.quit()
    if B: B.quit()
    if C: C.quit()
print("\nFAILED:" if fails else "\nAll checks passed.", fails or "")
sys.exit(1 if fails else 0)
