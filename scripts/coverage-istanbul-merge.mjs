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
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const createReport = require('c8/lib/report.js');

/** Build a c8 Report whose process-coverage merge is a concatenation. */
export function createIstanbulMergeReport(options) {
  const report = createReport(options);

  report._getMergedProcessCov = function _getMergedProcessCov() {
    const processCovs = [];
    const fileIndex = new Set();
    for (const processCov of this._loadReports()) {
      if (!this._isCoverageObject(processCov)) continue;
      if (processCov['source-map-cache']) {
        Object.assign(this.sourceMapCache, this._normalizeSourceMapCache(processCov['source-map-cache']));
      }
      processCovs.push(this._normalizeProcessCov(processCov, fileIndex));
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
