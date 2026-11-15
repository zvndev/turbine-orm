import { ConnectionError } from './errors.js';

function unavailable() {
  throw new ConnectionError('PostgreSQL requires the optional pg peer in this optional package build. Install pg@^8.15.0 alongside turbine-orm, or use a non-PostgreSQL entry.');
}
class Unavailable {
  constructor() { unavailable(); }
}
export default {
  Pool: Unavailable, Client: Unavailable, Result: Unavailable,
  utils: { prepareValue: unavailable },
  types: { getTypeParser: unavailable, setTypeParser: unavailable, arrayParser: { create: unavailable } },
};
