-- Django shape: auth_* tables, django_content_type, varchar_pattern_ops (_like) indexes,
-- DEFERRABLE INITIALLY DEFERRED foreign keys, surrogate-keyed link tables.
-- Fixture for src/test/real-world-schemas.integration.test.ts; loaded into its own database.
CREATE TABLE django_content_type (id serial PRIMARY KEY, app_label varchar(100) NOT NULL, model varchar(100) NOT NULL,
  CONSTRAINT django_content_type_app_label_model_key UNIQUE (app_label, model));
CREATE TABLE auth_permission (id serial PRIMARY KEY, name varchar(255) NOT NULL, content_type_id int NOT NULL REFERENCES django_content_type(id) DEFERRABLE INITIALLY DEFERRED,
  codename varchar(100) NOT NULL, CONSTRAINT auth_permission_content_type_id_codename_key UNIQUE (content_type_id, codename));
CREATE TABLE auth_group (id serial PRIMARY KEY, name varchar(150) NOT NULL UNIQUE);
CREATE INDEX auth_group_name_like ON auth_group (name varchar_pattern_ops);
CREATE TABLE auth_group_permissions (id bigserial PRIMARY KEY, group_id int NOT NULL REFERENCES auth_group(id) DEFERRABLE INITIALLY DEFERRED,
  permission_id int NOT NULL REFERENCES auth_permission(id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT auth_group_permissions_group_id_permission_id_key UNIQUE (group_id, permission_id));
CREATE TABLE auth_user (id serial PRIMARY KEY, password varchar(128) NOT NULL, last_login timestamptz, is_superuser boolean NOT NULL,
  username varchar(150) NOT NULL UNIQUE, first_name varchar(150) NOT NULL, last_name varchar(150) NOT NULL, email varchar(254) NOT NULL,
  is_staff boolean NOT NULL, is_active boolean NOT NULL, date_joined timestamptz NOT NULL);
CREATE INDEX auth_user_username_like ON auth_user (username varchar_pattern_ops);
CREATE TABLE auth_user_groups (id bigserial PRIMARY KEY, user_id int NOT NULL REFERENCES auth_user(id) DEFERRABLE INITIALLY DEFERRED,
  group_id int NOT NULL REFERENCES auth_group(id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT auth_user_groups_user_id_group_id_key UNIQUE (user_id, group_id));
CREATE TABLE auth_user_user_permissions (id bigserial PRIMARY KEY, user_id int NOT NULL REFERENCES auth_user(id) DEFERRABLE INITIALLY DEFERRED,
  permission_id int NOT NULL REFERENCES auth_permission(id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT auth_user_user_permissions_user_id_permission_id_key UNIQUE (user_id, permission_id));
CREATE TABLE django_session (session_key varchar(40) PRIMARY KEY, session_data text NOT NULL, expire_date timestamptz NOT NULL);
CREATE INDEX django_session_expire_date_idx ON django_session(expire_date);
CREATE TABLE django_migrations (id bigserial PRIMARY KEY, app varchar(255) NOT NULL, name varchar(255) NOT NULL, applied timestamptz NOT NULL);
-- app tables: blog with GenericFK-ish + slug unique-for-date
CREATE TABLE blog_post (id bigserial PRIMARY KEY, title varchar(200) NOT NULL, slug varchar(50) NOT NULL, author_id int NOT NULL REFERENCES auth_user(id) DEFERRABLE INITIALLY DEFERRED,
  publish date NOT NULL, body text NOT NULL, status varchar(10) NOT NULL DEFAULT 'draft',
  CONSTRAINT blog_post_slug_publish_key UNIQUE (slug, publish));
CREATE INDEX blog_post_slug_like ON blog_post (slug varchar_pattern_ops);
INSERT INTO django_content_type (app_label,model) VALUES ('auth','user'),('blog','post');
INSERT INTO auth_permission (name,content_type_id,codename) VALUES ('Can add post',2,'add_post'),('Can change post',2,'change_post');
INSERT INTO auth_group (name) VALUES ('editors'),('authors');
INSERT INTO auth_group_permissions (group_id,permission_id) VALUES (1,1),(1,2);
INSERT INTO auth_user (password,is_superuser,username,first_name,last_name,email,is_staff,is_active,date_joined) VALUES ('pbkdf2$hash',true,'admin','Ad','Min','admin@example.com',true,true,now()),('pbkdf2$hash2',false,'alice','Alice','A','alice@example.com',false,true,now());
INSERT INTO auth_user_groups (user_id,group_id) VALUES (2,2);
INSERT INTO auth_user_user_permissions (user_id,permission_id) VALUES (2,1);
INSERT INTO django_session VALUES ('sesskey0000000000000000000000001','data','2027-01-01T00:00Z');
INSERT INTO django_migrations (app,name,applied) VALUES ('blog','0001_initial',now());
INSERT INTO blog_post (title,slug,author_id,publish,body) VALUES ('Hello','hello',2,'2026-01-01','body text'),('Second','hello',1,'2026-01-02','same slug, other date');
