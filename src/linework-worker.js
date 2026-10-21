// Pulling lines off a full-size scan takes a few seconds, so it runs off the
// main thread to keep the iPad responsive.
import { extractLinework } from './core/linework.js';
import { extractCombined } from './core/combined.js';

self.onmessage = (e) => {
  const { id, rgba, width, height, options } = e.data;
  try {
    const run = options.method === 'ink' ? extractLinework : extractCombined;
    const result = run(new Uint8ClampedArray(rgba), width, height, options, (step) => self.postMessage({ id, progress: step }));
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
