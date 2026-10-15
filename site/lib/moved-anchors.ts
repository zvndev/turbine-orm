/**
 * Sections that moved off /queries when it was split into task pages, keyed
 * by their old anchor. HashRedirect on /queries forwards an old deep link to
 * the section's new home.
 */
export const QUERIES_MOVED: Readonly<Record<string, string>> = {
  'filtering': '/filtering',
  'where-operators': '/filtering#where-operators',
  'misspelled-keys-are-a-compile-error': '/filtering#misspelled-keys-are-a-compile-error',
  'combinators': '/filtering#combinators',
  'undefined-means-absent': '/filtering#undefined-means-absent',
  'relation-filters': '/filtering#relation-filters',
  'array-columns': '/filtering#array-columns',
  'full-text-search': '/filtering#full-text-search',
  'json-columns': '/filtering#json-columns',
  'column-to-column-comparison': '/filtering#column-to-column-comparison',
  'ordering-and-pagination': '/filtering#ordering-and-pagination',
  'orderby': '/filtering#orderby',
  'ordering-by-a-relation': '/filtering#ordering-by-a-relation',
  'ordering-by-a-json-path': '/filtering#ordering-by-a-json-path',
  'ordering-by-a-value-from-one-related-row': '/filtering#ordering-by-a-value-from-one-related-row',
  'pagination-limit--take-offset--skip-cursor': '/filtering#pagination-limit--take-offset--skip-cursor',
  'deterministic-pages-the-unordered-pagination-warning': '/filtering#deterministic-pages-the-unordered-pagination-warning',
  'distinct': '/filtering#distinct',
  'aggregations': '/aggregations',
  'count': '/aggregations#count',
  'aggregate': '/aggregations#aggregate',
  'groupby': '/aggregations#groupby',
  'having': '/aggregations#having',
  'percentiles-_percentile': '/aggregations#percentiles-_percentile',
  'raw-sql': '/raw-sql',
  'typed-raw-sql-dbsqlt': '/raw-sql#typed-raw-sql-dbsqlt',
  'client-tools': '/client',
  'pipeline': '/transactions#pipeline-n-queries-1-round-trip',
  'transactions': '/transactions',
  'per-query-timeout': '/client#per-query-timeout',
  'middleware': '/client#middleware',
  'explain': '/client#explain',
  'client-configuration': '/client#client-configuration',
  'client-escape-hatches': '/client#client-escape-hatches',
};

/**
 * Sections that moved off /cli when `turbine doctor` got its own page. The
 * `turbine-doctor` anchor stays on /cli (a short pointer section), so only
 * the subsections are forwarded.
 */
export const CLI_MOVED: Readonly<Record<string, string>> = {
  'triage-tiers': '/doctor#triage-tiers',
  '--fix': '/doctor#--fix',
  '--unused-and---audit': '/doctor#--unused-and---audit',
  'cached-plan-divergence': '/doctor#cached-plan-divergence',
  '--json': '/doctor#--json',
  'runtime-warning': '/doctor#runtime-warning',
};
