// Vision risk worker — imports adapter with cache-bust and exposes VisionConfig in worker scope

import { scoreOne, scoreBatch } from '../shared/risk-core/index.js';
// Cache-bust to force browsers/CDNs to fetch the latest adapter (uses /txs + /ofac)
import { RiskAdapters } from '../adapters/evm.js?v=txs-2025-11-02';

let ctx = {
  adapters: { evm: RiskAdapters.evm }, // keep adapter inside worker (avoid DataCloneError)
  cache: null,
  network: 'eth',
  ruleset: 'safesend-2025.10.1',
  concurrency: 8,
  flags: { graphSignals: true, streamBatch: true }
};

self.onmessage = async (e) => {
  const { id, type, payload } = e.data || {};
  try {
    if (type === 'INIT') {
      const { adapters: _ignored, apiBase, ...rest } = payload || {};
      ctx = { ...ctx, ...rest };

      // Make API_BASE available inside worker for the adapter (no window in workers)
      if (apiBase) {
        self.VisionConfig = Object.assign({}, self.VisionConfig || {}, { API_BASE: apiBase });
      }

      postMessage({
        id,
        type: 'INIT_OK',
        capabilities: ['single', 'batch', 'stream', 'graphSignals'],
        ruleset: ctx.ruleset
      });
      return;
    }

    if (type === 'SCORE_ONE') {
      const res = await scoreOne(payload.item, ctx);
      postMessage({ id, type: 'RESULT', data: res });
      return;
    }

    if (type === 'SCORE_BATCH') {
      const results = await scoreBatch(payload.items, ctx);
      if (ctx.flags.streamBatch) {
        for (const r of results) postMessage({ id, type: 'RESULT_STREAM', data: r });
        postMessage({ id, type: 'DONE' });
      } else {
        postMessage({ id, type: 'RESULT', data: results });
      }
      return;
    }

    if (type === 'ABORT') {
      postMessage({ id, type: 'ABORT_ACK' });
      return;
    }

  } catch (err) {
    postMessage({ id, type: 'ERROR', error: String(err?.message || err) });
  }
};
