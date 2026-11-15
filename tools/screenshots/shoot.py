# Takes the README screenshots from the synthetic-data harness. Usage: python3 tools/screenshots/shoot.py
import json, subprocess, time, sys, os
from playwright.sync_api import sync_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.environ.get("SHOT_OUT") or os.path.join(ROOT, "docs", "screenshots")
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "--directory", ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
URL = "http://localhost:8765/tools/screenshots/harness.html"
def prefs(**kw):
    base = {"theme": "dark", "palette": "ember", "density": "comfortable", "thumbs": False, "scrollRead": False, "side": True, "readFont": "newsreader", "readSize": 19, "readLine": 1.7, "readWidth": 68, "anchor": False, "anchorLevel": 3}
    base.update(kw); return json.dumps(base)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        def page(pr, w=1360, h=860):
            ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1.5)
            ctx.add_init_script("localStorage.setItem('pravaha.ui', %s)" % json.dumps(pr))
            ctx.route("**/tools/icons/*", lambda r: r.fulfill(path=os.path.join(ROOT, "extension", "icons", r.request.url.split("/")[-1])))
            pg = ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e))); pg.goto(URL)
            pg.wait_for_selector("body[data-ready='1']", timeout=15000); pg.wait_for_timeout(900); return pg, errs
        def shot(pg, name): pg.screenshot(path=os.path.join(OUT, name + ".png")); print("saved", name)
        pg, errs = page(prefs(theme="oled")); shot(pg, "01-newsfeed-oled"); print("errors", errs)
        pg.locator(".group:nth-child(1) .gtoggle").first.click(); pg.wait_for_timeout(300); shot(pg, "02-collapsed-feed")
        pg, _ = page(prefs(theme="dark")); pg.locator(".row .rtitle").nth(1).click(); pg.wait_for_timeout(900); pg.locator(".row[data-card='true']").scroll_into_view_if_needed(); shot(pg, "03-card-dark")
        pg, _ = page(prefs(theme="light", anchor=True, readFont="literata")); pg.locator(".row .rtitle").first.click(); pg.wait_for_timeout(900); shot(pg, "04-card-anchor-bolding-light")
        pg, _ = page(prefs(theme="dark")); pg.locator(".aa").click(); pg.wait_for_timeout(300); shot(pg, "05-reading-controls")
        pg, _ = page(prefs(theme="dark")); pg.get_by_role("tab", name="Stats").click() if pg.get_by_role("tab", name="Stats").count() else pg.locator(".tab", has_text="Stats").click(); pg.wait_for_timeout(600); shot(pg, "06-stats")
        pg, _ = page(prefs(theme="dark")); pg.locator(".tab", has_text="Sync").click(); pg.wait_for_timeout(600); shot(pg, "07-sync-status")
        pg, _ = page(prefs(theme="dark")); pg.locator(".tab", has_text="Settings").click(); pg.wait_for_timeout(500)
        k = pg.locator(".conn").first.locator("input").nth(1); k.fill("wrong-key"); pg.wait_for_timeout(1500)
        pg.locator(".conn").first.locator("input").nth(1).fill("good-key"); pg.wait_for_timeout(1500); shot(pg, "08-settings-inline-test")
        pg, _ = page(prefs(theme="light"), 390, 800); shot(pg, "09-narrow-window")
        # 0.3.0
        pg, _ = page(prefs(theme="dark")); pg.locator(".search input").fill("frigate shipyrd"); pg.wait_for_timeout(900); shot(pg, "10-search")
        pg, _ = page(prefs(theme="dark")); pg.evaluate("window.__mf.st.delay = 2500"); pg.keyboard.press("Shift+M"); pg.wait_for_timeout(500); pg.locator("[data-act='confirm']").screenshot(path=os.path.join(OUT, "_tmp.png")); os.remove(os.path.join(OUT, "_tmp.png"))
        shot(pg, "11-confirm-mark-all"); pg.locator("[data-act='confirm']").click(); pg.wait_for_timeout(1300); shot(pg, "12-syncing-with-miniflux")
        pg, _ = page(prefs(theme="dark")); pg.evaluate("window.__mf.st.delay = 0"); pg.keyboard.press("Shift+A"); pg.wait_for_timeout(400); pg.locator("[data-act='confirm']").click(); pg.wait_for_timeout(2200); shot(pg, "13-toast-with-undo")
        pg, _ = page(prefs(theme="dark")); pg.locator("[data-act='reorder']").click(); pg.wait_for_timeout(300); pg.locator(".trow[data-id='cat:Food'] [data-mv='up']").click(); pg.wait_for_timeout(1300); shot(pg, "14-reorder-folders")
        pg, _ = page(prefs(theme="dark")); pg.keyboard.press("a"); pg.wait_for_timeout(300); pg.locator(".dialog .urlrow input").fill("harbourweekly.example"); pg.locator("[data-act='find']").click(); pg.wait_for_timeout(700); pg.locator(".feedopt input").first.check(); pg.wait_for_timeout(200); shot(pg, "15-add-feed")
        pg, _ = page(prefs(theme="light", anchor=True, readFont="sourceserif")); pg.locator(".row .rtitle").first.click(); pg.wait_for_timeout(900); shot(pg, "16-bionic-button-and-fonts")
        pg, _ = page(prefs(theme="dark")); pg.locator(".tab", has_text="Settings").click(); pg.wait_for_timeout(400); pg.locator(".stab", has_text="Look").click(); pg.wait_for_timeout(500); shot(pg, "17-settings-fonts-and-confirm")
        pg, _ = page(prefs(theme="dark", readFont="newyork", uiFont="system")); pg.locator(".tab", has_text="Settings").click(); pg.wait_for_timeout(400); pg.locator(".stab", has_text="Look").click(); pg.wait_for_timeout(600); pg.evaluate("[...document.querySelectorAll('.panel h2')].find(x => x.textContent === 'Fonts').scrollIntoView({block: 'start'})"); pg.wait_for_timeout(300); shot(pg, "18-font-picker")
        b.close()
finally:
    srv.terminate()
