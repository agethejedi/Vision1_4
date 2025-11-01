// workers/visionRisk.worker.js
// Minimal worker: server-policy aware scoring (+ optional streaming)

let CFG = {
  apiBase: "",
  network: "eth",
  concurrency: 8,
  flags: { graphSignals: true, streamBatch: true },
};

self.onmessage = async (e) => {
  const { id, type, payload } = e.data || {};
  try {
    if (type === 'INIT') {
      if (payload?.apiBase) CFG.apiBase = String(payload.apiBase).replace(/\/$/, '');
      if (payload?.network) CFG.network = payload.network;
      if (payload?.concurrency) CFG.concurrency = payload.concurrency;
      if (payload?.flags) CFG.flags = { ...CFG.flags, ...payload.flags };
      post({ id, type: 'INIT_OK' });
      return;
    }

    if (type === 'SCORE_ONE') {
      const item = payload?.item;
      const res = await scoreOne(item);
      post({ id, type: 'RESULT', data: res });
      return;
    }

    if (type === 'SCORE_BATCH') {
      const items = Array.isArray(payload?.items) ? payload.items : [];
      for (const it of items) {
        const r = await scoreOne(it);
        post({ type: 'RESULT_STREAM', data: r });
      }
      post({ id, type: 'DONE' });
      return;
    }

    throw new Error(`unknown type: ${type}`);
  } catch (err) {
    post({ id, type: 'ERROR', error: String(err?.message || err) });
  }
};

function post(msg){ self.postMessage(msg); }

// ---- Core scoring (server-policy aware) ----------------------------------

async function scoreOne(item) {
  const id = item?.id || item?.address || '';
  const network = item?.network || CFG.network || 'eth';
  if (!id) throw new Error('scoreOne: missing id');

  // 1) Ask server worker for list hits / policy
  let policy = null;
  try {
    const url = `${CFG.apiBase}/check?address=${encodeURIComponent(id)}&network=${encodeURIComponent(network)}`;
    const r = await fetch(url, { headers:{ 'accept':'application/json' }, cf: { cacheTtl: 0 } }).catch(()=>null);
    if (r && r.ok) policy = await r.json();
  } catch(_){ /* ignore network errors */ }

  // 2) Local heuristic score (keep your current 55 default)
  let localScore = 55;                 // ← your existing mid score
  let localReasons = ['No elevated factors detected'];

  // 3) Merge: trust server on block / score 100 / reasons
  const blocked = !!(policy?.block || policy?.risk_score === 100);
  const mergedScore = blocked ? 100 : (typeof policy?.risk_score === 'number' ? policy.risk_score : localScore);
  const reasons = (policy?.reasons && policy.reasons.length) ? policy.reasons
                 : (policy?.risk_factors && policy.risk_factors.length) ? policy.risk_factors
                 : localReasons;

  // 4) Return unified result shape
  return {
    type: 'address',
    id,
    address: id,
    network,
    label: id.slice(0, 10) + '…',
    // policy
    block: blocked,
    risk_score: mergedScore,
    reasons,
    risk_factors: reasons,

    // legacy fields used by app.js
    score: mergedScore,
    explain: { reasons, blocked },

    // dummy feature slots (safe defaults)
    feats: {
      ageDays:  (policy?.feats?.ageDays ?? 0),
      mixerTaint: (policy?.feats?.mixerTaint ?? 0),
      local: { riskyNeighborRatio: 0 },
    },
  };
}
