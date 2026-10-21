// Projection detection is a few thousand trial fits, so it runs off the main
// thread to keep the iPad responsive.
import { rankProjections } from './core/georef.js';

self.onmessage = (e) => {
  try {
    self.postMessage({ id: e.data.id, ranking: rankProjections(e.data.gcps) });
  } catch (err) {
    self.postMessage({ id: e.data.id, error: String(err?.message || err) });
  }
};
