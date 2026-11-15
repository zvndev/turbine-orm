-- Relation shapes: self-referencing tree, two FKs to one table, an FK to a unique non-PK
-- column, composite FKs, unique-FK one-to-one, a pure junction, a junction with payload,
-- and a junction keyed only by a partial unique index.
-- Fixture for src/test/real-world-schemas.integration.test.ts; loaded into its own database.
CREATE TABLE categories (id serial PRIMARY KEY, name text NOT NULL UNIQUE, parent_id int REFERENCES categories(id));
CREATE TABLE countries (code char(2) PRIMARY KEY, name text NOT NULL);
CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL UNIQUE, ssn text UNIQUE, name text);
CREATE TABLE profiles (id serial PRIMARY KEY, user_id int NOT NULL UNIQUE REFERENCES users(id), bio text);
-- FK to a unique non-PK column (email)
CREATE TABLE invitations (id serial PRIMARY KEY, invitee_email text REFERENCES users(email), invited_by_id int REFERENCES users(id), accepted boolean NOT NULL DEFAULT false);
-- two FKs to the same table (sender/recipient), self-pair
CREATE TABLE messages (id serial PRIMARY KEY, sender_id int NOT NULL REFERENCES users(id), recipient_id int NOT NULL REFERENCES users(id), body text, reply_to_id int REFERENCES messages(id));
-- composite PK parent + composite FK child
CREATE TABLE league_teams (league text NOT NULL, team text NOT NULL, city text, PRIMARY KEY (league, team));
CREATE TABLE matches (id serial PRIMARY KEY, home_league text NOT NULL, home_team text NOT NULL, away_league text NOT NULL, away_team text NOT NULL,
  played_on date,
  FOREIGN KEY (home_league, home_team) REFERENCES league_teams(league, team),
  FOREIGN KEY (away_league, away_team) REFERENCES league_teams(league, team));
-- junction with extra columns (not a pure m2m)
CREATE TABLE courses (id serial PRIMARY KEY, code text NOT NULL UNIQUE, title text);
CREATE TABLE students (id serial PRIMARY KEY, name text NOT NULL);
CREATE TABLE enrollments (student_id int NOT NULL REFERENCES students(id), course_id int NOT NULL REFERENCES courses(id),
  grade text, enrolled_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (student_id, course_id));
-- pure m2m junction (PK is exactly the two FKs)
CREATE TABLE tags (id serial PRIMARY KEY, name text NOT NULL UNIQUE);
CREATE TABLE user_tags (user_id int NOT NULL REFERENCES users(id), tag_id int NOT NULL REFERENCES tags(id), PRIMARY KEY (user_id, tag_id));
-- junction keyed only by a unique index (has its own surrogate PK): engines disagree per changelog, PG view recorded
CREATE TABLE follows (id serial PRIMARY KEY, follower_id int NOT NULL REFERENCES users(id), followee_id int NOT NULL REFERENCES users(id));
CREATE UNIQUE INDEX follows_pair_key ON follows (follower_id, followee_id);
-- two unique FKs to same target (couple partner_a/partner_b from changelog)
CREATE TABLE couples (id serial PRIMARY KEY, partner_a_id int NOT NULL UNIQUE REFERENCES users(id), partner_b_id int NOT NULL UNIQUE REFERENCES users(id));
-- junction-shaped table (exactly two FK columns) keyed only by a PARTIAL unique index:
-- a partial unique does not make the pair unique table-wide, so this must NOT be read as
-- a many-to-many junction between users and tags.
CREATE TABLE flag_links (user_id int NOT NULL REFERENCES users(id), tag_id int NOT NULL REFERENCES tags(id));
CREATE UNIQUE INDEX flag_links_pair_partial_key ON flag_links (user_id, tag_id) WHERE tag_id > 0;
-- FK column that is itself the PK (shared-PK one-to-one)
CREATE TABLE user_settings (user_id int PRIMARY KEY REFERENCES users(id), theme text NOT NULL DEFAULT 'light');
INSERT INTO categories (name,parent_id) VALUES ('root',NULL),('child',1),('grandchild',2),('sibling',1);
INSERT INTO countries VALUES ('US','United States'),('FR','France');
INSERT INTO users (email,ssn,name) VALUES ('ada@example.com','111','Ada'),('grace@example.com','222','Grace'),('linus@example.com',NULL,'Linus');
INSERT INTO profiles (user_id,bio) VALUES (1,'bio a'),(2,'bio g');
INSERT INTO invitations (invitee_email,invited_by_id) VALUES ('linus@example.com',1);
INSERT INTO messages (sender_id,recipient_id,body) VALUES (1,2,'hi'),(2,1,'hello back');
UPDATE messages SET reply_to_id = 1 WHERE id = 2;
INSERT INTO league_teams VALUES ('premier','Arsenal','London'),('premier','Chelsea','London'),('liga','Barca','Barcelona');
INSERT INTO matches (home_league,home_team,away_league,away_team,played_on) VALUES ('premier','Arsenal','premier','Chelsea','2026-01-03');
INSERT INTO courses (code,title) VALUES ('CS101','Intro'),('CS201','Data');
INSERT INTO students (name) VALUES ('Sam'),('Jo');
INSERT INTO enrollments (student_id,course_id,grade) VALUES (1,1,'A'),(1,2,'B'),(2,1,NULL);
INSERT INTO tags (name) VALUES ('admin'),('beta');
INSERT INTO user_tags VALUES (1,1),(1,2),(2,2);
INSERT INTO follows (follower_id,followee_id) VALUES (1,2),(2,1),(3,1);
INSERT INTO couples (partner_a_id,partner_b_id) VALUES (1,2);
INSERT INTO user_settings (user_id,theme) VALUES (1,'dark');
INSERT INTO flag_links VALUES (2,1),(3,2);
