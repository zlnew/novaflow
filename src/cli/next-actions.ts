/**
 * Actionable `next_actions` (`novaflow-v100/cli` §2.2).
 *
 * Every suggestion is a runnable command line, so an agent reading the envelope
 * can dispatch the next step without consulting docs.
 */
import type { NextAction } from './types.js';

interface TaskRef {
  key: string;
  project_slug: string;
}

export function afterWorkspaceCreate(name: string): NextAction[] {
  return [
    {
      command: `novaflow project create --title "<title>" --workspace ${name}`,
      description: 'Create the first project in this workspace',
    },
    { command: `novaflow workspace show ${name}`, description: 'Inspect workspace metadata and counts' },
  ];
}

export function afterWorkspaceUpdate(name: string): NextAction[] {
  return [
    { command: `novaflow workspace show ${name}`, description: 'Confirm the workspace metadata' },
    { command: `novaflow project list --workspace ${name}`, description: 'List the projects in this workspace' },
  ];
}

export function afterProjectCreate(project: { slug: string }): NextAction[] {
  return [
    {
      command: `novaflow task create --title "<title>" --project ${project.slug}`,
      description: 'Add the first task to this project',
    },
    { command: `novaflow project show ${project.slug}`, description: 'Inspect project metadata and counts' },
  ];
}

export function afterProjectUpdate(project: { slug: string }): NextAction[] {
  return [
    { command: `novaflow project show ${project.slug}`, description: 'Confirm the updated project' },
    { command: `novaflow task list --project ${project.slug}`, description: 'List this project\'s tasks' },
  ];
}

export function afterTaskCreate(task: TaskRef): NextAction[] {
  return [
    {
      command: `novaflow task start ${task.key} --by <actor>`,
      description: 'Claim and start this task',
    },
    {
      command: `novaflow task context ${task.key}`,
      description: 'Load the handoff bundle before working',
    },
  ];
}

export function afterTaskUpdate(task: TaskRef): NextAction[] {
  return [
    { command: `novaflow task status ${task.key}`, description: 'Confirm the updated task state' },
    { command: `novaflow task start ${task.key} --by <actor>`, description: 'Claim and start this task' },
  ];
}

export function afterTaskStart(task: TaskRef): NextAction[] {
  return [
    {
      command: `novaflow task complete ${task.key} --summary "<what changed>"`,
      description: 'Mark the task done with a summary',
    },
    {
      command: `novaflow task block ${task.key} --reason "<blocker>"`,
      description: 'Record a blocker instead',
    },
  ];
}

export function afterTaskComplete(task: TaskRef): NextAction[] {
  return [
    { command: `novaflow task next --project ${task.project_slug}`, description: 'Dispatch the next ready task' },
    { command: `novaflow status --project ${task.project_slug}`, description: 'Review the project board' },
  ];
}

export function afterTaskBlocked(task: TaskRef): NextAction[] {
  return [
    {
      command: `novaflow task unblock ${task.key} --start`,
      description: 'Resume this task once the blocker clears',
    },
    { command: `novaflow task next --project ${task.project_slug}`, description: 'Work on something else meanwhile' },
  ];
}

export function afterTaskUnblocked(task: TaskRef): NextAction[] {
  return [
    { command: `novaflow task start ${task.key} --by <actor>`, description: 'Claim and start this task' },
    { command: `novaflow task context ${task.key}`, description: 'Load the handoff bundle' },
  ];
}

export function afterTaskClaim(task: TaskRef): NextAction[] {
  return [
    { command: `novaflow task start ${task.key} --by <actor>`, description: 'Move the task into in_progress' },
    { command: `novaflow task release ${task.key}`, description: 'Release the claim instead' },
  ];
}

export function afterTaskRelease(task: TaskRef): NextAction[] {
  return [
    { command: `novaflow task next --project ${task.project_slug}`, description: 'Dispatch the next ready task' },
    { command: `novaflow task status ${task.key}`, description: 'Confirm the claim is cleared' },
  ];
}

export function afterTaskCancelled(task: TaskRef): NextAction[] {
  return [
    { command: `novaflow task reopen ${task.key}`, description: 'Reopen if the work is needed again' },
    { command: `novaflow task next --project ${task.project_slug}`, description: 'Dispatch the next ready task' },
  ];
}

export function afterTaskReopened(task: TaskRef): NextAction[] {
  return [
    { command: `novaflow task start ${task.key} --by <actor>`, description: 'Claim and start this task' },
    { command: `novaflow task list --project ${task.project_slug} --ready`, description: 'Check what else is ready' },
  ];
}

export function afterTaskDep(task: TaskRef): NextAction[] {
  return [
    { command: `novaflow task status ${task.key}`, description: 'Confirm the dependency graph' },
    { command: `novaflow task next --project ${task.project_slug}`, description: 'Dispatch the next ready task' },
  ];
}

export function afterTaskNote(task: { key: string }): NextAction[] {
  return [
    { command: `novaflow task context ${task.key}`, description: 'Read the assembled handoff bundle' },
    { command: `novaflow task status ${task.key}`, description: 'Inspect the task timeline' },
  ];
}

export function afterTaskAttach(task: { key: string }): NextAction[] {
  return [
    { command: `novaflow task context ${task.key}`, description: 'Hand the artifact to the next agent' },
    { command: `novaflow task complete ${task.key} --summary "<what changed>"`, description: 'Finish the task' },
  ];
}

export function afterStatus(): NextAction[] {
  return [
    { command: 'novaflow task next', description: 'Dispatch the next ready task' },
    { command: 'novaflow events --limit 20', description: 'Read the recent audit trail' },
  ];
}

export function afterEvents(nextAfterSeq: number | null): NextAction[] {
  if (nextAfterSeq === null) {
    return [{ command: 'novaflow status', description: 'Review the board summary' }];
  }
  return [
    { command: `novaflow events --after-seq ${nextAfterSeq}`, description: 'Poll for newer events' },
    { command: 'novaflow status', description: 'Review the board summary' },
  ];
}

export function afterExport(out: string | null): NextAction[] {
  if (out === null) {
    return [{ command: 'novaflow export --out <file>', description: 'Persist the snapshot to a file' }];
  }
  return [{ command: 'novaflow status', description: 'Review the board summary' }];
}
