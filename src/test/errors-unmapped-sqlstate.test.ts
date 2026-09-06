/**
 * `wrapPgError` and the SQLSTATEs it does not classify, under both message
 * modes.
 *
 * PostgreSQL puts the offending VALUE in the primary `message` of several very
 * ordinary error classes: `22P02 invalid input syntax for type integer:
 * "<the bound value>"`, `42601 syntax error in tsquery: "<the search term>"`.
 * `wrapPgError` used to return every SQLSTATE it did not classify unchanged, so
 * `where: { id: req.params.id }` with a non-numeric id put the request value
 * verbatim into the exception that goes to Sentry, in the mode whose entire job
 * is to prevent that.
 *
 * The errors here are pg-SHAPED objects (`{ code, message, detail, column,
 * severity }`, which is what node-postgres builds from the wire ErrorResponse);
 * no database is needed, and the value under test is a sentinel string so a
 * leak is a substring match rather than a judgement call.
 *
 * Run: npx tsx --test src/test/errors-unmapped-sqlstate.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import {
  getErrorMessageMode,
  REDACTED_DETAIL,
  runWithErrorMessageMode,
  setErrorMessageMode,
  TurbineError,
  UniqueConstraintError,
  ValidationError,
  wrapPgError,
} from '../errors.js';

const SECRET = 'SECRETVAL-7f3a9c';

type PgShaped = Error & {
  code: string;
  severity: string;
  detail?: string;
  column?: string;
  table?: string;
};

/**
 * A pg server error as node-postgres delivers it: a real Error whose `name` is
 * the lowercase 'error', with `severity` stamped by the protocol parser on every
 * ErrorResponse, plus whatever optional fields the server sent.
 */
function pgError(fields: {
  code: string;
  message: string;
  detail?: string;
  column?: string;
  table?: string;
}): PgShaped {
  const err = new Error(fields.message) as PgShaped;
  err.name = 'error';
  err.severity = 'ERROR';
  err.code = fields.code;
  if (fields.detail !== undefined) err.detail = fields.detail;
  if (fields.column !== undefined) err.column = fields.column;
  if (fields.table !== undefined) err.table = fields.table;
  return err;
}

function withMode<T>(mode: 'safe' | 'verbose', fn: () => T): T {
  const prev = getErrorMessageMode();
  setErrorMessageMode(mode);
  try {
    return fn();
  } finally {
    setErrorMessageMode(prev);
  }
}

/** The whole rendered error, cause chain and stacks included: how a log line sees it. */
function rendered(err: unknown): string {
  return inspect(err, { depth: 6 });
}

const DATA_EXCEPTIONS: Array<{ label: string; make: () => PgShaped; namesColumn?: string }> = [
  {
    label: 'enum literal (22P02)',
    make: () => pgError({ code: '22P02', message: `invalid input value for enum user_role: "${SECRET}"` }),
  },
  {
    label: 'integer text with a column (22P02)',
    make: () =>
      pgError({ code: '22P02', message: `invalid input syntax for type integer: "${SECRET}"`, column: 'age' }),
    namesColumn: 'age',
  },
  {
    label: 'numeric overflow (22003)',
    make: () => pgError({ code: '22003', message: `value "${SECRET}" is out of range for type integer` }),
  },
  {
    label: 'string too long (22001)',
    make: () =>
      pgError({ code: '22001', message: 'value too long for type character varying(3)', detail: `Value: "${SECRET}"` }),
  },
  {
    label: 'bad datetime (22007)',
    make: () => pgError({ code: '22007', message: `invalid input syntax for type timestamp: "${SECRET}"` }),
  },
  {
    label: 'division by zero (22012)',
    make: () => pgError({ code: '22012', message: 'division by zero' }),
  },
];

describe('wrapPgError, SQLSTATE class 22 (data exception) becomes ValidationError', () => {
  for (const { label, make, namesColumn } of DATA_EXCEPTIONS) {
    it(`${label}: safe mode keeps the bound value out of the message, the cause and the rendered error`, () => {
      withMode('safe', () => {
        const raw = make();
        const err = wrapPgError(raw);
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${rendered(err)}`);
        assert.equal(err.code, 'TURBINE_E003');
        assert.ok(err.message.includes(raw.code), `message names the SQLSTATE: ${err.message}`);
        assert.ok(!err.message.includes(SECRET), `bound value leaked into .message: ${err.message}`);
        assert.equal(err.sqlstate, raw.code);
        assert.equal(err.detail, REDACTED_DETAIL, 'the driver text is redacted on .detail in safe mode');
        const cause = err.cause as PgShaped;
        assert.equal(cause.code, raw.code, 'the SQLSTATE survives on the cause');
        assert.ok(!String(cause.message).includes(SECRET), `bound value leaked via .cause.message: ${cause.message}`);
        assert.ok(!rendered(err).includes(SECRET), `bound value leaked into the rendered error:\n${rendered(err)}`);
        if (namesColumn) {
          assert.ok(err.message.includes(`"${namesColumn}"`), `message names the column: ${err.message}`);
          assert.equal(err.column, namesColumn);
        }
      });
    });

    it(`${label}: verbose mode surfaces the driver text on the message, .detail and an untouched .cause`, () => {
      withMode('verbose', () => {
        const raw = make();
        const err = wrapPgError(raw);
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes(raw.message), `verbose message carries the driver text: ${err.message}`);
        assert.equal(err.detail, raw.message);
        assert.equal(err.cause, raw, 'verbose mode passes the driver error through by identity');
      });
    });
  }

  it('the driver object handed in is never mutated into a different message', () => {
    withMode('safe', () => {
      const raw = make22p02();
      wrapPgError(raw);
      assert.ok(
        raw.message.includes(SECRET),
        'the caller who holds the driver error still sees what the driver produced',
      );
    });
  });
});

function make22p02(): PgShaped {
  return pgError({ code: '22P02', message: `invalid input syntax for type integer: "${SECRET}"` });
}

describe('wrapPgError, 42601 from to_tsquery becomes ValidationError with a search hint', () => {
  const makeTsquery = () => pgError({ code: '42601', message: `syntax error in tsquery: "${SECRET}"` });

  it('safe mode: E003, names `search`, withholds the term everywhere', () => {
    withMode('safe', () => {
      const err = wrapPgError(makeTsquery());
      assert.ok(err instanceof ValidationError);
      assert.ok(/\bsearch\b/.test(err.message), `message points at the search operator: ${err.message}`);
      assert.ok(err.message.includes('42601'));
      assert.ok(!rendered(err).includes(SECRET), `search term leaked:\n${rendered(err)}`);
      assert.equal(err.detail, REDACTED_DETAIL);
    });
  });

  it('verbose mode: the driver text is on the message and .detail', () => {
    withMode('verbose', () => {
      const raw = makeTsquery();
      const err = wrapPgError(raw);
      assert.ok(err instanceof ValidationError);
      assert.ok(err.message.includes(SECRET));
      assert.equal(err.detail, raw.message);
      assert.equal(err.cause, raw);
    });
  });

  /**
   * 42601 is the carve-out from the value-free class-42 allowlist: PostgreSQL
   * quotes the offending TOKEN, and a token can be a string literal, so the
   * text is withheld here even though a sibling 42703 keeps its own.
   */
  it('a 42601 that is not about tsquery is not a ValidationError (it takes the generic path)', () => {
    withMode('safe', () => {
      const err = wrapPgError(pgError({ code: '42601', message: `syntax error at or near "${SECRET}"` }));
      assert.equal(err instanceof TurbineError, false);
      const message = (err as Error).message;
      assert.ok(message.startsWith('Database error 42601'), message);
      assert.ok(message.includes('driver text withheld'), `the message must say the text was withheld: ${message}`);
      assert.ok(!rendered(err).includes(SECRET), `token leaked:\n${rendered(err)}`);
    });
  });
});

describe('wrapPgError, any other unmapped SQLSTATE under safe mode', () => {
  const makeUnmapped = () =>
    pgError({
      code: '0A000',
      message: `cross-database references are not implemented: "${SECRET}"`,
      detail: `Hint ${SECRET}`,
    });

  it('safe mode: the message becomes `Database error <SQLSTATE>`, the SQLSTATE stays on .code, the original is on .cause', () => {
    withMode('safe', () => {
      const raw = makeUnmapped();
      const err = wrapPgError(raw) as PgShaped & { cause?: unknown };
      assert.notEqual(err, raw, 'safe mode must not hand the raw driver error back');
      assert.ok(err.message.startsWith('Database error 0A000'), err.message);
      assert.ok(
        err.message.includes('driver text withheld'),
        `the message must say the text was withheld: ${err.message}`,
      );
      assert.equal(err.code, '0A000', 'no new Turbine code is minted; the SQLSTATE is kept');
      assert.equal((err as { sqlstate?: string }).sqlstate, '0A000', 'the SQLSTATE is also carried under its own name');
      assert.equal(err instanceof TurbineError, false, 'an unclassified driver error is not a TurbineError');
      assert.ok(err instanceof Error, 'it is still a real error');
      assert.equal(Object.getPrototypeOf(err), Object.getPrototypeOf(raw), 'the driver prototype survives');
      assert.equal(err.detail, REDACTED_DETAIL);
      const cause = err.cause as PgShaped;
      assert.equal(cause.code, '0A000');
      assert.ok(!rendered(err).includes(SECRET), `value leaked into the rendered error:\n${rendered(err)}`);
      assert.ok(typeof err.stack === 'string' && !err.stack.includes(SECRET), 'the rendered stack is scrubbed too');
    });
  });

  it('verbose mode: the raw driver error passes through by identity', () => {
    withMode('verbose', () => {
      const raw = makeUnmapped();
      assert.equal(wrapPgError(raw), raw);
    });
  });

  it('respects the per-client AsyncLocalStorage scope over the process default', () => {
    withMode('verbose', () => {
      const raw = makeUnmapped();
      const scoped = runWithErrorMessageMode('safe', () => wrapPgError(raw));
      assert.notEqual(scoped, raw, 'a safe-scoped client wraps even when the process default is verbose');
      assert.ok((scoped as Error).message.startsWith('Database error 0A000'), (scoped as Error).message);
    });
    withMode('safe', () => {
      const raw = makeUnmapped();
      const scoped = runWithErrorMessageMode('verbose', () => wrapPgError(raw));
      assert.equal(scoped, raw, 'a verbose-scoped client passes through even when the process default is safe');
    });
  });

  it('the generic scrub applies to class 22 too when the mode is scoped safe', () => {
    withMode('verbose', () => {
      const err = runWithErrorMessageMode('safe', () => wrapPgError(make22p02()));
      assert.ok(err instanceof ValidationError);
      assert.ok(!err.message.includes(SECRET));
    });
  });
});

describe('wrapPgError, what the scrub must NOT touch', () => {
  it('a Node system error thrown inside a transaction callback passes through (five-letter code, no severity)', () => {
    withMode('safe', () => {
      const fsErr = Object.assign(new Error(`EPERM: operation not permitted, open '/etc/${SECRET}'`), {
        code: 'EPERM',
        errno: -1,
        syscall: 'open',
      });
      assert.equal(wrapPgError(fsErr), fsErr);
    });
  });

  it('an error with a SQLSTATE-shaped code but no pg severity passes through', () => {
    withMode('safe', () => {
      const err = Object.assign(new Error('weird'), { code: '99999' });
      assert.equal(wrapPgError(err), err);
    });
  });

  it('the constraint classes are still mapped first', () => {
    withMode('safe', () => {
      const err = wrapPgError(
        pgError({
          code: '23505',
          message: 'duplicate key value violates unique constraint "users_email_key"',
          detail: `Key (email)=(${SECRET}) already exists.`,
        }),
      );
      assert.ok(err instanceof UniqueConstraintError);
    });
  });

  it('null, undefined, primitives and code-less errors are returned as they were', () => {
    withMode('safe', () => {
      assert.equal(wrapPgError(null), null);
      assert.equal(wrapPgError(undefined), undefined);
      assert.equal(wrapPgError('oops'), 'oops');
      const plain = new Error('plain');
      assert.equal(wrapPgError(plain), plain);
    });
  });
});
