import sys, time, os
sys.path.insert(0, os.path.dirname(__file__))
from ff import Browser, build_ext
from selenium.webdriver.common.by import By
ext = build_ext("/tmp/pv-ext"); A = Browser("A", ext, prefs={"extensions.webextOptionalPermissionPrompts": False})
try:
    A.open(); A.js("[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('Settings')).click();"); time.sleep(0.6); A.js("[...document.querySelectorAll('.stab')].find(b => b.textContent.includes('This machine')).click();"); time.sleep(0.6)
    time.sleep(1.5); A.js("document.querySelector(\"[data-act='detect-feeds']\").scrollIntoView({block:'center'})"); time.sleep(0.3); A.d.find_element(By.CSS_SELECTOR, "[data-act='detect-feeds']").click(); time.sleep(0.7); A.d.find_element(By.CSS_SELECTOR, "[data-act='confirm']").click(); time.sleep(2)
    print(A.text("[data-note='detect']"))
finally: A.quit()
