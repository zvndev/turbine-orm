/**
 * Seed script for the project management SaaS.
 *
 * Creates 3 teams, 10 members, 5 projects, 50 tasks, and 100 comments
 * with realistic fake data. Uses Turbine's createMany for batch inserts.
 */

import { turbine } from '../src/generated/index.js';

const db = turbine({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/example_saas',
  logging: true,
});

async function seed() {
  console.log('Seeding database...\n');

  // === TEAMS ===
  const teams = await db.teams.createMany({
    data: [
      { name: 'Acme Engineering', slug: 'acme-eng', plan: 'pro' },
      { name: 'Widget Co', slug: 'widget-co', plan: 'free' },
      { name: 'Startup Labs', slug: 'startup-labs', plan: 'enterprise' },
    ],
  });
  console.log(`Created ${teams.length} teams`);

  // === MEMBERS ===
  const memberData = [
    { teamId: teams[0]!.id, email: 'alice@acme.dev', name: 'Alice Chen', role: 'admin', avatarUrl: 'https://i.pravatar.cc/150?u=alice' },
    { teamId: teams[0]!.id, email: 'bob@acme.dev', name: 'Bob Martinez', role: 'member', avatarUrl: 'https://i.pravatar.cc/150?u=bob' },
    { teamId: teams[0]!.id, email: 'carol@acme.dev', name: 'Carol Kim', role: 'member', avatarUrl: 'https://i.pravatar.cc/150?u=carol' },
    { teamId: teams[0]!.id, email: 'dan@acme.dev', name: 'Dan Okafor', role: 'member', avatarUrl: null },
    { teamId: teams[1]!.id, email: 'eve@widget.co', name: 'Eve Nakamura', role: 'admin', avatarUrl: 'https://i.pravatar.cc/150?u=eve' },
    { teamId: teams[1]!.id, email: 'frank@widget.co', name: 'Frank Torres', role: 'member', avatarUrl: null },
    { teamId: teams[1]!.id, email: 'grace@widget.co', name: 'Grace Patel', role: 'member', avatarUrl: 'https://i.pravatar.cc/150?u=grace' },
    { teamId: teams[2]!.id, email: 'hank@startuplabs.io', name: 'Hank Johansson', role: 'admin', avatarUrl: 'https://i.pravatar.cc/150?u=hank' },
    { teamId: teams[2]!.id, email: 'iris@startuplabs.io', name: 'Iris Nguyen', role: 'member', avatarUrl: 'https://i.pravatar.cc/150?u=iris' },
    { teamId: teams[2]!.id, email: 'jake@startuplabs.io', name: 'Jake Williams', role: 'member', avatarUrl: null },
  ];
  const members = await db.members.createMany({ data: memberData });
  console.log(`Created ${members.length} members`);

  // === PROJECTS ===
  const projectData = [
    { teamId: teams[0]!.id, name: 'API Redesign', description: 'Migrate REST API to GraphQL with Turbine backend', status: 'active', leadId: members[0]!.id },
    { teamId: teams[0]!.id, name: 'Mobile App v2', description: 'React Native rewrite of the mobile app', status: 'active', leadId: members[1]!.id },
    { teamId: teams[1]!.id, name: 'Dashboard', description: 'Analytics dashboard for customer metrics', status: 'active', leadId: members[4]!.id },
    { teamId: teams[1]!.id, name: 'Infrastructure', description: 'Kubernetes migration and CI/CD setup', status: 'paused', leadId: members[5]!.id },
    { teamId: teams[2]!.id, name: 'MVP Launch', description: 'Get the minimum viable product shipped by Q2', status: 'active', leadId: members[7]!.id },
  ];
  const projects = await db.projects.createMany({ data: projectData });
  console.log(`Created ${projects.length} projects`);

  // === TASKS ===
  const statuses = ['todo', 'in_progress', 'in_review', 'done', 'blocked'];
  const priorities = ['critical', 'high', 'medium', 'low'];
  const labelSets = [
    ['bug', 'urgent'],
    ['feature'],
    ['chore', 'devops'],
    ['bug'],
    ['feature', 'design'],
    ['docs'],
    ['feature', 'backend'],
    ['feature', 'frontend'],
    ['bug', 'regression'],
    ['chore'],
  ];

  const taskData = Array.from({ length: 50 }, (_, i) => {
    const project = projects[i % projects.length]!;
    const teamMembers = members.filter((m) => m.teamId === project.teamId);
    const assignee = teamMembers[i % teamMembers.length]!;
    const creator = teamMembers[(i + 1) % teamMembers.length]!;

    return {
      projectId: project.id,
      assigneeId: assignee.id,
      creatorId: creator.id,
      title: taskTitles[i % taskTitles.length]!,
      description: `Task #${i + 1} — ${taskDescriptions[i % taskDescriptions.length]}`,
      status: statuses[i % statuses.length]!,
      priority: priorities[i % priorities.length]!,
      labels: labelSets[i % labelSets.length]!,
      metadata: {
        storyPoints: (i % 8) + 1,
        sprint: `Sprint ${Math.floor(i / 10) + 1}`,
        ...(i % 5 === 0 ? { epicId: `EPIC-${Math.floor(i / 5) + 1}` } : {}),
      },
      dueDate: new Date(Date.now() + (i - 25) * 86400000), // spread around today
    };
  });
  const tasks = await db.tasks.createMany({ data: taskData });
  console.log(`Created ${tasks.length} tasks`);

  // === COMMENTS ===
  const commentData = Array.from({ length: 100 }, (_, i) => {
    const task = tasks[i % tasks.length]!;
    // Get the project for this task to find team members
    const project = projects.find((p) => p.id === task.projectId)!;
    const teamMembers = members.filter((m) => m.teamId === project.teamId);
    const author = teamMembers[i % teamMembers.length]!;

    return {
      taskId: task.id,
      authorId: author.id,
      body: commentBodies[i % commentBodies.length]!,
    };
  });
  const comments = await db.comments.createMany({ data: commentData });
  console.log(`Created ${comments.length} comments`);

  console.log('\nSeed complete!');
  console.log(`  Teams:    ${teams.length}`);
  console.log(`  Members:  ${members.length}`);
  console.log(`  Projects: ${projects.length}`);
  console.log(`  Tasks:    ${tasks.length}`);
  console.log(`  Comments: ${comments.length}`);

  await db.disconnect();
}

// ---------------------------------------------------------------------------
// Realistic fake content
// ---------------------------------------------------------------------------

const taskTitles = [
  'Fix login redirect loop on Safari',
  'Add dark mode toggle to settings',
  'Migrate user table to new schema',
  'Write API docs for /v2/projects endpoint',
  'Optimize dashboard query performance',
  'Add CSV export for task reports',
  'Fix race condition in websocket reconnect',
  'Implement email notification preferences',
  'Add drag-and-drop to kanban board',
  'Set up Sentry error tracking',
  'Create onboarding wizard for new teams',
  'Add bulk task status update',
  'Fix timezone handling in due dates',
  'Implement SSO with Google Workspace',
  'Add keyboard shortcuts for common actions',
  'Redesign project settings page',
  'Fix memory leak in real-time updates',
  'Add task dependencies / blockers',
  'Implement audit log for admin actions',
  'Add Slack integration for notifications',
  'Fix pagination on large task lists',
  'Add custom fields for tasks',
  'Implement role-based access control',
  'Add comment reactions (emoji)',
  'Fix search indexing for task descriptions',
  'Add time tracking to tasks',
  'Implement project templates',
  'Fix iOS push notification delivery',
  'Add filter presets / saved views',
  'Implement webhook system for integrations',
  'Add task archival and restore',
  'Fix date picker accessibility issues',
  'Implement subtasks / checklist items',
  'Add project-level analytics dashboard',
  'Fix CORS issues with file uploads',
  'Add team invitation via email link',
  'Implement comment threading / replies',
  'Add bulk import from CSV/Jira',
  'Fix session expiry during long edits',
  'Add multi-language support (i18n)',
  'Implement API rate limiting',
  'Add task recurring schedules',
  'Fix dropdown menu z-index issues',
  'Add project roadmap timeline view',
  'Implement real-time collaboration cursors',
  'Add data export for GDPR compliance',
  'Fix email rendering in Outlook',
  'Add sprint planning board',
  'Implement file attachment previews',
  'Add activity feed for project updates',
];

const taskDescriptions = [
  'Users are reporting this issue in production. Needs immediate fix.',
  'Feature request from multiple enterprise customers.',
  'Technical debt that has been accumulating for 3 sprints.',
  'Required for SOC 2 compliance before Q3.',
  'This will improve page load times by approximately 40%.',
  'Depends on the auth service refactor being completed first.',
  'Low priority but would significantly improve the developer experience.',
  'Blocking the mobile team from shipping v2.1.',
  'Customer escalation from Acme Corp — they are on our largest plan.',
  'Part of the Q2 OKR for improving activation rate.',
];

const commentBodies = [
  'I started looking into this. The root cause is in the auth middleware.',
  'Can we get a design review before we start implementing?',
  'Pushed a draft PR: #247. Still needs tests.',
  'This is blocked by the infrastructure migration. Moving to next sprint.',
  '@alice Can you take a look at my approach here? Not sure about the edge cases.',
  'Tested on staging and it looks good. Ready for final review.',
  'We should add a feature flag for this so we can roll it out gradually.',
  'I think we are overcomplicating this. The simpler approach would be to just use a webhook.',
  'Updated the estimate to 5 story points. The API changes are more involved than expected.',
  'Closing this as a duplicate of #189.',
  'Reopening — the fix in v2.3.1 did not fully resolve the issue.',
  'Added a regression test to prevent this from happening again.',
  'Can we schedule a quick sync to align on the requirements?',
  'The performance numbers look great after the optimization. Down from 800ms to 120ms.',
  'Merged! Deploying to production now.',
  'Moving to in-review. The implementation follows the RFC we agreed on.',
  'Good catch on the edge case. Added handling for empty arrays.',
  'This needs a migration. I will coordinate with the DBA.',
  'Demo video of the feature: https://loom.com/share/abc123',
  'Marking as done. Verified in production with the customer.',
];

// Run
seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
