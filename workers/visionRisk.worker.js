// workers/visionRisk.worker.js
// Vision 1.3 — policy-aware scoring + optional neighbor metrics + 1-hop fetch

let CFG = {
  apiBase: "",
  network: "eth",
  concurrency: 8,
  flags: { graphSignals: true, streamBatch: true, neighborStats: true }, // neighborStats safe if ignored
};

// ---------------- transport ----------------
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

    // NEW: 1-hop neighbors (UI uses this for Expand/Refocus)
    if (type === 'NEIGHBORS') {
      const { id: address, network = CFG.network, hop = 1, limit = 100 } = payload || {};
      const out = await fetchNeighbors(address, network, hop, limit); // {nodes,links}
      post({ id, type: 'RESULT', data: out });
      return;
    }

    throw new Error(`unknown type: ${type}`);
  } catch (err) {
    post({ id, type: 'ERROR', error: String(err?.message || err) });
  }
};

function post(msg){ self.postMessage(msg); }

// ---------------- core scoring ----------------

async function scoreOne(item) {
  const id = item?.id || item?.address || '';
  const network = item?.network || CFG.network || 'eth';
  if (!id) throw new Error('scoreOne: missing id');

  // 1) Policy / list check
  let policy = null;
  try {
    if (!CFG.apiBase) throw new Error('apiBase not set');
    const url = `${CFG.apiBase}/check?address=${encodeURIComponent(id)}&network=${encodeURIComponent(network)}`;
    const r = await fetch(url, { headers: { 'accept':'application/json' } }).catch(()=>null);
    if (r && r.ok) policy = await r.json();
  } catch (_) {}

  // 2) Local baseline (keep mid 55 unless server overrides / blocks)
  let localScore = 55;
  const blocked = !!(policy?.block || policy?.risk_score === 100);
  const mergedScore = blocked ? 100 :
    (typeof policy?.risk_score === 'number' ? policy.risk_score : localScore);

  // 3) Dynamic breakdown from policy reasons
  const breakdown = makeBreakdown(policy);

  // 4) Account age (days) via earliest tx (ascending)
  const ageDays = await fetchAgeDays(id, network).catch(()=>0);

  // 5) Optional neighbor metrics (behind flag; safe to skip if API lacks endpoints)
  let neighborsSummary = null;
  if (CFG.flags?.neighborStats) {
    neighborsSummary = await summarizeNeighbors(id, network).catch(()=>null);
  }

  // 6) Explain & feats
  const reasons = policy?.reasons || policy?.risk_factors || [];
  const explain = {
    reasons,
    blocked,
    // Populate OFAC boolean for UI badges
    ofacHit: coerceOfacFromPolicy(policy, reasons),
    // Neighbor metrics (if computed)
    ...(neighborsSummary?.explain || {})
  };

  const res = {
    type: 'address',
    id,
    address: id,
    network,
    label: id.slice(0,10)+'…',

    block: blocked,
    risk_score: mergedScore,
    score: mergedScore,                 // legacy
    reasons,
    risk_factors: reasons,

    breakdown,                          // dynamic factor list

    feats: {
      ageDays,                          // UI renders years/months
      mixerTaint: 0,                    // placeholder; wire to your taint feed when ready
      local: {
        riskyNeighborRatio: neighborsSummary?.proxies?.riskyNeighborRatio ?? 0,
        neighborAvgTx: neighborsSummary?.proxies?.neighborAvgTx ?? undefined,
        neighborAvgAgeDays: neighborsSummary?.proxies?.neighborAvgAgeDays ?? undefined,
      },
    },

    explain,
    parity: 'SafeSend parity',
  };

  return res;
}

// ---------------- explain helpers ----------------

const WEIGHTS = {
  'OFAC': 40,
  'OFAC/sanctions list match': 40,
  'sanctioned Counterparty': 40,
  'fan In High': 9,
  'shortest Path To Sanctioned': 6,
  'burst Anomaly': 0,
  'known Mixer Proximity': 0,
};

function makeBreakdown(policy){
  const src = policy?.reasons || policy?.risk_factors || [];
  if (!Array.isArray(src) || src.length === 0) return [];
  const list = src.map(r => ({
    label: String(r),
    delta: WEIGHTS[r] ?? 0,
  }));
  const hasSanctioned = list.some(x => /sanction/i.test(x.label));
  if ((policy?.block || policy?.risk_score === 100) && !hasSanctioned) {
    list.unshift({ label: 'sanctioned Counterparty', delta: 40 });
  }
  return list.sort((a,b) => (b.delta - a.delta));
}

async function fetchAgeDays(address, network){
  if (!CFG.apiBase) return 0;
  const url = `${CFG.apiBase}/txs?address=${encodeURIComponent(address)}&network=${encodeURIComponent(network)}&limit=1&sort=asc`;
  const r = await fetch(url, { headers:{ 'accept':'application/json' } });
  if (!r.ok) return 0;
  const data = await r.json().catch(()=>({}));
  const arr  = Array.isArray(data?.result) ? data.result : [];
  if (arr.length === 0) return 0;

  const t = arr[0];
  const ms = coerceTimestamp(
    t?.raw?.metadata?.blockTimestamp || t?.metadata?.blockTimestamp,
    t?.timeStamp || t?.timestamp || t?.blockTime
  );
  if (!ms) return 0;
  const days = (Date.now() - ms) / 86400000;
  return days > 0 ? Math.round(days) : 0;
}

// ---------------- neighbor support ----------------

/**
 * Try to fetch 1-hop neighbors from backend.
 * Expected backend shape:
 *  { nodes:[{ id, createdAt, lastTxAt, txCount, labels?:string[] }...],
 *    links:[{ a, b, weight?:number }...] }
 * Return empty arrays if not available (keeps UI graceful).
 */
async function fetchNeighbors(address, network, hop = 1, limit = 100){
  if (!CFG.apiBase) return { nodes: [], links: [] };
  try {
    const url = `${CFG.apiBase}/neighbors?address=${encodeURIComponent(address)}&network=${encodeURIComponent(network)}&hop=${hop}&limit=${limit}`;
    const r = await fetch(url, { headers: { 'accept':'application/json' } });
    if (!r.ok) return { nodes: [], links: [] };
    const data = await r.json().catch(()=>null);
    const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
    const links = Array.isArray(data?.links) ? data.links : [];
    return { nodes, links };
  } catch {
    return { nodes: [], links: [] };
  }
}

/**
 * Compute neighbor metrics for explain + proxy feats.
 * - neighborsDormant.inactiveRatio (aged≥365d AND lastTx≥90d)
 * - neighborsAvgTxCount.avgTx
 * - neighborsAvgAge.avgDays
 * Also computes proxies for UI:
 *  feats.local.riskyNeighborRatio, neighborAvgTx, neighborAvgAgeDays
 */
async function summarizeNeighbors(address, network){
  const { nodes } = await fetchNeighbors(address, network, 1, 200);
  if (!nodes?.length) {
    return {
      explain: {},
      proxies: { riskyNeighborRatio: 0, neighborAvgTx: undefined, neighborAvgAgeDays: undefined }
    };
  }

  const now = Date.now();
  const toMs = (v)=>{
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  };

  const oldWalletDays = 365;
  const inactiveCutoff = 90;

  let sumAge = 0, nAge = 0;
  let sumTx = 0, nTx = 0;
  let inactive = 0, sumAgeInactive = 0, resurrected = 0, wl = 0;

  const WHITELIST = new Set(['exchange','custody','cold_storage','known_safe']);

  for (const n of nodes){
    const cMs = toMs(n.createdAt);
    const lMs = toMs(n.lastTxAt);
    const ageDays = cMs ? Math.max(0, (now - cMs)/86400000) : 0;
    const lastTxDays = lMs ? Math.max(0, (now - lMs)/86400000) : Infinity;

    if (ageDays > 0) { sumAge += ageDays; nAge++; }

    if (typeof n.txCount === 'number') { sumTx += n.txCount; nTx++; }

    const labels = Array.isArray(n.labels) ? n.labels.map(s=>String(s).toLowerCase()) : [];
    if (labels.some(l=>WHITELIST.has(l))) wl++;

    const aged = ageDays >= oldWalletDays;
    const inact = lastTxDays >= inactiveCutoff;

    if (aged && inact) {
      inactive++; sumAgeInactive += ageDays;
    }
    if (aged && isFinite(lastTxDays) && lastTxDays <= 30) resurrected++;
  }

  const n = nodes.length;
  const avgDays = nAge ? (sumAge/nAge) : 0;
  const avgTx   = nTx ? (sumTx/nTx) : 0;
  const inactiveRatio = n ? (inactive/n) : 0;
  const avgInactiveAge = inactive ? (sumAgeInactive/inactive) : 0;
  const whitelistPct = n ? wl/n : 0;

  const explain = {
    neighborsDormant: { inactiveRatio, avgInactiveAge, resurrected, whitelistPct, n },
    neighborsAvgTxCount: { avgTx, n },
    neighborsAvgAge: { avgDays, n }
  };

  const proxies = {
    riskyNeighborRatio: inactiveRatio,
    neighborAvgTx: avgTx,
    neighborAvgAgeDays: avgDays
  };

  return { explain, proxies };
}

// ---------------- small utils ----------------

function coerceTimestamp(isoMaybe, secMaybe){
  let ms = 0;
  if (isoMaybe) {
    const d = new Date(isoMaybe);
    if (!isNaN(d)) ms = d.getTime();
  }
  if (!ms && secMaybe) {
    const n = Number(secMaybe);
    if (!isNaN(n) && n > 1000000000) ms = (n < 2000000000 ? n*1000 : n); // seconds or ms
  }
  return ms;
}

function coerceOfacFromPolicy(policy, reasonsArray){
  if (policy?.block || policy?.risk_score === 100) return true;
  const txt = Array.isArray(reasonsArray) ? reasonsArray.join('|').toLowerCase() : String(reasonsArray||'').toLowerCase();
  if (/ofac|sanction/.test(txt)) return true;
  if (policy && (policy.ofac === true || policy.sanctioned === true)) return true;
  return false;
}
