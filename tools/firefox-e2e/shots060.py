"""0.6.0 screenshots for the explainer video, in real Firefox. Synthetic data only."""
import sys, time, os
sys.path.insert(0, os.path.dirname(__file__))
from ff import Browser, build_ext
from selenium.webdriver.common.by import By
from selenium.webdriver import ActionChains
MF = {"url": "http://127.0.0.1:8799/mf", "token": "good-key"}; DAV = {"url": "http://127.0.0.1:8799/dav", "user": "u", "pass": "p", "root": "pravaha"}
W, H = int(os.environ.get("W", "1480")), int(os.environ.get("H", "880")); OUT = os.environ.get("OUT", "/tmp/vid/shots"); os.makedirs(OUT, exist_ok=True)
A = Browser("A", build_ext("/tmp/pv-ext"), width=W, height=H, prefs={"layout.css.devPixelsPerPx": "2.0"})
css = lambda s: A.d.find_elements(By.CSS_SELECTOR, s)
def tab(n):
    for _ in range(5):
        try: [b for b in css(".tab") if n in b.text][0].click(); return
        except Exception: time.sleep(0.3)
def stab(n): [b for b in css(".stab") if b.text.strip() == n][0].click()
def shot(name, wait=0.9): time.sleep(wait); A.shot(f"{OUT}/{name}.png")
try:
    A.open(); A.send({"type": "saveSettings", "patch": {"device": "laptop", "miniflux": MF, "webdav": DAV}}); A.send({"type": "syncNow"}); time.sleep(1.5); A.open(); time.sleep(1.5)
    tab("Newsfeed"); shot("01-newsfeed", 1.2)
    rows = css(".row .rtitle"); rows[0].click(); shot("02-card", 1.5)
    A.d.execute_script("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); time.sleep(0.4)
    top = [e for e in css(".side .trow[data-grab='true']")][0]
    ActionChains(A.d).context_click(top.find_element(By.CSS_SELECTOR, ".tbtn")).perform(); shot("03-folder-menu", 0.5)
    A.d.execute_script("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); time.sleep(0.3)
    feed = [r for r in css(".side .trow[data-id^='feed:']")][0]
    ActionChains(A.d).context_click(feed.find_element(By.CSS_SELECTOR, ".tbtn")).perform(); shot("04-feed-menu", 0.5)
    A.d.execute_script("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); time.sleep(0.3)
    tab("Settings"); time.sleep(0.5); stab("Feeds"); shot("05-feeds-tab", 1.2)
    css(".frow [data-act='feed-rename']")[0].click(); shot("06-rename", 0.5); css("[data-act='cancel']")[0].click(); time.sleep(0.3)
    css(".frow [data-act='feed-move']")[1].click(); shot("07-move", 0.5); css("[data-act='cancel']")[0].click(); time.sleep(0.3)
    css(".frow [data-act='feed-delete']")[2].click(); time.sleep(0.4); css("[data-field='typed']")[0].send_keys("Broken"); shot("08-delete", 0.4); css("[data-act='cancel']")[0].click(); time.sleep(0.3)
    stab("Ranking"); shot("09-ranking", 0.8)
    stab("Look and reading"); shot("10-look", 0.8)
    stab("Connections"); shot("11-connections", 0.8)
    stab("Move setup"); shot("12-move", 0.8)
    stab("This machine"); shot("13-machine", 0.8)
    stab("Shortcuts"); shot("14-shortcuts", 0.8)
    tab("Sync"); shot("15-sync", 1.2)
    t = [x for x in css(".tile") if "Miniflux server" in x.text][0]; t.find_element(By.CSS_SELECTOR, "[data-act='server-check']").click(); time.sleep(1.5)
    A.d.execute_script("document.querySelector('[data-checks]').scrollIntoView({block:'center'})"); shot("16-server-check", 0.6)
finally:
    A.quit()
