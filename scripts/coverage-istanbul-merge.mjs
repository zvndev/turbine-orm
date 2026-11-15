/**
 * c8 report, with the V8-level merge replaced by an istanbul-level merge.
 *
 * WHY THIS EXISTS. c8 merges every process's V8 coverage into a single
 * ProcessCov (`mergeProcessCovs` from `@bcoe/v8-coverage`) BEFORE converting
 * anything to istanbul. That merge is not monotonic: adding a process's
 * coverage can LOWER the merged result. Measured on this repo's own suite,
 * `src/query/relations.ts`:
 *
 *   10 files -> 1565 lines covered      160 files -> 2918
 *   40 files -> 2216                    240 files -> 3043
 *   80 files -> 2495                    359 files -> 1333   <- the whole run
 *
 * The collapse is reproducible and traceable to a single added file, and the
 * mechanism is visible in the raw data: V8 compiles functions lazily, so a
 * process that merely imports a module reports a different function set for it
 * (110 functions in one process, 86 in another, same source file). Merging
 * range trees that disagree about the function set is where the counts are
 * lost. c8's own source carries a TODO about the merge implementation.
 *
 * A subset scoring higher than its superset is not a coverage number. It made
 * the repo's 75% line floor a gate on an artifact: relations.ts read 41.78%
 * across the full suite while a 448-test SUBSET of that same suite read 91.88%.
 *
 * THE FIX is to reorder, not to reimplement. c8 already converts each ScriptCov
 * to istanbul and merges those with `istanbul-lib-coverage`, whose merge is
 * additive and therefore monotonic by construction. Feeding it the per-process
 * ScriptCovs unmerged skips the lossy step and keeps every other c8 behaviour
 * (source maps, `all`, include/exclude, remapping, watermarks) exactly as
 * configured in .c8rc.json.
 *
 * The cost is real and is the reason this is a separate script rather than the
 * default: the conversion loop now runs once per (process x script) instead of
 * once per script, so it is slower and uses more memory. That is the correct
 * trade for a number a release gate reads.
 *
 * MEMORY. c8's `_loadReports()` parses every file in the temp directory into
 * one array before anything is filtered, and each raw file carries every
 * script the process loaded (node_modules, the test file itself) plus the
 * process's whole source-map cache. Measured 2026-10-13 on the full suite:
 * 1,505 files, 1.0 GB of JSON held at once, and the report step ran out of
 * heap at 4.4 GB, on CI and locally, after every test had passed. Reading one
 * file at a time and keeping only the scripts the config includes leaves the
 * result unchanged (the same ScriptCovs reach the same loop in the same
 * order) and lets each raw file be collected as soon as it is filtered. On
 * that same data it peaks at 1.3 GB, and the old loader, given a 24 GB heap,
 * peaked at 6.3 GB and wrote a byte-identical lcov.info and text report.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const createReport = require('c8/lib/report.js');

/**
 * Every process's coverage, parsed one file at a time. The same files, order
 * and skip rule as c8's `_loadReports()` (an unparseable file is skipped), but
 * a generator, so only one raw file is alive at a time.
 */
function* loadReportsOneByOne(tempDirectory) {
  const files = readdirSync(tempDirectory);
  if (files.some((file) => file.startsWith('.capture-'))) {
    throw new Error(`[coverage] unfinished attributed collection in ${tempDirectory}`);
  }
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(resolve(tempDirectory, file), 'utf8'));
    } catch {
      continue;
    }
    yield { file, parsed };
  }
}

/** Build a c8 Report whose process-coverage merge is a concatenation. */
export function createIstanbulMergeReport(options) {
  const report = createReport(options);
  const sourceMaps = new WeakMap();
  const scriptSources = new WeakMap();
  const uniqueSourceMaps = new Map();
  const getSourceMap = report._getSourceMap;

  // A URL identifies a module, not its generated text. Runtime loaders can
  // compile that module differently in different processes (e.g. with mock
  // instrumentation). Offsets and lineLengths belong to that process's map.
  // A global last-map-wins cache remaps earlier offsets through unrelated
  // generated text, inventing function locations and losing real hits.
  report._getSourceMap = function _getSourceMap(script) {
    if (scriptSources.has(script)) return scriptSources.get(script);
    if (!sourceMaps.has(script)) return getSourceMap.call(this, script);
    const url = pathToFileURL(script.url).href;
    return getSourceMap.call({ sourceMapCache: { [url]: sourceMaps.get(script) } }, script);
  };

  report._getMergedProcessCov = function _getMergedProcessCov() {
    const processCovs = [];
    const fileIndex = new Set();
    for (const { file, parsed: processCov } of loadReportsOneByOne(this.tempDirectory)) {
      if (!this._isCoverageObject(processCov)) continue;
      const cache = processCov['source-map-cache'] ?? {};
      const urls = new WeakMap();
      const identities = new Map();
      // c8 rewrites each ScriptCov URL to a filesystem path in place. Associate
      // its exact map first: ?query and #fragment identify distinct transforms,
      // including a genuinely unmapped transform of the same physical file.
      for (const script of processCov.result) {
        const url = script.url.startsWith('file:') ? script.url : pathToFileURL(script.url).href;
        urls.set(script, url);
        const ids = identities.get(url) ?? new Set();
        ids.add(script.scriptId);
        identities.set(url, ids);
        sourceMaps.set(script, cache[url]);
      }
      const normalized = this._normalizeProcessCov(processCov, fileIndex);
      for (const script of normalized.result) {
        const url = urls.get(script);
        const attribution = processCov['turbine-script-maps'];
        const captured = attribution?.version === 1 ? attribution.scripts?.[script.scriptId] : undefined;
        if (captured) {
          const extent = script.functions.reduce((end, fn) => fn.ranges.reduce((end, range) => Math.max(end, range.endOffset), end), 0);
          if (captured.url !== url || typeof captured.source !== 'string' || extent > captured.source.length
            || !Object.hasOwn(captured, 'sourceMap') || captured.error
            || (captured.sourceMap !== null && !captured.sourceMap?.data)) {
            throw new Error(`[coverage] invalid script attribution in ${file}: scriptId=${script.scriptId} ${url}`);
          }
          scriptSources.set(script, {
            source: captured.source,
            ...(captured.sourceMap ? { sourceMap: { sourcemap: captured.sourceMap.data } } : {}),
          });
        } else if (identities.get(url).size > 1) {
          // Node's cache is keyed by URL, so it contains at most the LAST map.
          // Even equal extents or identical function names cannot establish
          // which generated source/map belongs to an earlier scriptId. Throw
          // before c8's conversion loop, which otherwise swallows errors.
          throw new Error(`[coverage] ambiguous source-map attribution in ${file}: ${url} has scriptIds=${[...identities.get(url)].sort().join(',')}. Recollect with tooling/coverage-regressions/collect.mjs; the URL-keyed cache cannot recover these transforms.`);
        }
        let sourceMap = sourceMaps.get(script);
        if (sourceMap) {
          // Most processes use identical transforms. Share only exact-content
          // matches, including lineLengths, so retaining process-local maps
          // does not retain a copy of every source for every test process.
          const key = JSON.stringify(sourceMap);
          if (!uniqueSourceMaps.has(key)) uniqueSourceMaps.set(key, sourceMap);
          sourceMap = uniqueSourceMaps.get(key);
        }
        // Store absence as well: a script with no map must never inherit one
        // from another process that happened to load the same URL.
        sourceMaps.set(script, sourceMap);
      }
      processCovs.push(normalized);
    }
    // `all` synthesises zero-count entries for files no process loaded. It must
    // stay FIRST: the downstream istanbul merge is additive, so a zero entry is
    // a no-op wherever it lands, but keeping the order matches stock c8.
    if (this.all) {
      processCovs.unshift({ result: this._includeUncoveredFiles(fileIndex) });
    }
    // The one change: hand the loop every process's ScriptCovs unmerged, so the
    // additive istanbul merge does the combining instead of the V8 range-tree
    // merge. Every ScriptCov is converted independently and summed.
    return { result: processCovs.flatMap((cov) => cov.result) };
  };

  return report;
}
