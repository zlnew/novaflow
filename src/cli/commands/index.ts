/**
 * Command registry (`novaflow-v100/cli` §1).
 *
 * Each noun is one module file. Adding `mcp` or `skill` behaviour means editing
 * that module, not this list or the dispatcher.
 */
import type { CommandModule } from '../types.js';
import { eventsModule } from './events.js';
import { exportModule } from './export.js';
import { mcpModule } from './mcp.js';
import { projectModule } from './project.js';
import { skillModule } from './skill.js';
import { statusModule } from './status.js';
import { taskModule } from './task.js';
import { workspaceModule } from './workspace.js';

export const COMMAND_MODULES: readonly CommandModule[] = [
  workspaceModule,
  projectModule,
  taskModule,
  statusModule,
  eventsModule,
  exportModule,
  mcpModule,
  skillModule,
];

export function findModule(name: string): CommandModule | undefined {
  return COMMAND_MODULES.find((module) => module.name === name);
}
