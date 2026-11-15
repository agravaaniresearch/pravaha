import sys, time, os, threading, http.server, socketserver
sys.path.insert(0, os.path.dirname(__file__))
from ff import Browser, build_ext
from selenium.webdriver.common.by import By
PAGE = b'<!doctype html><html><head><title>b</title><link rel="alternate" type="application/rss+xml" title="Posts" href="/feed.xml"></head><body>x</body></html>'
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(PAGE))); self.end_headers(); self.wfile.write(PAGE)
    def log_message(self, *a): pass
srv = socketserver.TCPServer(("127.0.0.1", 8802), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
ext = build_ext("/tmp/pv-ext"); A = Browser("A", ext, prefs={"extensions.webextOptionalPermissionPrompts": False})
try:
    A.open(); A.js("[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('Settings')).click();"); time.sleep(0.6); A.js("[...document.querySelectorAll('.stab')].find(b => b.textContent.includes('This machine')).click();"); time.sleep(1.5)
    A.js("document.querySelector(\"[data-act='detect-feeds']\").scrollIntoView({block:'center'})"); A.d.find_element(By.CSS_SELECTOR, "[data-act='detect-feeds']").click(); time.sleep(0.7); A.d.find_element(By.CSS_SELECTOR, "[data-act='confirm']").click(); time.sleep(2)
    print(A.text("[data-note='detect']"))
    A.d.switch_to.new_window("tab"); A.d.get("http://127.0.0.1:8802/"); time.sleep(3)
    A.d.switch_to.new_window("tab"); A.open(); time.sleep(1)
    print(A.call("try { const ts = await browser.tabs.query({}); const t = ts.find(x => (x.url||'').includes('8802')); const out = {url: t && t.url}; out.feeds = await browser.runtime.sendMessage({type:'feedsFor', tabId: t.id}); out.badge = await browser.action.getBadgeText({tabId: t.id}); out.title = await browser.action.getTitle({tabId: t.id}); out.popup = await browser.action.getPopup({tabId: t.id}); return out; } catch (e) { return {err: String(e.message)}; }"))
finally: A.quit()
