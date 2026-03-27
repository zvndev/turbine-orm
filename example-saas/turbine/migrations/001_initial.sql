-- 001_initial.sql
-- Project management SaaS schema

-- Teams
CREATE TABLE teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  plan TEXT DEFAULT 'free',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Members
CREATE TABLE members (
  id SERIAL PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  avatar_url TEXT,
  joined_at TIMESTAMPTZ DEFAULT NOW()
);

-- Projects
CREATE TABLE projects (
  id SERIAL PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',
  lead_id INTEGER REFERENCES members(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tasks
CREATE TABLE tasks (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  assignee_id INTEGER REFERENCES members(id),
  creator_id INTEGER REFERENCES members(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'todo',
  priority TEXT DEFAULT 'medium',
  labels TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  due_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Comments
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id),
  author_id INTEGER REFERENCES members(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_members_team ON members(team_id);
CREATE INDEX idx_members_email ON members(email);
CREATE INDEX idx_projects_team ON projects(team_id);
CREATE INDEX idx_projects_lead ON projects(lead_id);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX idx_tasks_creator ON tasks(creator_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_priority ON tasks(priority);
CREATE INDEX idx_tasks_labels ON tasks USING GIN(labels);
CREATE INDEX idx_tasks_metadata ON tasks USING GIN(metadata);
CREATE INDEX idx_comments_task ON comments(task_id);
CREATE INDEX idx_comments_author ON comments(author_id);
