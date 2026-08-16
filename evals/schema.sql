-- ---------------------------------------------------------------------------
-- Held-out eval schema: cheese affinage ledger.
--
-- This schema exists to be UNFAMILIAR. It is deliberately not the repo's test
-- fixture (src/test/fixtures/seed.sql), not the benchmark schema, and not a
-- recognisable public sample database. Table and column names are plausible
-- for the domain but specific enough that a model cannot answer a task by
-- recalling a well-known schema: it has to read the DDL or ask a tool.
--
-- Shape coverage, chosen so the task set can exercise the query surfaces an
-- agent actually gets wrong:
--   belongsTo / hasMany        guilds -> affineurs -> cheese_wheels -> ripening_checks
--   manyToMany via junction    cheese_wheels <-> cultures through wheel_cultures
--   compound unique            cheese_wheels (guild_id, batch_ref)
--   jsonb columns              affineurs.credential_blob, cheese_wheels.tasting_notes
--   nullable columns           affineurs.retired_at, ripening_checks.remark
--
-- Two naming constraints are deliberate, because getting them wrong would have
-- made the result meaningless rather than merely awkward:
--
--   1. wheel_cultures carries NO payload column. Turbine only derives a
--      manyToMany relation for a junction whose columns are exactly the two
--      foreign keys (see addAutoManyToManyRelations in src/introspect.ts); an
--      extra column silently demotes it to two hasMany hops, and the m2m task
--      would then have been unanswerable in every arm.
--   2. Every table name singularises cleanly. An earlier draft called this
--      table wheel_batches, which Turbine's singulariser turns into the
--      relation name "wheelBatche". No model can guess that, and only a tool
--      can report it, so tasks traversing it would have manufactured an
--      arm C win that says nothing about whether the tools genuinely help.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS wheel_cultures CASCADE;
DROP TABLE IF EXISTS ripening_checks CASCADE;
DROP TABLE IF EXISTS cheese_wheels CASCADE;
DROP TABLE IF EXISTS affineurs CASCADE;
DROP TABLE IF EXISTS cultures CASCADE;
DROP TABLE IF EXISTS guilds CASCADE;

CREATE TABLE guilds (
  id            serial PRIMARY KEY,
  guild_name    text NOT NULL UNIQUE,
  canton_code   text NOT NULL,
  founded_year  integer NOT NULL
);

CREATE TABLE affineurs (
  id                 serial PRIMARY KEY,
  ledger_handle      text NOT NULL UNIQUE,
  given_name         text NOT NULL,
  guild_id           integer NOT NULL REFERENCES guilds(id),
  tenure_started_on  date NOT NULL,
  is_journeyman      boolean NOT NULL DEFAULT false,
  credential_blob    jsonb,
  retired_at         timestamptz
);

CREATE TABLE cultures (
  id              serial PRIMARY KEY,
  culture_code    text NOT NULL UNIQUE,
  genus           text NOT NULL,
  is_thermophilic boolean NOT NULL DEFAULT false
);

CREATE TABLE cheese_wheels (
  id                 serial PRIMARY KEY,
  batch_ref          text NOT NULL,
  affineur_id        integer NOT NULL REFERENCES affineurs(id),
  guild_id           integer NOT NULL REFERENCES guilds(id),
  rind_style         text NOT NULL,
  cave_humidity_pct  integer NOT NULL,
  wheel_count        integer NOT NULL,
  pressed_on         date NOT NULL,
  status             text NOT NULL,
  tasting_notes      jsonb,
  CONSTRAINT cheese_wheels_guild_ref_key UNIQUE (guild_id, batch_ref)
);

CREATE TABLE ripening_checks (
  id               serial PRIMARY KEY,
  cheese_wheel_id  integer NOT NULL REFERENCES cheese_wheels(id),
  affineur_id      integer NOT NULL REFERENCES affineurs(id),
  checked_on       date NOT NULL,
  rind_score       integer NOT NULL,
  aroma_score      integer NOT NULL,
  remark           text
);

CREATE TABLE wheel_cultures (
  cheese_wheel_id  integer NOT NULL REFERENCES cheese_wheels(id),
  culture_id       integer NOT NULL REFERENCES cultures(id),
  PRIMARY KEY (cheese_wheel_id, culture_id)
);

CREATE INDEX idx_affineurs_guild_id ON affineurs(guild_id);
CREATE INDEX idx_cheese_wheels_affineur_id ON cheese_wheels(affineur_id);
CREATE INDEX idx_cheese_wheels_guild_id ON cheese_wheels(guild_id);
CREATE INDEX idx_ripening_checks_cheese_wheel_id ON ripening_checks(cheese_wheel_id);
CREATE INDEX idx_ripening_checks_affineur_id ON ripening_checks(affineur_id);
CREATE INDEX idx_wheel_cultures_culture_id ON wheel_cultures(culture_id);
