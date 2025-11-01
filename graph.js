// vision/graph.js
// Clean, extensible Graph API + legacy compatibility.

export function nodeClassesFor(result, nodeAddress) {
  const addr  = String(nodeAddress || '').toLowerCase();
  const focus = String(result?.address || '').toLowerCase();
  const base  = ['node'];

  const blocked =
    !!(result?.block || result?.risk_score === 100 || result?.sanctionHits);

  if (addr && focus && addr === focus) {
    base.push('halo');
    if (blocked) base.push('halo-red');
  }

  const score = typeof result?.risk_score === 'number'
    ? result.risk_score
    : (typeof result?.score === 'number' ? result.score : 0);

  base.push(bandClass(score, blocked));
  return base.join(' ');
}

export function bandClass(score, blocked) {
  if (blocked || score >= 80) return 'band-high';
  if (score >= 60) return 'band-elevated';
  return 'band-moderate';
}

// Stubs you can flesh out later without changing imports:
export function render(/*container, data, opts*/) {}
export function updateStyles(/*container, result*/) {}
export function computeLayout(/*nodes, edges, opts*/) {}

// Namespaced API (nice dev ergonomics)
const api = { nodeClassesFor, bandClass, render, updateStyles, computeLayout };
export default api;

// --- Legacy compatibility ---
// If other modules still expect a global `graph`, provide it safely.
try { if (typeof window !== 'undefined') window.graph = api; } catch {}
