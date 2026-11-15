"""0.7.0 in real Firefox: thumbs on a row, the card's training strip with Raindrop context, a clicked tag, and the font picker. Synthetic data only."""
import sys, time, os, json
sys.path.insert(0, os.path.dirname(__file__))
from ff import Browser, build_ext
from selenium.webdriver.common.by import By
from selenium.webdriver import ActionChains
MF = {"url": "http://127.0.0.1:8799/mf", "token": "good-key"}; DAV = {"url": "http://127.0.0.1:8799/dav", "user": "u", "pass": "p", "root": "pravaha"}
OUT = os.environ.get("OUT", "/tmp/s070"); os.makedirs(OUT, exist_ok=True)
A = Browser("A", build_ext("/tmp/pv-ext", with_apple=os.environ.get("WITH_APPLE") != "0"), width=1480, height=900, prefs={"layout.css.devPixelsPerPx": "1.5"})
css = lambda s: A.d.find_elements(By.CSS_SELECTOR, s)
def shot(name, wait=0.8): time.sleep(wait); A.shot(f"{OUT}/{name}.png")
fails = []
def check(name, ok, info=""):
    print(("PASS " if ok else "FAIL ") + name, info if not ok else ""); (None if ok else fails.append(name))
try:
    A.open(); A.send({"type": "saveSettings", "patch": {"device": "laptop", "miniflux": MF, "webdav": DAV, "raindrop": {"token": "rd-token"}}}); A.send({"type": "syncNow"}); time.sleep(2.5); A.open(); time.sleep(1.5)
    rows = css(".row"); check("rows present", len(rows) > 0)
    row = rows[0]; ActionChains(A.d).move_to_element(row.find_element(By.CSS_SELECTOR, ".rtitle")).perform(); shot("01-row-thumbs", 0.5)
    ths = row.find_elements(By.CSS_SELECTOR, ".acts .rate"); check("two thumbs on the row", len(ths) == 2, str(len(ths)))
    s0 = row.find_element(By.CSS_SELECTOR, ".score").text; ths[0].click(); time.sleep(0.8)
    check("row marked up", row.get_attribute("data-rating") == "1", row.get_attribute("data-rating")); shot("02-thumb-up", 0.4)
    row.find_element(By.CSS_SELECTOR, ".rtitle").click(); time.sleep(1.2)
    chips = row.find_elements(By.CSS_SELECTOR, ".tstrip .tchip"); check("tag and word chips on the card", len(chips) >= 3, str(len(chips)))
    lines = [x.text for x in row.find_elements(By.CSS_SELECTOR, ".tstrip .rdline")]; check("Raindrop exact copy shown", any("You saved this page in Raindrop" in x for x in lines), str(lines))
    check("Raindrop note and tags shown", any("read before the budget talk" in x and "#defence" in x for x in lines), str(lines))
    A.js("arguments[0].scrollIntoView({block:'center'})", row.find_element(By.CSS_SELECTOR, ".tstrip")); shot("03-card-strip", 0.6)
    chip = lambda k: [c for c in row.find_elements(By.CSS_SELECTOR, ".tstrip .tchip") if c.get_attribute("data-key") == k][0]
    A.js("arguments[0].scrollIntoView({block:'center'})", chip("to-read")); time.sleep(0.4); chip("to-read").click(); time.sleep(0.7)
    now = chip("to-read")
    check("the thumb had made it a more, so one click makes it a less", now.get_attribute("data-v") == "-1", now.get_attribute("data-v")); shot("04-tag-less", 0.4)
    rules = A.send({"type": "rules"}); check("rule recorded in the engine", any(r["type"] == "tag" and r["key"] == "to-read" and r["value"] == -1 for r in rules), str(rules)[:200])
    A.d.execute_script("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); time.sleep(0.4)
    ActionChains(A.d).send_keys("+").perform(); time.sleep(0.2)
    fonts = A.js("return [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ' ' + f.style).join('|')"); print("fonts loaded:", fonts)
    fam = A.js("return getComputedStyle(document.querySelector('.rtitle')).fontFamily")
    print("ui family:", fam)
    [b for b in css(".tab") if "Settings" in b.text][0].click(); time.sleep(0.5); [b for b in css(".stab") if "Look" in b.text][0].click(); shot("05-fonts", 0.9)
    names = [e.text.replace("In use", "").strip() for e in css(".fontcard .fname")]; check("only the two Apple families plus the system choices are offered", sorted(set(names)) == ["New York", "SF Pro", "System", "System serif"], str(names))
finally:
    A.quit()
print("FAILS:", fails)
