/**
 * Turbine schema definition for the project management SaaS.
 *
 * This defines the same schema as 001_initial.sql but in TypeScript,
 * used by `turbine generate` to produce typed client code.
 */

import { defineSchema } from 'turbine-orm';

export default defineSchema({
  teams: {
    id:        { type: 'serial', primaryKey: true },
    name:      { type: 'text', notNull: true },
    slug:      { type: 'text', unique: true, notNull: true },
    plan:      { type: 'text', default: "'free'" },
    createdAt: { type: 'timestamp', default: 'now()' },
  },

  members: {
    id:        { type: 'serial', primaryKey: true },
    teamId:    { type: 'integer', notNull: true, references: 'teams.id' },
    email:     { type: 'text', notNull: true },
    name:      { type: 'text', notNull: true },
    role:      { type: 'text', default: "'member'" },
    avatarUrl: { type: 'text' },
    joinedAt:  { type: 'timestamp', default: 'now()' },
  },

  projects: {
    id:          { type: 'serial', primaryKey: true },
    teamId:      { type: 'integer', notNull: true, references: 'teams.id' },
    name:        { type: 'text', notNull: true },
    description: { type: 'text' },
    status:      { type: 'text', default: "'active'" },
    leadId:      { type: 'integer', references: 'members.id' },
    createdAt:   { type: 'timestamp', default: 'now()' },
  },

  tasks: {
    id:          { type: 'serial', primaryKey: true },
    projectId:   { type: 'integer', notNull: true, references: 'projects.id' },
    assigneeId:  { type: 'integer', references: 'members.id' },
    creatorId:   { type: 'integer', references: 'members.id' },
    title:       { type: 'text', notNull: true },
    description: { type: 'text' },
    status:      { type: 'text', default: "'todo'" },
    priority:    { type: 'text', default: "'medium'" },
    // NOTE: Turbine's defineSchema doesn't support array or jsonb column types
    // with the shorthand 'text[]' syntax. You'd need raw SQL or use 'json' type.
    // This is a DX gap — schema definition can't express TEXT[] columns.
    // labels:   { type: 'text', ... } — no array support in defineSchema
    // metadata: { type: 'json' },  — this works for JSONB
    dueDate:     { type: 'timestamp' },
    createdAt:   { type: 'timestamp', default: 'now()' },
    updatedAt:   { type: 'timestamp', default: 'now()' },
  },

  comments: {
    id:        { type: 'serial', primaryKey: true },
    taskId:    { type: 'integer', notNull: true, references: 'tasks.id' },
    authorId:  { type: 'integer', references: 'members.id' },
    body:      { type: 'text', notNull: true },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
});
