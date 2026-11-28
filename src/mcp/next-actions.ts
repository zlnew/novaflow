/**
 * `next_actions` in MCP shape (`novaflow-v100/mcp` §3).
 *
 * The CLI advertises runnable shell lines; an MCP client instead needs the tool
 * name and argument object it can call directly, so every suggestion here is
 * `{ tool, args, description }` and `args` always carries the resolved
 * `workspace` so the follow-up call cannot land in a different workspace.
 */
import type { McpNextAction } from './results.js';

interface TaskRef {
  key: string;
  project_slug: string;
  workspace: string;
}

interface ProjectRef {
  slug: string;
  workspace: string;
}

export function afterWorkspaceCreate(name: string): McpNextAction[] {
  return [
    {
      tool: 'novaflow_project_create',
      args: { workspace: name, title: '<title>' },
      description: 'Create the first project in this workspace',
    },
    {
      tool: 'novaflow_workspace_show',
      args: { workspace: name },
      description: 'Inspect workspace metadata and counts',
    },
  ];
}

export function afterWorkspaceList(): McpNextAction[] {
  return [
    {
      tool: 'novaflow_workspace_create',
      args: { name: '<name>', path: '<dir>' },
      description: 'Create and register another workspace',
    },
  ];
}

export function afterWorkspaceUpdate(name: string): McpNextAction[] {
  return [
    { tool: 'novaflow_workspace_show', args: { workspace: name }, description: 'Confirm the workspace metadata' },
    { tool: 'novaflow_project_list', args: { workspace: name }, description: 'List the projects in this workspace' },
  ];
}

export function afterProjectCreate(project: ProjectRef): McpNextAction[] {
  return [
    {
      tool: 'novaflow_task_create',
      args: { workspace: project.workspace, project: project.slug, title: '<title>' },
      description: 'Add the first task to this project',
    },
    {
      tool: 'novaflow_project_show',
      args: { workspace: project.workspace, project: project.slug },
      description: 'Inspect project metadata and counts',
    },
  ];
}

export function afterProjectUpdate(project: ProjectRef): McpNextAction[] {
  return [
    {
      tool: 'novaflow_project_show',
      args: { workspace: project.workspace, project: project.slug },
      description: 'Confirm the updated project',
    },
    {
      tool: 'novaflow_task_list',
      args: { workspace: project.workspace, project: project.slug },
      description: "List this project's tasks",
    },
  ];
}

export function afterProjectArchive(project: ProjectRef): McpNextAction[] {
  return [
    { tool: 'novaflow_project_list', args: { workspace: project.workspace }, description: 'List the remaining projects' },
  ];
}

export function afterProjectList(workspace: string): McpNextAction[] {
  return [
    {
      tool: 'novaflow_status',
      args: { workspace },
      description: 'Review the board summary across the workspace',
    },
  ];
}

export function afterTaskCreate(task: TaskRef): McpNextAction[] {
  return [
    {
      tool: 'novaflow_task_start',
      args: { workspace: task.workspace, id: task.key, by: '<actor>' },
      description: 'Claim and start this task',
    },
    {
      tool: 'novaflow_task_context',
      args: { workspace: task.workspace, id: task.key },
      description: 'Load the handoff bundle before working',
    },
  ];
}

export function afterTaskUpdate(task: TaskRef): McpNextAction[] {
  return [
    {
      tool: 'novaflow_task_status',
      args: { workspace: task.workspace, id: task.key },
      description: 'Confirm the updated task state',
    },
    {
      tool: 'novaflow_task_start',
      args: { workspace: task.workspace, id: task.key, by: '<actor>' },
      description: 'Claim and start this task',
    },
  ];
}

export function afterTaskStart(task: TaskRef): McpNextAction[] {
  return [
    {
      tool: 'novaflow_task_complete',
      args: { workspace: task.workspace, id: task.key, summary: '<what changed>' },
      description: 'Mark the task done with a summary',
    },
    {
      tool: 'novaflow_task_block',
      args: { workspace: task.workspace, id: task.key, reason: '<blocker>' },
      description: 'Record a blocker instead',
    },
  ];
}

export function afterTaskComplete(task: TaskRef): McpNextAction[] {
  return [
    {
      tool: 'novaflow_task_next',
      args: { workspace: task.workspace, project: task.project_slug },
      description: 'Dispatch the next ready task',
    },
    {
      tool: 'novaflow_status',
      args: { workspace: task.workspace, project: task.project_slug },
      description: 'Review the project board',
    },
  ];
}

export function afterTaskBlocked(task: TaskRef): McpNextAction[] {
  return [
    {
      tool: 'novaflow_task_unblock',
      args: { workspace: task.workspace, id: task.key, start: true },
      description: 'Resume this task once the blocker clears',
    },
    {
      tool: 'novaflow_task_next',
      args: { workspace: task.workspace, project: task.project_slug },
      description: 'Work on something else meanwhile',
    },
  ];
}

export function afterTaskUnblocked(task: TaskRef): McpNextAction[] {
  return [
    {
      tool: 'novaflow_task_start',
      args: { workspace: task.workspace, id: task.key, by: '<actor>' },
      description: 'Claim and start this task',
    },
    {
      tool: 'novaflow_task_context',
      args: { workspace: task.workspace, id: task.key },
      description: 'Load the handoff bundle',
    },
  ];
}

export function afterTaskClaim(task: TaskRef): McpNextAction[] {
  return [
    {
      tool: 'novaflow_task_start',
      args: { workspace: task.workspace, id: task.key, by: '<actor>' },
      description: 'Move the task into in_progress',
    },
    {
      tool: 'novaflow_task_release',
      args: { workspace: task.workspace, id: task.key },
      description: 'Release the claim instead',
    },
  ];
}

export function afterTaskRelease(task: TaskRef): McpNextAction[] {
  return [
    {
      tool: 'novaflow_task_next',
      args: { workspace: task.workspace, project: task.project_slug },
      description: 'Dispatch the next ready task',
    },
    {
      tool: 'novaflow_task_status',
      args: { workspace: task.workspace, id: task.key },
      description: 'Confirm the claim is cleared',
    },
  ];
}

export function afterTaskCancelled(task: TaskRef): McpNextAction[] {
  return [
    {
      tool: 'novaflow_task_reopen',
      args: { workspace: task.workspace, id: task.key },
      description: 'Reopen if the work is needed again',
    },
    {
      tool: 'novaflow_task_next',
      args: { workspace: task.workspace, project: task.project_slug },
      description: 'Dispatch the next ready task',
    },
  ];
}

export function afterTaskReopened(task: TaskRef): McpNextAction[] {
  return [
    {
      tool: 'novaflow_task_start',
      args: { workspace: task.workspace, id: task.key, by: '<actor>' },
      description: 'Claim and start this task',
    },
    {
      tool: 'novaflow_task_list',
      args: { workspace: task.workspace, project: task.project_slug, ready: true },
      description: 'Check what else is ready',
    },
  ];
}

export function afterTaskDep(task: TaskRef): McpNextAction[] {
  return [
    {
      tool: 'novaflow_task_status',
      args: { workspace: task.workspace, id: task.key },
      description: 'Confirm the dependency graph',
    },
    {
      tool: 'novaflow_task_next',
      args: { workspace: task.workspace, project: task.project_slug },
      description: 'Dispatch the next ready task',
    },
  ];
}

export function afterTaskNote(task: { key: string; workspace: string }): McpNextAction[] {
  return [
    {
      tool: 'novaflow_task_context',
      args: { workspace: task.workspace, id: task.key },
      description: 'Read the assembled handoff bundle',
    },
    {
      tool: 'novaflow_task_status',
      args: { workspace: task.workspace, id: task.key },
      description: 'Inspect the task timeline',
    },
  ];
}

export function afterTaskAttach(task: { key: string; workspace: string }): McpNextAction[] {
  return [
    {
      tool: 'novaflow_task_context',
      args: { workspace: task.workspace, id: task.key },
      description: 'Hand the artifact to the next agent',
    },
    {
      tool: 'novaflow_task_complete',
      args: { workspace: task.workspace, id: task.key, summary: '<what changed>' },
      description: 'Finish the task',
    },
  ];
}

export function afterTaskList(workspace: string): McpNextAction[] {
  return [
    {
      tool: 'novaflow_task_next',
      args: { workspace },
      description: 'Dispatch the next ready task',
    },
    { tool: 'novaflow_status', args: { workspace }, description: 'Review the board summary' },
  ];
}

export function afterTaskNext(tasks: readonly { key: string }[], workspace: string): McpNextAction[] {
  const first = tasks[0];
  if (first === undefined) {
    return [{ tool: 'novaflow_status', args: { workspace }, description: 'Review what is in flight or blocked' }];
  }
  return [
    {
      tool: 'novaflow_task_start',
      args: { workspace, id: first.key, by: '<actor>' },
      description: 'Claim and start the highest-priority ready task',
    },
    {
      tool: 'novaflow_task_context',
      args: { workspace, id: first.key },
      description: 'Load the handoff bundle for it',
    },
  ];
}

export function afterTaskStatus(task: TaskRef & { status: string }): McpNextAction[] {
  if (task.status === 'blocked') return afterTaskBlocked(task);
  if (task.status === 'in_progress') return afterTaskStart(task);
  if (task.status === 'done' || task.status === 'cancelled') return afterTaskCancelled(task);
  return afterTaskCreate(task);
}

export function afterTaskContext(task: TaskRef): McpNextAction[] {
  return afterTaskStart(task);
}

export function afterStatus(workspace: string): McpNextAction[] {
  return [
    { tool: 'novaflow_task_next', args: { workspace }, description: 'Dispatch the next ready task' },
    { tool: 'novaflow_events_list', args: { workspace, limit: 20 }, description: 'Read the recent audit trail' },
  ];
}

export function afterEvents(workspace: string, nextAfterSeq: number | null): McpNextAction[] {
  if (nextAfterSeq === null) {
    return [{ tool: 'novaflow_status', args: { workspace }, description: 'Review the board summary' }];
  }
  return [
    {
      tool: 'novaflow_events_list',
      args: { workspace, after_seq: nextAfterSeq },
      description: 'Poll for newer events',
    },
    { tool: 'novaflow_status', args: { workspace }, description: 'Review the board summary' },
  ];
}

export function afterExport(workspace: string): McpNextAction[] {
  return [
    { tool: 'novaflow_status', args: { workspace }, description: 'Review the board summary' },
    { tool: 'novaflow_events_list', args: { workspace, limit: 20 }, description: 'Read the recent audit trail' },
  ];
}
