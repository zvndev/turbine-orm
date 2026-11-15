-- Prisma Migrate output shape: PascalCase quoted identifiers, _prisma_migrations,
-- implicit many-to-many junction _CategoryToPost with a unique (A, B) index, compound uniques.
-- Fixture for src/test/real-world-schemas.integration.test.ts; loaded into its own database.
CREATE TYPE "Role" AS ENUM ('USER','ADMIN');
CREATE TABLE "_prisma_migrations" (id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
  migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count int NOT NULL DEFAULT 0);
CREATE TABLE "User" (id serial PRIMARY KEY, email text NOT NULL, name text, role "Role" NOT NULL DEFAULT 'USER', "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX "User_email_key" ON "User"(email);
CREATE TABLE "Profile" (id serial PRIMARY KEY, bio text, "userId" int NOT NULL UNIQUE REFERENCES "User"(id) ON DELETE CASCADE);
CREATE TABLE "Post" (id serial PRIMARY KEY, title text NOT NULL, content text, published boolean NOT NULL DEFAULT false,
  "authorId" int NOT NULL REFERENCES "User"(id), "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX "Post_authorId_idx" ON "Post"("authorId");
CREATE TABLE "Category" (id serial PRIMARY KEY, name text NOT NULL UNIQUE);
CREATE TABLE "_CategoryToPost" ("A" int NOT NULL REFERENCES "Category"(id) ON DELETE CASCADE, "B" int NOT NULL REFERENCES "Post"(id) ON DELETE CASCADE);
CREATE UNIQUE INDEX "_CategoryToPost_AB_unique" ON "_CategoryToPost"("A","B");
CREATE INDEX "_CategoryToPost_B_index" ON "_CategoryToPost"("B");
-- @@unique([userId, postId]) compound
CREATE TABLE "Like" (id serial PRIMARY KEY, "userId" int NOT NULL REFERENCES "User"(id), "postId" int NOT NULL REFERENCES "Post"(id));
CREATE UNIQUE INDEX "Like_userId_postId_key" ON "Like"("userId","postId");
-- cuid-style text PK + @@id composite
CREATE TABLE "Session" (id text PRIMARY KEY, "sessionToken" text NOT NULL UNIQUE, "userId" int NOT NULL REFERENCES "User"(id), expires timestamptz NOT NULL);
CREATE TABLE "Account" ("provider" text NOT NULL, "providerAccountId" text NOT NULL, "userId" int NOT NULL REFERENCES "User"(id), PRIMARY KEY ("provider","providerAccountId"));
INSERT INTO "_prisma_migrations" (id,checksum,migration_name) VALUES ('01h00000000000000000000000','abc','20260101000000_init');
INSERT INTO "User" (email,name,role) VALUES ('alice@example.com','Alice','ADMIN'),('bob@example.com','Bob','USER');
INSERT INTO "Profile" (bio,"userId") VALUES ('hello',1);
INSERT INTO "Post" (title,published,"authorId") VALUES ('First post',true,1),('Draft',false,2);
INSERT INTO "Category" (name) VALUES ('Tech'),('Life');
INSERT INTO "_CategoryToPost" VALUES (1,1),(2,1),(1,2);
INSERT INTO "Like" ("userId","postId") VALUES (2,1),(1,2);
INSERT INTO "Session" VALUES ('sess_1','tok_1',1,'2027-01-01T00:00Z');
INSERT INTO "Account" VALUES ('github','gh_42',1);
