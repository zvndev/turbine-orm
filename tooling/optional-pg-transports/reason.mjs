// Diagnostics must never replace an arbitrary rejection or assimilate a thenable.
export function describeReason(reason) {
  try { if (typeof reason?.stack === 'string') return reason.stack; } catch {}
  try { return String(reason); } catch { return '[unprintable thrown value]'; }
}
