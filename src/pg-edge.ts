/**
 * turbine-orm, the stand-in for `pg` on runtimes that cannot run it.
 *
 * The modules the serverless entry shares with the main entry import the
 * driver as `#pg`, a package.json `imports` alias. It resolves to the real `pg`
 * everywhere except under the `edge-light` and `browser` conditions (Vercel
 * Edge, Next.js edge routes, browser bundles), where it resolves to this file.
 * Those runtimes have no TCP sockets and no `fs`, `net` or `tls`, so bundling
 * `pg` there fails the build outright, although `turbineHttp()` never opens a
 * pg connection. `workerd` keeps the real driver: `pg` supports Cloudflare
 * Workers, and a Hyperdrive user may let Turbine open the pool.
 *
 * What the shared code touches on a caller-supplied pool:
 *   - `types.getTypeParser`, when a relation's JSON column is decoded with the
 *     driver's text parser. The identity parser here leaves the JSON wire text
 *     as it arrived (a `date` inside a relation stays a string), which is also
 *     what an HTTP driver that ships its own type parsers would disagree with
 *     least.
 *   - nothing else: parser registration, `new pg.Pool` and the pipeline wire
 *     protocol only run when Turbine owns a TCP pool, and on this runtime that
 *     is the error below instead of an unresolvable import.
 */

import { ConnectionError } from './errors.js';

function unavailable(): never {
  throw new ConnectionError(
    'turbine-orm cannot open its own Postgres connection in this runtime: it has no TCP driver. ' +
      'Pass a pg-compatible pool instead of a connection string, e.g. turbineHttp(pool, schema) from turbine-orm/serverless.',
  );
}

class Unavailable {
  constructor() {
    unavailable();
  }
}

const identity = (value: string): string => value;

const pg = {
  Pool: Unavailable,
  Client: Unavailable,
  Result: Unavailable,
  utils: { prepareValue: unavailable },
  types: {
    getTypeParser: () => identity,
    setTypeParser: (): void => {},
    arrayParser: { create: unavailable },
  },
};

export default pg;
