/**
 * SQL function rules (ADR 0005 amended, design review S5): an allowlist. Only SQLite's
 * own functions pass; a function the app registers is always refused.
 *
 * Source: sqlite.org, checked 16 Oct 2026 against the bundled SQLite 3.53.4:
 * lang_corefunc.html (core), lang_aggfunc.html (aggregate), windowfunctions.html
 * (window), lang_datefunc.html (date and time), lang_mathfunc.html (math),
 * json1.html (JSON), fts5.html (MATCH and the auxiliary functions). soundex is left
 * out: it exists only in builds with SQLITE_SOUNDEX. functions.test.ts checks every
 * name against the bundled build's pragma_function_list.
 */

const CORE = [
  'abs',
  'changes',
  'char',
  'coalesce',
  'concat',
  'concat_ws',
  'format',
  'glob',
  'hex',
  'if',
  'ifnull',
  'iif',
  'instr',
  'last_insert_rowid',
  'length',
  'like',
  'likelihood',
  'likely',
  'lower',
  'ltrim',
  'max',
  'min',
  'nullif',
  'octet_length',
  'printf',
  'quote',
  'random',
  // randomblob and zeroblob can build large values; the backends cap result sizes (S2).
  'randomblob',
  'replace',
  'round',
  'rtrim',
  'sign',
  'sqlite_compileoption_get',
  'sqlite_compileoption_used',
  'sqlite_offset',
  'sqlite_source_id',
  'sqlite_version',
  'substr',
  'substring',
  'total_changes',
  'trim',
  'typeof',
  'unhex',
  'unicode',
  'unistr',
  'unistr_quote',
  'unlikely',
  'upper',
  'zeroblob',
];

const AGGREGATE = [
  'avg',
  'count',
  'group_concat',
  'median',
  'percentile',
  'percentile_cont',
  'percentile_disc',
  'string_agg',
  'sum',
  'total',
];

const WINDOW = [
  'row_number',
  'rank',
  'dense_rank',
  'percent_rank',
  'cume_dist',
  'ntile',
  'lag',
  'lead',
  'first_value',
  'last_value',
  'nth_value',
];

const DATE_TIME = ['date', 'time', 'datetime', 'julianday', 'unixepoch', 'strftime', 'timediff'];

const MATH = [
  'acos',
  'acosh',
  'asin',
  'asinh',
  'atan',
  'atan2',
  'atanh',
  'ceil',
  'ceiling',
  'cos',
  'cosh',
  'degrees',
  'exp',
  'floor',
  'ln',
  'log',
  'log10',
  'log2',
  'mod',
  'pi',
  'pow',
  'power',
  'radians',
  'sin',
  'sinh',
  'sqrt',
  'tan',
  'tanh',
  'trunc',
];

const JSON_FUNCTIONS = [
  'json',
  'jsonb',
  'json_array',
  'jsonb_array',
  'json_array_insert',
  'jsonb_array_insert',
  'json_array_length',
  'json_error_position',
  'json_extract',
  'jsonb_extract',
  'json_insert',
  'jsonb_insert',
  'json_object',
  'jsonb_object',
  'json_patch',
  'jsonb_patch',
  'json_pretty',
  'json_quote',
  'json_remove',
  'jsonb_remove',
  'json_replace',
  'jsonb_replace',
  'json_set',
  'jsonb_set',
  'json_type',
  'json_valid',
  'json_group_array',
  'jsonb_group_array',
  'json_group_object',
  'jsonb_group_object',
  // The -> and ->> operators.
  '->',
  '->>',
];

/** FTS5: `x MATCH y` calls `match`; bm25, highlight and snippet are its auxiliaries. */
const FTS5 = ['match', 'bm25', 'highlight', 'snippet'];

export const BUILTIN_FUNCTIONS: ReadonlySet<string> = new Set([
  ...CORE,
  ...AGGREGATE,
  ...WINDOW,
  ...DATE_TIME,
  ...MATH,
  ...JSON_FUNCTIONS,
  ...FTS5,
]);

/**
 * Named in refusals so the reason is clear: loading code, file access (the sqlite3
 * shell's fileio extension), and fts3_tokenizer, which hands out pointers. None is in
 * the allowlist; this set is a second line, not the rule.
 */
export const DENIED_FUNCTIONS: ReadonlySet<string> = new Set([
  'load_extension',
  'readfile',
  'writefile',
  'edit',
  'lsmode',
  'fsdir',
  'zipfile',
  'sqlar_compress',
  'sqlar_uncompress',
  'fts3_tokenizer',
]);

/** Only these PRAGMAs are allowed, which read schema details and change nothing. */
export const READ_PRAGMAS: ReadonlySet<string> = new Set([
  'table_info',
  'table_xinfo',
  'index_list',
  'index_info',
  'foreign_key_list',
]);

/** Tables every database can read besides its own: the schema table and JSON walkers. */
export const BUILTIN_READABLE: ReadonlySet<string> = new Set([
  'sqlite_master',
  'sqlite_schema',
  'sqlite_temp_master',
  'sqlite_temp_schema',
  'json_each',
  'json_tree',
  'jsonb_each',
  'jsonb_tree',
  ...[...READ_PRAGMAS].map((p) => `pragma_${p}`),
]);

/** Built-in tables that leak more than rows (S8); named in the refusal. */
export const LEAKY_TABLES: ReadonlyMap<string, string> = new Map([
  ['sqlite_dbpage', 'it exposes raw database pages, including deleted data'],
  ['dbstat', 'it exposes page-level storage details'],
  ['sqlite_stmt', 'it exposes the SQL of other statements'],
]);
