"""Helpers to run the real extension in real Firefox (160, the base of Zen) with Selenium.
Firefox and geckodriver are expected under FFX (default /home/claude/ffx). Synthetic data only."""
import json, os, shutil, subprocess, tempfile, time
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

FFX = os.environ.get("FFX", "/home/claude/ffx")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GECKO_ID = "pravaha@agravaani"
UUIDS = {"A": "11111111-1111-4111-8111-111111111111", "B": "22222222-2222-4222-8222-222222222222", "C": "33333333-3333-4333-8333-333333333333"}

def build_ext(dst):
    """Copy the extension and let it reach the local fake services over http."""
    if os.path.exists(dst): shutil.rmtree(dst)
    shutil.copytree(os.path.join(ROOT, "extension"), dst, ignore=shutil.ignore_patterns("apple"))
    mp = os.path.join(dst, "manifest.json"); m = json.load(open(mp))
    m["host_permissions"] = m["host_permissions"] + ["http://127.0.0.1/*"]
    json.dump(m, open(mp, "w"), indent=1)
    return dst

class Browser:
    def __init__(self, name="A", ext_dir=None, profile=None, headless=True, width=1360, height=900, prefs=None):
        os.environ["MOZ_REMOTE_ALLOW_SYSTEM_ACCESS"] = "1"  # lets Marionette open and script moz-extension: pages
        self.name = name; self.uuid = UUIDS[name]
        self.profile = profile or tempfile.mkdtemp(prefix=f"pv-prof-{name}-")
        o = Options(); o.binary_location = os.path.join(FFX, "firefox", "firefox")
        if headless: o.add_argument("-headless")
        o.add_argument("-profile"); o.add_argument(self.profile)
        o.set_preference("xpinstall.signatures.required", False)
        o.set_preference("extensions.webextensions.uuids", json.dumps({GECKO_ID: self.uuid}))
        o.set_preference("extensions.autoDisableScopes", 0)
        o.set_preference("browser.shell.checkDefaultBrowser", False)
        o.set_preference("datareporting.policy.dataSubmissionEnabled", False)
        for k, v in (prefs or {}).items(): o.set_preference(k, v)
        self.d = webdriver.Firefox(options=o, service=Service(os.path.join(FFX, "geckodriver"), log_output=os.path.join(tempfile.gettempdir(), f"gecko-{name}.log")))
        self.d.set_window_size(width, height)
        if ext_dir: self.install(ext_dir)
    def install(self, ext_dir): self.d.install_addon(os.path.abspath(ext_dir), temporary=True); time.sleep(1.5)
    @property
    def url(self): return f"moz-extension://{self.uuid}/ui/reader.html"
    def open(self, hash=""):
        self.d.get(self.url + hash); time.sleep(1.5)
    def js(self, script, *args): return self.d.execute_script(script, *args)
    def call(self, script, *args):
        """Run async JS in the extension page; the last statement must `return` a value. Awaits promises."""
        return self.d.execute_async_script("const done = arguments[arguments.length - 1]; (async () => { %s })().then(done, e => done({ __error: String(e && e.stack || e) }));" % script, *args)
    def send(self, msg): return self.call("return await browser.runtime.sendMessage(arguments[0]);", msg)
    def text(self, css):
        els = self.d.find_elements("css selector", css); return [e.text for e in els]
    def shot(self, path): self.d.save_screenshot(path); return path
    def quit(self):
        try: self.d.quit()
        except Exception: pass
