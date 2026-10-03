importScripts("core.js", "optimizer.js");
self.onmessage = (event) => {
  try {
    const { data, planIds, options } = event.data;
    self.postMessage({ ok: true, output: self.ExperimentOptimizer.optimize(data, planIds, options) });
  } catch (error) {
    self.postMessage({ ok: false, error: error?.message || String(error) });
  }
};
