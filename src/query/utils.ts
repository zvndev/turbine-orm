/** PostgreSQL compatibility exports. The query engine uses query-utils. */
import pg from '#pg';
import { registerQueryDriver } from '../query-utils.js';

registerQueryDriver(pg as unknown as Parameters<typeof registerQueryDriver>[0]);

export * from '../query-utils.js';
export {
  createPgArrayParser,
  isDefaultTextParser,
  markTurbineParser,
  registerUtcTemporalParsers,
  warnParserOverwrite,
} from './pg-type-parsers.js';
