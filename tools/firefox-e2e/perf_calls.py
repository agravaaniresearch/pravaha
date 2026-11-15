"""Times the background calls the reader makes, on a large synthetic library, in real Firefox. Synthetic data only."""
import sys, os, time, json
sys.path.insert(0, os.path.dirname(__file__))
from ff import Browser, build_ext
MF = {"url": "http://127.0.0.1:8799/mf", "token": "good-key"}; DAV = {"url": "http://127.0.0.1:8799/dav", "user": "u", "pass": "p", "root": "pravaha"}
ext = build_ext("/tmp/pv-ext-perf")
A = Browser("A", ext, width=1360, height=900)
try:
    A.open(); A.send({"type": "saveSettings", "patch": {"device": "laptop", "miniflux": MF, "webdav": DAV}}); A.send({"type": "syncNow"}); time.sleep(4); A.open(); time.sleep(2)
    res = A.call("""
      const out = {}; const t = async (name, msg, n = 7) => { const xs = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); await browser.runtime.sendMessage(msg); xs.push(performance.now() - t0); } xs.sort((a, b) => a - b); out[name] = Math.round(xs[n >> 1] * 10) / 10; };
      await t('tree', {type:'tree'}); await t('status', {type:'status'}); await t('boot', {type:'boot'});
      await t('view_all_unread', {type:'view', params:{scope:'all', mode:'unread', ranked:false}});
      await t('view_ranked', {type:'view', params:{scope:'all', mode:'unread', ranked:true}});
      await t('view_folder', {type:'view', params:{scope:'cat:Topic 03', mode:'unread', ranked:false}});
      const t0 = performance.now(); const r = await browser.runtime.sendMessage({type:'view', params:{scope:'all', mode:'unread', ranked:false}}); out.items = r.view.total; out.payloadKB = Math.round(JSON.stringify(r).length / 1024);
      const c0 = performance.now(); const side = document.querySelector('.side'); out.sideRows = side.querySelectorAll('.trow').length;
      return out;
    """)
    print(json.dumps(res, indent=1))
finally:
    A.quit()
