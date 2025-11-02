// vision/ui/ScoreMeter.js
// Score card with header, segmented ring, divider, and weighted factors.
// Keeps numeric score even when blocked; ring turns red.

export function ScoreMeter(root) {
  const el = (typeof root === 'string') ? document.querySelector(root) : root;
  if (!el) return noop();

  // Build skeleton once (safe if markup already present)
  ensureSkeleton(el);

  const card     = el.querySelector('.score-card');
  const badgeEl  = el.querySelector('.badge');
  const labelEl  = el.querySelector('.score-text');
  const subEl    = el.querySelector('.score-sub');
  const ringSvg  = el.querySelector('svg.ring');
  const ringArc  = ringSvg?.querySelector('.arc') || null;
  const ticksG   = ringSvg?.querySelector('.ticks') || null;
  const reasonsEl= el.querySelector('.reasons');

  // Draw segmented ticks (if not already drawn)
  if (ticksG && !ticksG.childElementCount) drawTicks(ticksG, 24);

  let _score = 0;
  let _blocked = false;

  function clamp(n){ n = Number(n)||0; return n<0?0:(n>100?100:n); }
  function band(score){
    if (_blocked || score >= 80) return 'High';
    if (score >= 60) return 'Moderate'; // label “Moderate” to mirror screenshot
    return 'Low';
  }
  function ringColor(score){
    if (_blocked || score >= 80) return '#ef4444';
    if (score >= 60) return '#22d3ee';
    return '#10b981';
  }

  function apply(){
    if (labelEl) labelEl.textContent = String(_score);      // keep numeric
    if (subEl)   subEl.textContent   = band(_score);

    card.classList.add('score-meter');
    card.classList.toggle('blocked', _blocked);

    if (ringArc){
      const pct = _score / 100;
      const dash = 283 * pct; // circumference for r≈45
      ringArc.setAttribute('stroke', ringColor(_score));
      ringArc.setAttribute('stroke-dasharray', `${dash} 999`);
    }
  }

  function setScore(score, opts = {}) {
    _score = clamp(score);
    if (typeof opts.blocked === 'boolean') _blocked = !!opts.blocked;
    apply();
  }
  function setBlocked(flag){ _blocked = !!flag; apply(); }

  function setBadge(text){
    if (!badgeEl) return;
    if (!text) { badgeEl.hidden = true; return; }
    badgeEl.textContent = text;
    badgeEl.hidden = false;
  }

  function setReasonsList(items){
    if (!reasonsEl) return;
    const rows = (Array.isArray(items) ? items : []).map(rowHTML).join('') ||
      `<div class="reason muted">No elevated factors detected</div>`;
    reasonsEl.innerHTML = rows;
  }

  function setSummary(result = {}){
    const blocked = !!(result.block || result.risk_score === 100 || result.sanctionHits);
    const score   = typeof result.risk_score === 'number' ? result.risk_score
                 : typeof result.score === 'number' ? result.score : 0;

    // badge (show unless explicitly false)
    const badgeText = result.parity === false ? null :
      (typeof result.parity === 'string' ? result.parity : 'SafeSend parity');
    setBadge(badgeText);

    // factor breakdown (structured preferred; otherwise derive)
    const breakdown = normalizeBreakdown(result);
    setReasonsList(breakdown);

    setScore(score, { blocked });
  }

  function getScore(){ return _score; }

  // first paint
  apply();
  return { setScore, setBlocked, setReasons: setReasonsList, setSummary, getScore };
}

/* ---------- internals ---------- */

function ensureSkeleton(root){
  if (!root.querySelector('.score-card')) {
    root.innerHTML = `
      <div class="score-card">
        <div class="score-header">
          <div class="title">Risk Score</div>
          <span class="badge">SafeSend parity</span>
        </div>
        <div class="meter">
          <svg viewBox="0 0 100 100" class="ring">
            <g class="ticks"></g>
            <circle cx="50" cy="50" r="45" class="track" fill="none" stroke-width="8"></circle>
            <circle cx="50" cy="50" r="45" class="arc"   fill="none" stroke-width="8" stroke-linecap="round" stroke-dasharray="0 999"></circle>
          </svg>
          <div class="label">
            <div class="score-text">0</div>
            <div class="score-sub">Moderate</div>
          </div>
        </div>
        <div class="divider"></div>
        <div class="reasons"></div>
      </div>
    `;
  }
}

function drawTicks(g, n=24){
  const cx=50, cy=50, r=45, inner=r-6, outer=r+6;
  for (let i=0;i<n;i++){
    const a = (2*Math.PI*i)/n - Math.PI/2;
    const x1 = cx + inner*Math.cos(a), y1 = cy + inner*Math.sin(a);
    const x2 = cx + outer*Math.cos(a), y2 = cy + outer*Math.sin(a);
    const line = document.createElementNS('http://www.w3.org/2000/svg','line');
    line.setAttribute('x1',x1); line.setAttribute('y1',y1);
    line.setAttribute('x2',x2); line.setAttribute('y2',y2);
    line.setAttribute('class','tick');
    g.appendChild(line);
  }
}

function rowHTML(item){
  if (!item || typeof item !== 'object') {
    const text = String(item ?? '');
    return `<div class="reason"><span>${escape(text)}</span><span class="val">+0</span></div>`;
  }
  const label = escape(item.label ?? item.reason ?? '');
  const val   = Number(item.delta ?? item.points ?? item.scoreDelta ?? 0);
  const sign  = val > 0 ? '+' : '';
  return `<div class="reason"><span>${label}</span><span class="val">${sign}${val}</span></div>`;
}

function normalizeBreakdown(result){
  if (Array.isArray(result.breakdown) && result.breakdown.length) return result.breakdown;

  // Derive from reasons using your weights
  const weights = {
    'sanctioned Counterparty': 40,
    'OFAC': 40,
    'OFAC/sanctions list match': 40,
    'fan In High': 9,
    'shortest Path To Sanctioned': 6,
    'burst Anomaly': 0,
    'known Mixer Proximity': 0,
  };
  const reasons = result.reasons || result.risk_factors || [];
  return reasons.map(r => ({ label: r, delta: weights[r] ?? 0 }));
}

function escape(s){ return String(s).replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function noop(){ return { setScore(){}, setBlocked(){}, setReasons(){}, setSummary(){}, getScore(){return 0;} }; }

// default export + global
const api = { ScoreMeter };
export default api;
try{ if (typeof window!=='undefined') window.ScoreMeter = ScoreMeter; }catch{}
