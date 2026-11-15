"""Times a synthetic folder drag in real Firefox on a large synthetic library. Synthetic data only.
Reports script time per pointer move and the frame gaps seen by requestAnimationFrame during the drag."""
import sys, os, time, json
sys.path.insert(0, os.path.dirname(__file__))
from ff import Browser, build_ext
MF = {"url": "http://127.0.0.1:8799/mf", "token": "good-key"}; DAV = {"url": "http://127.0.0.1:8799/dav", "user": "u", "pass": "p", "root": "pravaha"}
ext = build_ext("/tmp/pv-ext-perf")
A = Browser("A", ext, width=1360, height=900, prefs={"extensions.webextOptionalPermissionPrompts": False})
try:
    A.open(); A.send({"type": "saveSettings", "patch": {"device": "laptop", "miniflux": MF, "webdav": DAV}}); A.send({"type": "syncNow"}); time.sleep(4); A.open(); time.sleep(6)
    print("rows:", A.js("return document.querySelectorAll('.side .trow').length"), "top folders:", A.js("return document.querySelectorAll('.side .trow[data-grab=true]').length"))
    res = A.call("""
      const rows = [...document.querySelectorAll('.side .trow[data-grab=true] .tbtn')]; const a = rows[2]; const side = document.querySelector('.side');
      const r0 = a.getBoundingClientRect(); const x = r0.left + 20, y = r0.top + 8;
      const fire = (type, cx, cy) => document.dispatchEvent(new PointerEvent(type, { clientX: cx, clientY: cy, bubbles: true, button: 0, pointerId: 1, isPrimary: true }));
      a.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, button: 0, pointerId: 1, isPrimary: true }));
      const gaps = []; let last = performance.now(), run = true; const tick = (t) => { gaps.push(t - last); last = t; if (run) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
      const per = []; const N = 120; let first = 0;
      for (let i = 0; i < N; i++) {
        const t0 = performance.now(); fire('pointermove', x, y + 10 + i * 3); void side.offsetHeight; per.push(performance.now() - t0); if (i === 0) first = per[0];
        await new Promise(r => requestAnimationFrame(r));
      }
      const t1 = performance.now(); fire('pointerup', x, y + 10 + N * 3); const hdl = performance.now() - t1;
      await new Promise(r => setTimeout(r, 400)); run = false;
      per.sort((p, q) => p - q); gaps.sort((p, q) => p - q);
      return { firstMoveMs: first, moveMedianMs: per[N >> 1], moveP95Ms: per[Math.floor(N * .95)], moveMaxMs: per[N - 1], dropHandlerMs: hdl, frameP95Ms: gaps[Math.floor(gaps.length * .95)], frameMaxMs: gaps[gaps.length - 1], frames: gaps.length };
    """)
    print(json.dumps(res, indent=1))
finally:
    A.quit()
