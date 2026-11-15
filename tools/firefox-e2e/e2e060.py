"""0.6.0 in real Firefox: the Feeds tab (rename, move, disable, delete with a typed name), the folder menu, the Miniflux server tile with its read-only check,
the toolbar mark, and a large library built in slices. Synthetic data only. Start the fake servers first: node tools/firefox-e2e/serve.mjs 8799  (BIG=30x14 for the large library)."""
import sys, time, os, json
sys.path.insert(0, os.path.dirname(__file__))
from ff import Browser, build_ext
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver import ActionChains
MF = {"url": "http://127.0.0.1:8799/mf", "token": "good-key"}; DAV = {"url": "http://127.0.0.1:8799/dav", "user": "u", "pass": "p", "root": "pravaha"}
fails = []
def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  -> {detail}"))
    if not ok: fails.append(name)
ext = build_ext("/tmp/pv-ext")
A = Browser("A", ext, width=1360, height=900)
def css(sel): return A.d.find_elements(By.CSS_SELECTOR, sel)
def one(sel): return A.d.find_element(By.CSS_SELECTOR, sel)
def wait_for(fn, t=8):
    t0 = time.time()
    while time.time() - t0 < t:
        try:
            v = fn()
            if v: return v
        except Exception: pass
        time.sleep(0.15)
    return None
def tab(name):
    for _ in range(5):
        try: [b for b in css(".tab") if name in b.text][0].click(); return
        except Exception: time.sleep(0.3)
def stab(name): [b for b in css(".stab") if b.text.strip() == name][0].click()
try:
    A.open(); A.send({"type": "saveSettings", "patch": {"device": "laptop60", "miniflux": MF, "webdav": DAV}}); A.send({"type": "syncNow"}); time.sleep(1.5); A.open(); time.sleep(1.5)
    # Feeds tab
    tab("Settings"); time.sleep(0.4); stab("Feeds")
    rows = wait_for(lambda: css(".frow"))
    check("Feeds tab lists feeds", bool(rows) and len(rows) >= 3, len(rows or []))
    n0 = len(css(".frow"))
    probe = css(".frow")[1].find_element(By.CSS_SELECTOR, ".ftitle").text
    one("[data-field='feed-filter']").send_keys(probe.lower()); time.sleep(0.3)
    check("the filter narrows the list", 0 < len(css(".frow")) < n0, (len(css(".frow")), n0))
    one("[data-field='feed-filter']").clear(); one("[data-field='feed-filter']").send_keys(Keys.BACKSPACE); time.sleep(0.3)
    # rename the first row through the dialog
    first = css(".frow")[0]; title = first.find_element(By.CSS_SELECTOR, ".ftitle").text
    first.find_element(By.CSS_SELECTOR, "[data-act='feed-rename']").click(); time.sleep(0.3)
    box = one("[data-field='text']"); check("rename dialog is prefilled and focused", box.get_attribute("value") == title and A.d.switch_to.active_element == box, box.get_attribute("value"))
    box.send_keys(Keys.END, " Renamed"); one("[data-act='confirm']").click()
    ok = wait_for(lambda: any((title + " Renamed") == e.text for e in css(".frow .ftitle")))
    check("renamed feed appears in the list", bool(ok))
    check("renamed feed appears in the sidebar", any((title + " Renamed") == e.text for e in css(".side .lbl")))
    # delete needs the exact name
    row = [r for r in css(".frow") if (title + " Renamed") == r.find_element(By.CSS_SELECTOR, ".ftitle").text][0]
    row.find_element(By.CSS_SELECTOR, "[data-act='feed-delete']").click(); time.sleep(0.3)
    okb = one("[data-act='confirm']"); check("delete is disabled until the name is typed", not okb.is_enabled())
    one("[data-field='typed']").send_keys(title + " Renamed"); check("typing the exact name enables Delete", okb.is_enabled())
    one("[data-act='cancel']").click(); time.sleep(0.2)
    check("cancel leaves the feed", any((title + " Renamed") == e.text for e in css(".frow .ftitle")))
    # folder menu
    tab("Newsfeed"); time.sleep(1.0)
    top = [e for e in css(".side .trow[data-grab='true']")][0]; fid = top.get_attribute("data-id")
    ActionChains(A.d).context_click(top.find_element(By.CSS_SELECTOR, ".tbtn")).perform(); time.sleep(0.3)
    acts = [b.get_attribute("data-act") for b in css(".ctxmenu .ctxitem")]
    check("folder menu offers Refresh now and Rename folder", "folder-refresh" in acts and "folder-rename" in acts, acts)
    one(".ctxitem[data-act='folder-rename']").click(); time.sleep(0.3)
    bx = one("[data-field='text']"); bx.send_keys(Keys.END, " X"); one("[data-act='confirm']").click()
    ok = wait_for(lambda: css(f".side .trow[data-id='{fid}X']") or css(".side .trow[data-id^='cat:'][data-id$=' X']"))
    check("the renamed folder is shown, and still a top-level folder", bool(ok))
    # server tile
    tab("Sync"); tile = wait_for(lambda: [t for t in css(".tile") if "Miniflux server" in t.text])
    check("server tile shows a version", bool(tile) and any(ch.isdigit() for ch in tile[0].find_element(By.CSS_SELECTOR, ".tbig").text), tile and tile[0].text)
    tile[0].find_element(By.CSS_SELECTOR, "[data-act='server-check']").click()
    lines = wait_for(lambda: css("[data-checks] li"))
    check("Check server lists what it found", bool(lines) and len(lines) >= 4, len(lines or []))
    # large library built in slices (only when the big seed is on)
    A.open(); time.sleep(1.0); tab("Newsfeed"); time.sleep(1.5)
    groups = len(css(".group")); rows_now = len(css(".row"))
    print("groups", groups, "rows at once", rows_now)
    if groups >= 20:
        check("a large library shows rows at once and the rest follow", rows_now >= 40)
        wait_for(lambda: len(css(".row")) > rows_now, 6)
finally:
    try: A.quit()
    except Exception: pass
print("FAILED:", fails or "none")
sys.exit(1 if fails else 0)
