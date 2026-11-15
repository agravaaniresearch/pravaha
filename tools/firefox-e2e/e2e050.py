"""0.5.0 in real Firefox: drag a folder, right-click menu, no horizontal overflow on the new pages, and feed detection with the optional permission. Synthetic data only."""
import sys, time, os, threading, http.server, socketserver
sys.path.insert(0, os.path.dirname(__file__))
from ff import Browser, build_ext
from selenium.webdriver import ActionChains
from selenium.webdriver.common.by import By
MF = {"url": "http://127.0.0.1:8799/mf", "token": "good-key"}; DAV = {"url": "http://127.0.0.1:8799/dav", "user": "u", "pass": "p", "root": "pravaha"}
OUT = "/tmp/e2e"; os.makedirs(OUT, exist_ok=True); fails = []
def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  -> {detail}")); 
    if not ok: fails.append(name)
PAGE = b'<!doctype html><html><head><title>Synthetic blog</title><link rel="alternate" type="application/rss+xml" title="Synthetic posts" href="/feed.xml"><link rel="alternate" type="application/atom+xml" title="Synthetic comments" href="/comments.atom"></head><body><h1>A synthetic page</h1></body></html>'
PLAIN = b'<!doctype html><html><head><title>No feed here</title></head><body>plain</body></html>'
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGE if self.path.startswith("/blog") else PLAIN
        self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
srv = socketserver.TCPServer(("127.0.0.1", 8801), H, bind_and_activate=False); srv.allow_reuse_address = True; srv.server_bind(); srv.server_activate(); threading.Thread(target=srv.serve_forever, daemon=True).start()
labels = "return [...document.querySelectorAll('.side .trow .lbl')].map(e => e.textContent).filter(x => x !== 'All articles');"
SCAN = "const r = document.documentElement; return [r.scrollWidth, r.clientWidth];"
ext = build_ext("/tmp/pv-ext")
for W, Hh in ((2370, 1030), (1360, 900)):
    A = Browser("A", ext, width=W, height=Hh, prefs={"extensions.webextOptionalPermissionPrompts": False})
    try:
        A.open(); A.send({"type": "saveSettings", "patch": {"device": f"laptop{W}", "miniflux": MF, "webdav": DAV}}); A.send({"type": "syncNow"}); time.sleep(1); A.open(); time.sleep(1)
        before = A.js(labels); print(W, "folders before:", before[:3])
        top = [e for e in A.d.find_elements(By.CSS_SELECTOR, ".side .trow[data-grab='true'] .tbtn")]
        check(f"{W}: top-level folders have a grab cursor", all(e.value_of_css_property("cursor") == "grab" for e in top), [e.value_of_css_property("cursor") for e in top])
        food = [e for e in top if "Food" in e.text][0]; defence = [e for e in top if "Defence" in e.text][0]
        ac = ActionChains(A.d); ac.move_to_element(food).click_and_hold().move_by_offset(0, -20).move_by_offset(0, -30).move_to_element_with_offset(defence, 20, 2).pause(0.3).perform()
        cur = A.js("return (document.querySelector('.dragshield') ? getComputedStyle(document.querySelector('.dragshield')).cursor : 'none') + '|' + document.body.classList.contains('dragging-folder') + '|' + !!document.querySelector('.dropline')")
        check(f"{W}: while dragging the cursor is a closed hand and a drop line shows", cur.startswith("grabbing|true|true"), cur)
        A.shot(f"{OUT}/drag-{W}.png"); ActionChains(A.d).release().perform(); time.sleep(1)
        after = A.js(labels); check(f"{W}: dropping Food above Defence reorders the sidebar", after[0] == "Food", after)
        ev = A.call("const r = await browser.runtime.sendMessage({type:'boot'}); return r.settings.treeOrder.root;"); check(f"{W}: the order is saved", ev and ev[0] == "cat:Food", ev)
        A.open(); time.sleep(1); check(f"{W}: and kept after a reload", A.js(labels)[0] == "Food", A.js(labels))
        # right-click
        fe = [e for e in A.d.find_elements(By.CSS_SELECTOR, ".side .trow[data-grab='true'] .tbtn") if "Defence" in e.text][0]
        ActionChains(A.d).context_click(fe).perform(); time.sleep(0.5); menu = A.d.find_elements(By.CSS_SELECTOR, ".ctxmenu")
        check(f"{W}: right-click opens the menu", len(menu) == 1); A.shot(f"{OUT}/ctx-{W}.png")
        if menu:
            A.d.find_element(By.CSS_SELECTOR, "[data-act='move-up']").click(); time.sleep(1.2); check(f"{W}: Move up from the menu works", A.js(labels)[0] in ("Defence",) , A.js(labels))
            ActionChains(A.d).context_click(A.d.find_element(By.CSS_SELECTOR, ".side .trow[data-id='all'] .tbtn")).perform(); time.sleep(0.4)
            A.d.find_element(By.CSS_SELECTOR, "[data-act='mark-read']").click(); time.sleep(0.6); dlg = A.d.find_elements(By.CSS_SELECTOR, ".dialog[aria-label='Mark as read?']")
            check(f"{W}: Mark all read on All articles asks first", len(dlg) == 1); A.shot(f"{OUT}/confirm-{W}.png")
            if dlg: A.d.find_element(By.CSS_SELECTOR, "[data-act='cancel']").click(); time.sleep(0.4)
        # overflow on the new pages
        for name, js in (("Sync", "[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('Sync')).click();"), ("Settings", "[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('Settings')).click();")):
            A.js(js); time.sleep(1)
            for sub in ([x.text.strip() for x in A.d.find_elements(By.CSS_SELECTOR, ".stab")]):
                A.js("[...document.querySelectorAll('.stab')].find(b => b.textContent.includes(arguments[0])).click();", sub); time.sleep(0.5)
                seen = set(); 
                for i in range(12): seen.add(tuple(A.js(SCAN))); time.sleep(0.25)
                check(f"{W}: no sideways scroll on {name} / {sub}", len(seen) == 1 and list(seen)[0][0] <= list(seen)[0][1], sorted(seen))
        # feed detection (once, at the normal width)
        if W == 1360:
            A.js("[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('Settings')).click();"); time.sleep(0.6); A.js("[...document.querySelectorAll('.stab')].find(b => b.textContent.includes('This machine')).click();"); time.sleep(0.6)
            sw = A.d.find_element(By.CSS_SELECTOR, "[data-act='detect-feeds']"); check("detection starts off", sw.get_attribute("aria-checked") == "false"); A.shot(f"{OUT}/detect-off.png")
            sw.click(); time.sleep(0.7); dlg = A.d.find_elements(By.CSS_SELECTOR, ".dialog[aria-label='Detect feeds on pages?']"); check("Pravaha's own explanation shows before Firefox's prompt", len(dlg) == 1); A.shot(f"{OUT}/detect-explain.png")
            if dlg:
                A.d.find_element(By.CSS_SELECTOR, "[data-act='confirm']").click(); time.sleep(2)
                on = A.d.find_element(By.CSS_SELECTOR, "[data-act='detect-feeds']").get_attribute("aria-checked"); check("after the permission is granted the switch is on", on == "true", (on, A.text("[data-note='detect']")))
                st = A.send({"type": "feedDetectState"}); check("permission held and script registered", st.get("on") is True, st); A.shot(f"{OUT}/detect-on.png")
                A.d.switch_to.new_window("tab"); A.d.get("http://127.0.0.1:8801/blog"); time.sleep(3)
                tabs = A.d.window_handles; blog = A.d.current_window_handle
                A.d.switch_to.new_window("tab"); A.open(); time.sleep(1)
                info = A.call("const t = (await browser.tabs.query({})).find(x => (x.url||'').includes('8801/blog')); const feeds = await browser.runtime.sendMessage({type:'feedsFor', tabId: t.id}); return {feeds, badge: await browser.action.getBadgeText({tabId: t.id}), title: await browser.action.getTitle({tabId: t.id}), popup: await browser.action.getPopup({tabId: t.id})};")
                check("a page with feed links gets a badge, a title and the popup", info.get("badge") == "2" and "Subscribe with Pravaha" in info.get("title", "") and info["popup"].endswith("popup.html") and len(info["feeds"]) == 2, info)
                A.d.switch_to.new_window("tab"); A.d.get("http://127.0.0.1:8801/plain"); time.sleep(2.5); A.d.switch_to.new_window("tab"); A.open(); time.sleep(0.8)
                info2 = A.call("const t = (await browser.tabs.query({})).find(x => (x.url||'').includes('8801/plain')); return {feeds: await browser.runtime.sendMessage({type:'feedsFor', tabId: t.id}), badge: await browser.action.getBadgeText({tabId: t.id})};")
                check("a page without feeds stays plain", info2.get("feeds") == [] and info2.get("badge") == "", info2)
                A.d.get(A.url.replace("reader.html", "popup.html")); time.sleep(1); A.shot(f"{OUT}/popup-empty.png")
                A.open(); time.sleep(0.8); A.js("[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('Settings')).click();"); time.sleep(0.5); A.js("[...document.querySelectorAll('.stab')].find(b => b.textContent.includes('This machine')).click();"); time.sleep(0.6)
                A.d.find_element(By.CSS_SELECTOR, "[data-act='detect-feeds']").click(); time.sleep(1.5)
                off = A.send({"type": "feedDetectState"}); check("turning it off removes the script and the permission", off.get("on") is False and off.get("granted") is False, off)
                # the subscribe link
                A.open("#subscribe=" + "http%3A%2F%2F127.0.0.1%3A8801%2Fblog"); time.sleep(1.5); check("the Add feed dialog opens from a subscribe link", len(A.d.find_elements(By.CSS_SELECTOR, ".dialog[aria-label='Add a feed']")) == 1)
    finally:
        A.quit()
print("FAILED:", fails if fails else "none"); sys.exit(1 if fails else 0)
