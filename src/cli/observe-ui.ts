// Embedded HTML for the Turbine Observe dashboard.
// Same pattern as studio-ui.generated.ts but hand-authored (no build step needed).

export const OBSERVE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <title>Turbine Observe</title>
  <style>
    :root {
      --bg: #0a0a0b;
      --bg-elev: #111113;
      --bg-hover: #1a1a1d;
      --border: #26262b;
      --text: #e6e6ea;
      --text-dim: #8a8a93;
      --accent: #60a5fa;
      --green: #4ade80;
      --red: #f87171;
      --orange: #fb923c;
      --purple: #a78bfa;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: system-ui, -apple-system, sans-serif;
      --radius: 6px;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; padding: 24px; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    .subtitle { color: var(--text-dim); margin-bottom: 24px; }
    .controls { display: flex; gap: 8px; margin-bottom: 24px; }
    .controls button {
      background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius);
      color: var(--text); padding: 6px 12px; cursor: pointer; font-size: 13px;
    }
    .controls button.active { border-color: var(--accent); color: var(--accent); }
    .card {
      background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius);
      padding: 16px; margin-bottom: 16px;
    }
    .card h2 { font-size: 14px; color: var(--text-dim); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; }
    th { text-align: left; padding: 6px 8px; color: var(--text-dim); border-bottom: 1px solid var(--border); }
    td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
    .num { text-align: right; }
    .error-rate { color: var(--red); }
    .low-error { color: var(--green); }
    svg { width: 100%; height: 200px; }
    .chart-line { fill: none; stroke-width: 1.5; }
    .line-avg { stroke: var(--accent); }
    .line-p95 { stroke: var(--orange); }
    .line-p99 { stroke: var(--red); }
    .legend { display: flex; gap: 16px; margin-top: 8px; font-size: 12px; color: var(--text-dim); }
    .legend span::before { content: ''; display: inline-block; width: 12px; height: 2px; margin-right: 4px; vertical-align: middle; }
    .legend .l-avg::before { background: var(--accent); }
    .legend .l-p95::before { background: var(--orange); }
    .legend .l-p99::before { background: var(--red); }
    .empty { color: var(--text-dim); text-align: center; padding: 40px; }
  </style>
</head>
<body>
  <h1>Turbine Observe</h1>
  <p class="subtitle">Query performance metrics</p>
  <div class="controls">
    <button data-range="1h" class="active">1h</button>
    <button data-range="6h">6h</button>
    <button data-range="24h">24h</button>
    <button data-range="7d">7d</button>
  </div>
  <div class="card" id="latency-card">
    <h2>Latency over time</h2>
    <div id="chart"></div>
    <div class="legend">
      <span class="l-avg">avg</span>
      <span class="l-p95">p95</span>
      <span class="l-p99">p99</span>
    </div>
  </div>
  <div class="card" id="models-card">
    <h2>Top models</h2>
    <div id="models-table"></div>
  </div>
  <div class="card" id="errors-card">
    <h2>Error rates</h2>
    <div id="errors-table"></div>
  </div>
  <script>
    let currentRange = '1h';
    const token = document.cookie.match(/turbine_observe_token=([a-f0-9]+)/)?.[1] || '';
    const headers = { 'x-turbine-token': token };

    document.querySelector('.controls').addEventListener('click', e => {
      if (e.target.tagName !== 'BUTTON') return;
      document.querySelectorAll('.controls button').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentRange = e.target.dataset.range;
      refresh();
    });

    async function fetchJson(path) {
      const res = await fetch(path, { headers });
      if (!res.ok) return null;
      return res.json();
    }

    function buildSvgPath(points, width, height, maxY) {
      if (points.length === 0) return '';
      const xStep = width / Math.max(points.length - 1, 1);
      return points.map((y, i) => {
        const px = i * xStep;
        const py = height - (y / maxY) * height;
        return (i === 0 ? 'M' : 'L') + px.toFixed(1) + ',' + py.toFixed(1);
      }).join(' ');
    }

    function renderChart(data) {
      const el = document.getElementById('chart');
      if (!data || data.length === 0) { el.innerHTML = '<p class="empty">No data yet</p>'; return; }
      const width = 800; const height = 180;
      const allVals = data.flatMap(d => [d.avg_ms, d.p95_ms, d.p99_ms]);
      const maxY = Math.max(...allVals, 1) * 1.1;
      const avgPath = buildSvgPath(data.map(d => d.avg_ms), width, height, maxY);
      const p95Path = buildSvgPath(data.map(d => d.p95_ms), width, height, maxY);
      const p99Path = buildSvgPath(data.map(d => d.p99_ms), width, height, maxY);
      el.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">'
        + '<path class="chart-line line-avg" d="' + avgPath + '"/>'
        + '<path class="chart-line line-p95" d="' + p95Path + '"/>'
        + '<path class="chart-line line-p99" d="' + p99Path + '"/>'
        + '</svg>';
    }

    function escapeHtml(s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function renderModels(data) {
      const el = document.getElementById('models-table');
      if (!data || data.length === 0) { el.innerHTML = '<p class="empty">No data yet</p>'; return; }
      let html = '<table><thead><tr><th>Model</th><th>Action</th><th class="num">Count</th><th class="num">Avg (ms)</th><th class="num">P95 (ms)</th><th class="num">P99 (ms)</th></tr></thead><tbody>';
      for (const row of data) {
        html += '<tr><td>' + escapeHtml(row.model) + '</td><td>' + escapeHtml(row.action) + '</td>'
          + '<td class="num">' + row.count + '</td>'
          + '<td class="num">' + row.avg_ms.toFixed(1) + '</td>'
          + '<td class="num">' + row.p95_ms.toFixed(1) + '</td>'
          + '<td class="num">' + row.p99_ms.toFixed(1) + '</td></tr>';
      }
      html += '</tbody></table>';
      el.innerHTML = html;
    }

    function renderErrors(data) {
      const el = document.getElementById('errors-table');
      if (!data || data.length === 0) { el.innerHTML = '<p class="empty">No errors</p>'; return; }
      let html = '<table><thead><tr><th>Model</th><th>Action</th><th class="num">Total</th><th class="num">Errors</th><th class="num">Rate</th></tr></thead><tbody>';
      for (const row of data) {
        const rate = row.count > 0 ? (row.error_count / row.count * 100).toFixed(1) : '0.0';
        const cls = parseFloat(rate) > 5 ? 'error-rate' : 'low-error';
        html += '<tr><td>' + escapeHtml(row.model) + '</td><td>' + escapeHtml(row.action) + '</td>'
          + '<td class="num">' + row.count + '</td>'
          + '<td class="num">' + row.error_count + '</td>'
          + '<td class="num ' + cls + '">' + rate + '%</td></tr>';
      }
      html += '</tbody></table>';
      el.innerHTML = html;
    }

    async function refresh() {
      const [latency, models] = await Promise.all([
        fetchJson('/api/latency?range=' + currentRange),
        fetchJson('/api/models?range=' + currentRange),
      ]);
      renderChart(latency);
      renderModels(models);
      // Derive errors from models data
      const withErrors = (models || []).filter(m => m.error_count > 0);
      renderErrors(withErrors);
    }

    refresh();
    setInterval(refresh, 60000);
  </script>
</body>
</html>`;
