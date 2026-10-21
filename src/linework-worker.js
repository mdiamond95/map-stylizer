// Pulling lines off a full-size scan takes a few seconds, so it runs off the
// main thread to keep the iPad responsive.
import { extractLinework } from './core/linework.js';

self.onmessage = (e) => {
  const { id, rgba, width, height, options } = e.data;
  try {
    const result = extractLinework(new Uint8ClampedArray(rgba), width, height, options, (step) => self.postMessage({ id, progress: step }));
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
