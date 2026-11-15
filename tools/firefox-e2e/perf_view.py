"""Times how long the reader takes to show a folder, show everything, and recover after a folder is moved. Synthetic data only."""
import sys, os, time, json
sys.path.insert(0, os.path.dirname(__file__))
from ff import Browser, build_ext
MF = {"url": "http://127.0.0.1:8799/mf", "token": "good-key"}; DAV = {"url": "http://127.0.0.1:8799/dav", "user": "u", "pass": "p", "root": "pravaha"}
ext = build_ext("/tmp/pv-ext-perf")
A = Browser("A", ext, width=1360, height=900)
JS = """
  const settle = (quiet = 120) => new Promise(res => { let last = performance.now(); const mo = new MutationObserver(() => { last = performance.now(); }); mo.observe(document.body, { subtree: true, childList: true, attributes: true });
    const chk = () => { if (performance.now() - last > quiet) { mo.disconnect(); res(last); } else setTimeout(chk, 20); }; setTimeout(chk, 20); });
  const timed = async (name, fn) => { const t0 = performance.now(); let first = null; const mo = new MutationObserver(() => { if (first === null && document.querySelectorAll('.row').length >= 40) first = performance.now() - t0; }); mo.observe(document.body, { subtree: true, childList: true }); fn(); await new Promise(r => requestAnimationFrame(r)); const end = await settle(); mo.disconnect(); out[name] = Math.round(end - t0); if (first !== null) out[name + '_first40rows'] = Math.round(first); };
  const out = {}; const btn = (id) => document.querySelector(`.side .trow[data-id="${id}"] .tbtn`);
  await timed('open_all', () => btn('all').click()); out.parts_all = JSON.parse(JSON.stringify(window.__pvPerf || {}));
  await timed('open_folder_Topic03', () => btn('cat:Topic 03').click());
  await timed('open_all_again', () => btn('all').click());
  out.rows = document.querySelectorAll('.row').length; out.parts_last = JSON.parse(JSON.stringify(window.__pvPerf || {}));
  await timed('move_folder_down_key', () => { const b = btn('cat:Topic 05'); b.focus(); b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })); });
  return out;
"""
try:
    A.open(); A.send({"type": "saveSettings", "patch": {"device": "laptop", "miniflux": MF, "webdav": DAV}}); A.send({"type": "syncNow"}); time.sleep(4); A.open(); time.sleep(2); A.js("localStorage.setItem('pravaha.perf','1')"); A.open(); time.sleep(6)
    print(json.dumps(A.call(JS), indent=1))
finally:
    A.quit()
