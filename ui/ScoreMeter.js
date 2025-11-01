// vision/ui/ScoreMeter.js
// Minimal score meter that honors server-side block/risk_score

export function renderScoreMeter(rootEl, result) {
  if (!rootEl) return;
  const score = clamp0to100(
    (typeof result?.risk_score === 'number')
      ? result.risk_score
      : (typeof result?.score === 'number' ? result.score : 0)
  );
  const blocked = !!(result?.block || score === 100 || result?.sanctionHits);

  // Text label
  const labelEl = rootEl.querySelector('.score-text');
  if (labelEl) labelEl.textContent = blocked ? 'Blocked' : String(score);

  // Sub label (e.g., "Moderate"/"High")
  const subEl = rootEl.querySelector('.score-sub');
  if (subEl) subEl.textContent = blocked ? 'Policy: Hard Block' : bandLabel(score);

  // Color ring
  rootEl.classList.toggle('score-meter', true);
  rootEl.classList.toggle('blocked', blocked);
  rootEl.style.setProperty('--score', String(score));
  rootEl.style.setProperty('--ring-color', blocked ? '#ef4444' : ringColor(score));

  // If you draw SVG, update arc here; else rely on CSS ring
  const arc = rootEl.querySelector('svg .arc');
  if (arc) {
    const pct = score / 100;
    const dash = 283 * pct; // assuming a 2πr ~ 283
    arc.setAttribute('stroke', blocked ? '#ef4444' : ringColor(score));
    arc.setAttribute('stroke-dasharray', `${dash} 999`);
  }
}

function clamp0to100(n){ n = Number(n)||0; return n < 0 ? 0 : (n > 100 ? 100 : n); }
function ringColor(score){
  if (score >= 80) return '#ef4444'; // red
  if (score >= 60) return '#f59e0b'; // amber
  return '#10b981'; // green
}
function bandLabel(score){
  if (score >= 80) return 'High';
  if (score >= 60) return 'Elevated';
  return 'Moderate';
}
