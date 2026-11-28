/**
 * `novaflow project` — create, list, show, update, archive
 * (`novaflow-v100/cli` §3.2).
 */
import {
  archiveProject,
  createProject,
  listProjects,
  showProject,
  updateProject,
} from '../../core/project.js';
import { validationError } from '../../core/errors.js';
import type { ProjectStatus } from '../../core/model.js';
import { rejectCombined, requireFlag } from '../args.js';
import { withWorkspace } from '../context.js';
import { bucket, countsLine, detail, orDash, snippet, table } from '../format.js';
import { identifiers } from '../output.js';
import { afterProjectCreate, afterProjectUpdate } from '../next-actions.js';
import type { CommandModule, VerbSpec } from '../types.js';

const PROJECT_STATUSES = ['active', 'paused', 'archived', 'all'] as const;

const createVerb: VerbSpec = {
  verb: 'create',
  command: 'project.create',
  summary: 'Create a project with a derived slug and a unique key prefix',
  usage:
    'novaflow project create --title <title> [--slug <slug>] [--prefix <PFX>] [--objective <text>] [--path <dir>] [--verify <cmd>] [--tag <t>]...',
  positionals: [],
  flags: [
    { name: 'title', kind: 'string', placeholder: '<title>', description: 'Human project title (required)' },
    { name: 'slug', kind: 'string', placeholder: '<slug>', description: 'Explicit kebab-case slug (default: derived from --title)' },
    { name: 'prefix', kind: 'string', placeholder: '<PFX>', description: 'Explicit key prefix (default: derived, collision-suffixed)' },
    { name: 'objective', kind: 'string', placeholder: '<text>', description: 'One-line project objective' },
    { name: 'path', kind: 'string', placeholder: '<dir>', description: 'Repo or folder hint recorded on the project' },
    { name: 'verify', kind: 'string', placeholder: '<cmd>', description: 'Verification command metadata' },
    { name: 'tag', kind: 'string', placeholder: '<t>', repeatable: true, description: 'Project tag (repeatable)' },
  ],
  examples: [
    'novaflow project create --title novaflow-v3 --objective "Rebuild the orchestrator"',
    'novaflow project create --title api --prefix API --tag backend',
  ],
  run: (ctx) => {
    requireFlag(ctx.args, 'title', 'project.create');
    const result = withWorkspace(ctx, (db) =>
      createProject(db, {
        title: ctx.args.get('title') as string,
        slug: ctx.args.get('slug') ?? null,
        prefix: ctx.args.get('prefix') ?? null,
        objective: ctx.args.get('objective') ?? null,
        repo_path: ctx.args.get('path') ?? null,
        verify_cmd: ctx.args.get('verify') ?? null,
        tags: ctx.args.getAll('tag'),
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );
    const project = result.project;
    const human = result.dry_run
      ? `Dry run: would create project ${project.slug} (${project.prefix}).\nNo rows written.\n`
      : `Created project ${project.slug} (${project.prefix}) — ${project.title}\n`;
    return {
      data: result,
      human,
      quiet: identifiers([project.slug]),
      next_actions: result.dry_run ? [] : afterProjectCreate(project),
    };
  },
};

const listVerb: VerbSpec = {
  verb: 'list',
  command: 'project.list',
  summary: 'List projects with prefix, task counts and objective snippet',
  usage: 'novaflow project list [--status active|paused|archived|all]',
  positionals: [],
  flags: [
    {
      name: 'status',
      kind: 'string',
      placeholder: '<active|paused|archived|all>',
      description: 'Project status filter (default: active)',
    },
  ],
  examples: ['novaflow project list', 'novaflow project list --status all --quiet'],
  run: (ctx) => {
    const requested = ctx.args.get('status') ?? 'active';
    if (!(PROJECT_STATUSES as readonly string[]).includes(requested)) {
      throw validationError(
        `Invalid project status ${JSON.stringify(requested)}.`,
        `Use one of: ${PROJECT_STATUSES.join(', ')}.`,
      );
    }
    const projects = withWorkspace(ctx, (db) => listProjects(db, { status: requested as ProjectStatus | 'all', now: ctx.now }));
    const rows = projects.map((project) => [
      project.prefix,
      project.slug,
      project.status,
      String(project.counts.todo),
      String(project.counts.ready),
      String(project.counts.in_progress),
      String(project.counts.blocked),
      String(project.counts.done),
      String(project.counts.total),
      snippet(project.objective),
    ]);
    return {
      data: { projects },
      human:
        projects.length === 0
          ? `${table(['PREFIX', 'SLUG', 'STATUS', 'TODO', 'READY', 'WIP', 'BLOCKED', 'DONE', 'TOTAL', 'OBJECTIVE'], rows)}(no projects with status ${requested})\n`
          : table(['PREFIX', 'SLUG', 'STATUS', 'TODO', 'READY', 'WIP', 'BLOCKED', 'DONE', 'TOTAL', 'OBJECTIVE'], rows),
      quiet: identifiers(projects.map((project) => project.slug)),
      next_actions: [
        { command: 'novaflow project create --title <title>', description: 'Create another project' },
        { command: 'novaflow status', description: 'Review the workspace board' },
      ],
    };
  },
};

const showVerb: VerbSpec = {
  verb: 'show',
  command: 'project.show',
  summary: 'Show project details, task status breakdown and ready/blocked counts',
  usage: 'novaflow project show <project>',
  positionals: ['<project>'],
  flags: [],
  examples: ['novaflow project show novaflow-v3', 'novaflow project show NV3 --json'],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    const project = withWorkspace(ctx, (db, resolved) =>
      showProject(db, {
        project: id,
        env: ctx.env,
        config: resolved.config,
        now: ctx.now,
      }),
    );
    const human = detail([
      ['slug', project.slug],
      ['prefix', project.prefix],
      ['title', project.title],
      ['status', project.status],
      ['objective', orDash(project.objective)],
      ['repo_path', orDash(project.repo_path)],
      ['verify_cmd', orDash(project.verify_cmd)],
      ['tags', project.tags.length === 0 ? '-' : project.tags.join(', ')],
      ['created_at', project.created_at],
      ['updated_at', project.updated_at],
      ['tasks', countsLine(bucket(project.counts))],
    ]);
    return {
      data: { project },
      human,
      quiet: identifiers([project.slug]),
      next_actions: [
        { command: `novaflow task list --project ${project.slug}`, description: 'List this project\'s tasks' },
        { command: `novaflow task create --title "<title>" --project ${project.slug}`, description: 'Add a task' },
      ],
    };
  },
};

const updateVerb: VerbSpec = {
  verb: 'update',
  command: 'project.update',
  summary: 'Update project metadata, tags, or status (the prefix is immutable once tasks exist)',
  usage:
    'novaflow project update <project> [--title <t>] [--objective <o>] [--clear-objective] [--path <dir>] [--clear-repo-path] [--verify <cmd>] [--clear-verify] [--tag <t>]... [--clear-tags] [--status active|paused|archived]',
  positionals: ['<project>'],
  flags: [
    { name: 'title', kind: 'string', placeholder: '<t>', description: 'New title' },
    { name: 'objective', kind: 'string', placeholder: '<o>', description: 'New objective' },
    { name: 'clear-objective', kind: 'boolean', description: 'Clear the objective' },
    { name: 'path', kind: 'string', placeholder: '<dir>', description: 'New repo/folder hint' },
    { name: 'clear-repo-path', kind: 'boolean', description: 'Clear the repo/folder hint' },
    { name: 'verify', kind: 'string', placeholder: '<cmd>', description: 'New verification command metadata' },
    { name: 'clear-verify', kind: 'boolean', description: 'Clear the verification command metadata' },
    { name: 'tag', kind: 'string', placeholder: '<t>', repeatable: true, description: 'Replace the full tag list (repeatable)' },
    { name: 'clear-tags', kind: 'boolean', description: 'Clear every tag' },
    { name: 'status', kind: 'string', placeholder: '<active|paused|archived>', description: 'New project status' },
  ],
  examples: [
    'novaflow project update novaflow-v3 --objective "Ship the CLI"',
    'novaflow project update novaflow-v3 --status paused',
    'novaflow project update novaflow-v3 --tag core --tag cli',
  ],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    rejectCombined(ctx.args, 'objective', 'clear-objective');
    rejectCombined(ctx.args, 'path', 'clear-repo-path');
    rejectCombined(ctx.args, 'verify', 'clear-verify');
    rejectCombined(ctx.args, 'tag', 'clear-tags');

    const objective = ctx.args.has('clear-objective') ? '' : ctx.args.get('objective');
    const repoPath = ctx.args.has('clear-repo-path') ? '' : ctx.args.get('path');
    const verifyCmd = ctx.args.has('clear-verify') ? '' : ctx.args.get('verify');
    const tags = ctx.args.getAll('tag');

    const result = withWorkspace(ctx, (db, resolved) =>
      updateProject(db, {
        project: id,
        env: ctx.env,
        config: resolved.config,
        ...(ctx.args.get('title') === undefined ? {} : { title: ctx.args.get('title') as string }),
        ...(objective === undefined ? {} : { objective }),
        ...(repoPath === undefined ? {} : { repo_path: repoPath }),
        ...(verifyCmd === undefined ? {} : { verify_cmd: verifyCmd }),
        ...(tags.length === 0 && !ctx.args.has('clear-tags') ? {} : { tags: ctx.args.has('clear-tags') ? [] : tags }),
        ...(ctx.args.get('status') === undefined ? {} : { status: ctx.args.get('status') as ProjectStatus }),
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );

    const changed = result.changed.length === 0 ? 'no changes' : `changed ${result.changed.join(', ')}`;
    return {
      data: result,
      human: result.dry_run
        ? `Dry run: would update project ${result.project.slug} (${changed}).\nNo rows written.\n`
        : `Updated project ${result.project.slug} (${changed}).\n`,
      quiet: identifiers([result.project.slug]),
      next_actions: result.dry_run ? [] : afterProjectUpdate(result.project),
    };
  },
};

const archiveVerb: VerbSpec = {
  verb: 'archive',
  command: 'project.archive',
  summary: 'Archive a project (shorthand for update --status archived)',
  usage: 'novaflow project archive <project>',
  positionals: ['<project>'],
  flags: [],
  examples: ['novaflow project archive novaflow-v3'],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    const result = withWorkspace(ctx, (db, resolved) =>
      archiveProject(db, {
        project: id,
        env: ctx.env,
        config: resolved.config,
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );
    const changed = result.changed.length === 0 ? 'already archived' : 'archived';
    return {
      data: result,
      human: result.dry_run
        ? `Dry run: would archive project ${result.project.slug}.\nNo rows written.\n`
        : `Project ${result.project.slug}: ${changed}.\n`,
      quiet: identifiers([result.project.slug]),
      next_actions: result.dry_run
        ? []
        : [{ command: `novaflow project show ${result.project.slug}`, description: 'Confirm the archived state' }],
    };
  },
};

export const projectModule: CommandModule = {
  name: 'project',
  summary: 'Create and maintain projects inside a workspace.',
  verbs: [createVerb, listVerb, showVerb, updateVerb, archiveVerb],
};
