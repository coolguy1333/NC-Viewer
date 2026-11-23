// Background thread for big programs: parsing and verification run here so
// the page stays responsive. Loaded only when a large program is opened.
import { analyzeText } from './pipeline.js';

self.onmessage = (e) => {
  const { id, text, cfg } = e.data;
  try {
    const r = analyzeText(text, cfg);
    const s = r.prog.segs;
    const buffers = [s.p, s.ax, s.type, s.code, s.line, s.tool, s.feed, s.fmode, s.rpm, s.dwell, r.times.time, r.times.cum, r.times.len, r.lineIdx].map((a) => a.buffer);
    self.postMessage({ id, result: r }, buffers);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};
