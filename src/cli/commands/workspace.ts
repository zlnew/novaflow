/**
 * `novaflow workspace` — create, list, show, update, register, unregister
 * (`novaflow-v100/cli` §3.1).
 */
import {
  createWorkspace,
  listWorkspaces,
  registerWorkspace,
  showWorkspace,
  unregisterWorkspace,
  updateWorkspace,
} from '../../core/workspace.js';
import { rejectCombined, requireFlag } from '../args.js';
import { bucket, countsLine, detail, orDash, table, yesNo } from '../format.js';
import { identifiers } from '../output.js';
import { afterWorkspaceCreate, afterWorkspaceUpdate } from '../next-actions.js';
import type { CommandModule, VerbSpec } from '../types.js';

const createVerb: VerbSpec = {
  verb: 'create',
  command: 'workspace.create',
  summary: 'Create a workspace, scaffold .novaflow/ and register it globally',
  usage: 'novaflow workspace create [--name <slug>] [--path <dir>] [--gitignore] [--default]',
  positionals: [],
  flags: [
    { name: 'name', kind: 'string', placeholder: '<slug>', description: 'Workspace name (default: slugified --path basename)' },
    { name: 'path', kind: 'string', placeholder: '<dir>', description: 'Directory that will hold .novaflow/ (default: cwd)' },
    { name: 'gitignore', kind: 'boolean', description: 'Append .novaflow/ to the nearest git root .gitignore' },
    { name: 'default', kind: 'boolean', description: 'Mark the new workspace as the registry default' },
  ],
  examples: [
    'novaflow workspace create --name personal --path ~/www/personal',
    'novaflow workspace create --name scratch --path ./scratch --gitignore --default',
  ],
  run: (ctx) => {
    const result = createWorkspace({
      name: ctx.args.get('name') ?? null,
      path: ctx.args.get('path') ?? null,
      gitignore: ctx.args.has('gitignore'),
      set_default: ctx.args.has('default'),
      env: ctx.env,
      cwd: ctx.cwd,
      now: ctx.now,
      dry_run: ctx.options.dryRun,
    });
    const name = result.workspace.name;
    const human = result.dry_run
      ? `Dry run: would create workspace ${name} at ${result.workspace.path}\nNo files written.\n`
      : `Created workspace ${name} at ${result.workspace.root}\nRegistry: ${result.registry_path}\n`;
    return { data: result, human, quiet: identifiers([name]), next_actions: afterWorkspaceCreate(name) };
  },
};

const listVerb: VerbSpec = {
  verb: 'list',
  command: 'workspace.list',
  summary: 'List registered workspaces with the active and default markers',
  usage: 'novaflow workspace list',
  positionals: [],
  flags: [],
  examples: ['novaflow workspace list', 'novaflow workspace list --quiet'],
  run: (ctx) => {
    const result = listWorkspaces({ env: ctx.env, cwd: ctx.cwd });
    const rows = result.workspaces.map((entry) => [
      entry.name,
      entry.root,
      yesNo(entry.exists),
      yesNo(entry.is_default),
      yesNo(entry.is_active),
      orDash(entry.defaults?.project ?? null),
    ]);
    const human = table(['NAME', 'PATH', 'EXISTS', 'DEFAULT', 'ACTIVE', 'DEFAULT PROJECT'], rows);
    return {
      data: result,
      human: result.workspaces.length === 0 ? `${human}(no workspaces registered)\n` : human,
      quiet: identifiers(result.workspaces.map((entry) => entry.name)),
      next_actions: [
        { command: 'novaflow workspace create --name <name>', description: 'Create and register a workspace' },
      ],
    };
  },
};

const showVerb: VerbSpec = {
  verb: 'show',
  command: 'workspace.show',
  summary: 'Show resolved workspace metadata, path, project count and task counts',
  usage: 'novaflow workspace show [name]',
  positionals: ['[name]'],
  minPositionals: 0,
  flags: [],
  examples: ['novaflow workspace show', 'novaflow workspace show personal --json'],
  run: (ctx) => {
    const name = ctx.args.positionals[0];
    const result = showWorkspace({
      workspace: name ?? ctx.options.workspace ?? null,
      env: ctx.env,
      cwd: ctx.cwd,
      now: ctx.now,
    });
    const human = `${detail([
      ['name', result.name],
      ['root', result.root],
      ['path', result.path],
      ['workspace_id', result.workspace_id],
      ['created_at', result.created_at],
      ['source', result.source],
      ['default_project', orDash(result.defaults.project)],
      ['projects', `${result.projects.active} active, ${result.projects.paused} paused, ${result.projects.archived} archived`],
      ['tasks', countsLine(bucket(result.tasks))],
    ])}`;
    return {
      data: result,
      human,
      quiet: identifiers([result.name]),
      next_actions: [
        { command: `novaflow project list --workspace ${result.name}`, description: 'List this workspace\'s projects' },
        { command: `novaflow status --workspace ${result.name}`, description: 'Review the board summary' },
      ],
    };
  },
};

const updateVerb: VerbSpec = {
  verb: 'update',
  command: 'workspace.update',
  summary: 'Update the workspace name, default project, or registry default',
  usage:
    'novaflow workspace update [--name <new>] [--default-project <slug>] [--clear-default-project] [--set-default]',
  positionals: [],
  flags: [
    { name: 'name', kind: 'string', placeholder: '<new>', description: 'New workspace name (config.yaml and registry together)' },
    {
      name: 'default-project',
      kind: 'string',
      placeholder: '<slug>',
      description: 'Default project for task commands in this workspace',
    },
    { name: 'clear-default-project', kind: 'boolean', description: 'Clear the workspace default project' },
    { name: 'set-default', kind: 'boolean', description: 'Mark this workspace as the registry default' },
  ],
  examples: [
    'novaflow workspace update --name personal-2',
    'novaflow workspace update --default-project novaflow-v3',
    'novaflow workspace update --clear-default-project',
  ],
  run: (ctx) => {
    rejectCombined(ctx.args, 'default-project', 'clear-default-project');
    const name = ctx.args.get('name');
    const defaultProject = ctx.args.get('default-project');
    const clear = ctx.args.has('clear-default-project');

    const result = updateWorkspace({
      workspace: ctx.options.workspace ?? null,
      ...(name === undefined ? {} : { name }),
      ...(defaultProject === undefined && !clear ? {} : { default_project: clear ? null : (defaultProject as string) }),
      set_default: ctx.args.has('set-default'),
      env: ctx.env,
      cwd: ctx.cwd,
      now: ctx.now,
      dry_run: ctx.options.dryRun,
    });

    const changed = result.changed.length === 0 ? 'no changes' : `changed ${result.changed.join(', ')}`;
    const human = result.dry_run
      ? `Dry run: would update workspace ${result.workspace.name} (${changed}).\nNo files written.\n`
      : `Updated workspace ${result.workspace.name} (${changed}).\n`;
    return {
      data: result,
      human,
      quiet: identifiers([result.workspace.name]),
      next_actions: afterWorkspaceUpdate(result.workspace.name),
    };
  },
};

const registerVerb: VerbSpec = {
  verb: 'register',
  command: 'workspace.register',
  summary: 'Register an existing .novaflow/ directory in the global registry',
  usage: 'novaflow workspace register --path <dir> [--name <slug>]',
  positionals: [],
  flags: [
    { name: 'name', kind: 'string', placeholder: '<slug>', description: 'Registered name (default: name in config.yaml)' },
    { name: 'path', kind: 'string', placeholder: '<dir>', description: 'Directory that already holds .novaflow/' },
  ],
  examples: ['novaflow workspace register --path ~/www/personal'],
  run: (ctx) => {
    const path = requireFlag(ctx.args, 'path', 'workspace.register');
    const result = registerWorkspace({
      name: ctx.args.get('name') ?? null,
      path,
      env: ctx.env,
      cwd: ctx.cwd,
      now: ctx.now,
      dry_run: ctx.options.dryRun,
    });
    const human = result.dry_run
      ? `Dry run: would register workspace ${result.name} at ${result.root}\nNo registry changes written.\n`
      : `Registered workspace ${result.name} at ${result.root}\nRegistry: ${result.registry_path}\n`;
    return {
      data: result,
      human,
      quiet: identifiers([result.name]),
      next_actions: result.dry_run
        ? []
        : [{ command: `novaflow workspace show ${result.name}`, description: 'Inspect the registered workspace' }],
    };
  },
};

const unregisterVerb: VerbSpec = {
  verb: 'unregister',
  command: 'workspace.unregister',
  summary: 'Remove a workspace from the global registry (the directory is kept)',
  usage: 'novaflow workspace unregister <name>',
  positionals: ['<name>'],
  flags: [],
  examples: ['novaflow workspace unregister scratch'],
  run: (ctx) => {
    const name = ctx.args.positionals[0] as string;
    const result = unregisterWorkspace({ name, env: ctx.env, dry_run: ctx.options.dryRun });
    return {
      data: result,
      human: result.dry_run
        ? `Dry run: would unregister workspace ${result.name}.\nNo registry changes written.\n`
        : `Unregistered workspace ${result.name}. Its .novaflow/ directory was not touched.\n`,
      quiet: identifiers([result.name]),
      next_actions: result.dry_run
        ? []
        : [{ command: 'novaflow workspace list', description: 'Confirm the registry contents' }],
    };
  },
};

export const workspaceModule: CommandModule = {
  name: 'workspace',
  summary: 'Create, inspect, and register NovaFlow workspaces.',
  verbs: [createVerb, listVerb, showVerb, updateVerb, registerVerb, unregisterVerb],
};
