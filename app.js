import './ui/ScoreMeter.js?v=2025-11-02';     // provides window.ScoreMeter(...)
import './graph.js?v=2025-11-02';             // provides window.graph (on/setData/setHalo)

// --- Worker plumbing -------------------------------------------------------
const worker = new Worker('./workers/visionRisk.worker.js', { type: 'module' });

const pending = new Map();
function post(type, payload) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

worker.onmessage = (e) => {
  const { id, type, data, error } = e.data || {};
  const req = pending.get(id);

  if (type === 'INIT_OK') {
    if (req) { req.resolve(true); pending.delete(id); }
    return;
  }

  if (type === 'RESULT_STREAM') {
    const r = normalizeResult(data);
    drawHalo(r);
    if (r.id === selectedNodeId) updateScorePanel(r);
    updateBatchStatus(`Scored: ${r.id.slice(0,8)}… → ${r.score}`);
    return;
  }

  if (type === 'RESULT') {
    const r = normalizeResult(data);
    drawHalo(r);
    if (r.id === selectedNodeId) updateScorePanel(r);
    if (req) { req.resolve(r); pending.delete(id); }
    return;
  }

  if (type === 'DONE') {
    if (req) { req.resolve(true); pending.delete(id); }
    updateBatchStatus('Batch: complete');
    return;
  }

  if (type === 'ERROR') {
    console.error(error);
    if (req) { req.reject(new Error(error)); pending.delete(id); }
    updateBatchStatus('Batch: error');
  }
};

// Normalize worker result → trust server-side policy if present
function normalizeResult(res = {}) {
  // Score: prefer server risk_score (100 on OFAC), else fallback to res.score
  const serverScore = (typeof res.risk_score === 'number') ? res.risk_score : null;
  const score = (serverScore != null) ? serverScore : (typeof res.score === 'number' ? res.score : 0);

  // Blocked if server says block, or risk_score=100, or explicit sanction hit
  const blocked = !!(res.block || serverScore === 100 || res.sanctionHits);

  const explain = {
    reasons: res.reasons || res.risk_factors || [],
    blocked,
  };

  return {
    ...res,
    score,
    explain,
    block: blocked,
  };
}

// --- Init ------------------------------------------------------------------
async function init() {
  await post('INIT', {
    apiBase: (window.VisionConfig && window.VisionConfig.API_BASE) || "",
    cache: window.RiskCache,
    network: getNetwork(),
    ruleset: 'safesend-2025.10.1',
    concurrency: 8,
    flags: { graphSignals: true, streamBatch: true }
  });

  bindUI();
  seedDemo();
}
init();

// --- UI wiring -------------------------------------------------------------
function bindUI() {
  document.getElementById('refreshBtn')?.addEventListener('click', () => {
    scoreVisible();
  });

  document.getElementById('clearBtn')?.addEventListener('click', () => {
    window.graph?.setData({ nodes: [], links: [] });
    updateBatchStatus('Idle');
    setSelected(null);
  });

  document.getElementById('loadSeedBtn')?.addEventListener('click', () => {
    const seed = document.getElementById('seedInput').value.trim();
    if (!seed) return;
    loadSeed(seed);
  });

  document.getElementById('networkSelect')?.addEventListener('change', async () => {
    await post('INIT', { network: getNetwork() });
    scoreVisible();
  });

  // If your graph module emits 'selectNode', keep this
  window.graph?.on('selectNode', (n) => {
    if (!n) return;
    setSelected(n.id);
    post('SCORE_ONE', { item: { type: 'address', id: n.id, network: getNetwork() } })
      .then(r => updateScorePanel(normalizeResult(r)))
      .catch(() => {});
  });
}

function getNetwork() {
  return document.getElementById('networkSelect')?.value || 'eth';
}

let selectedNodeId = null;
function setSelected(id) { selectedNodeId = id; }

// Score panel instance (imperative API from ScoreMeter drop-in)
const scorePanel = (window.ScoreMeter && window.ScoreMeter('#scorePanel')) || {
  setSummary(){}, setScore(){}, setBlocked(){}, setReasons(){}, getScore(){ return 0; }
};

function updateScorePanel(res) {
  // Ensure SafeSend badge
  res.parity = (typeof res.parity === 'string' || res.parity === true)
    ? res.parity
    : 'SafeSend parity';

  // ----- AGE (convert from days → years + months) -----
  const feats = res.feats || {};
  const ageDays = Number(feats.ageDays ?? 0);
  let ageDisplay = '—';
  if (ageDays > 0) {
    const totalMonths = Math.round(ageDays / 30.44); // 30.44 = average days per month
    const years = Math.floor(totalMonths / 12);
    const months = totalMonths % 12;
    if (years > 0 && months > 0) ageDisplay = `${years}y ${months}m`;
    else if (years > 0) ageDisplay = `${years}y`;
    else ageDisplay = `${months}m`;
  }

  // ----- Inject default factor weights if none provided -----
  const defaultBreakdown = [
    { label: 'sanctioned Counterparty', delta: 40 },
    { label: 'fan In High', delta: 9 },
    { label: 'shortest Path To Sanctioned', delta: 6 },
    { label: 'burst Anomaly', delta: 0 },
    { label: 'known Mixer Proximity', delta: 0 }
  ];

  if (!Array.isArray(res.breakdown) || res.breakdown.length === 0) {
    res.breakdown = defaultBreakdown;
  }

  // ----- Keep numeric score even when blocked -----
  const blocked = !!(res.block || res.risk_score === 100 || res.sanctionHits);
  res.blocked = blocked;

  // Render the new unified card
  scorePanel.setSummary(res);

  // ----- Meta summary section -----
  const mixerPct = Math.round((feats.mixerTaint ?? 0) * 100) + '%';
  const neighPct = Math.round((feats.local?.riskyNeighborRatio ?? 0) * 100) + '%';

  document.getElementById('entityMeta').innerHTML = `
    <div>Address: <b>${res.id}</b></div>
    <div>Network: <b>${res.network}</b></div>
    <div>Age: <b>${ageDisplay}</b></div>
    <div>Mixer taint: <b>${mixerPct}</b></div>
    <div>Neighbors flagged: <b>${neighPct}</b></div>
  `;
}

// Halo coloring + intensity; pass whole result so blocked=red is automatic
function drawHalo(res) {
  // If you want “blocked = always red” use graph.setHalo(res) directly:
  window.graph?.setHalo(res);

  // If you still want custom ring color by score for non-blocked cases, you can keep this:
  // const color = res.score >= 80 ? '#ff3b3b'
  //            : res.score >= 60 ? '#ffb020'
  //            : res.score >= 40 ? '#ffc857'
  //            : res.score >= 20 ? '#22d37b'
  //            : '#00eec3';
  // window.graph?.setHalo(res.id, { intensity: res.score / 100, color, tooltip: res.label });
}

function updateBatchStatus(text) {
  const el = document.getElementById('batchStatus');
  if (el) el.textContent = text;
}

// --- Scoring pipeline ------------------------------------------------------
function scoreVisible() {
  const viewNodes = getVisibleNodes();
  if (!viewNodes.length) { updateBatchStatus('No nodes in view'); return; }
  updateBatchStatus(`Batch: ${viewNodes.length} nodes`);
  const items = viewNodes.map(n => ({ type: 'address', id: n.id, network: getNetwork() }));
  post('SCORE_BATCH', { items }).catch(err => console.error(err));
}

// Replace this with your real graph viewport nodes when ready
function getVisibleNodes() {
  const sample = window.__VISION_NODES__ || [];
  return sample;
}

// --- Demo seed graph -------------------------------------------------------
function seedDemo() {
  const seed = '0xDEMOSEED00000000000000000000000000000001';
  loadSeed(seed);
}

function loadSeed(seed) {
  const n = 14, nodes = [], links = [];
  for (let i = 0; i < n; i++) {
    const a = '0x' + Math.random().toString(16).slice(2).padStart(40, '0').slice(0, 40);
    nodes.push({ id: a, address: a, network: getNetwork() });
    links.push({ a: seed, b: a, weight: 1 });
  }
  nodes.unshift({ id: seed, address: seed, network: getNetwork() });
  window.__VISION_NODES__ = nodes;
  window.graph?.setData({ nodes, links });
  setSelected(seed);
  scoreVisible();
}
