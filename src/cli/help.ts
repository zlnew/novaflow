/**
 * Scoped help rendering (`novaflow-v100/cli` §2).
 *
 * Help goes to `stdout` and exits `0`: it is requested output, not a diagnostic.
 */
import { GLOBAL_FLAGS, type FlagDef } from './args.js';
import type { CommandModule, VerbSpec } from './types.js';
import { VERSION_LINE } from './version.js';

const EXIT_CODES: readonly (readonly [string, string])[] = [
  ['0', 'Success'],
  ['1', 'Runtime / Internal Error'],
  ['2', 'Usage / Validation Error'],
  ['3', 'State / Domain Conflict'],
  ['4', 'Not Found'],
];

function flagLine(def: FlagDef): string {
  const short = def.short === undefined ? '' : `-${def.short}, `;
  const value = def.kind === 'boolean' ? '' : ` ${def.placeholder ?? '<value>'}`;
  return `${short}--${def.name}${value}`;
}

function flagBlock(flags: readonly FlagDef[]): string {
  const width = Math.max(...flags.map((def) => flagLine(def).length));
  return flags.map((def) => `  ${flagLine(def).padEnd(width)}  ${def.description}`).join('\n');
}

function exitCodeBlock(): string {
  const width = Math.max(...EXIT_CODES.map(([code]) => code.length));
  return EXIT_CODES.map(([code, meaning]) => `  ${code.padEnd(width)}  ${meaning}`).join('\n');
}

/** Global help: command tree, global flags, exit codes. */
export function renderGlobalHelp(modules: readonly CommandModule[]): string {
  const lines: string[] = [];
  lines.push(VERSION_LINE);
  lines.push('');
  lines.push('Usage: novaflow <noun> <verb> [args] [flags]');
  lines.push('');
  lines.push('Commands:');
  const nounWidth = Math.max(...modules.map((module) => module.name.length));
  for (const module of modules) {
    const verbs = module.verbs.map((verb) => verb.verb ?? module.name).join('|');
    lines.push(`  ${module.name.padEnd(nounWidth)}  ${verbs}`);
  }
  lines.push('');
  lines.push('Global flags (accepted on every command, in any position):');
  lines.push(flagBlock(GLOBAL_FLAGS));
  lines.push('');
  lines.push('Exit codes:');
  lines.push(exitCodeBlock());
  lines.push('');
  lines.push('Run "novaflow <noun> --help" or "novaflow <noun> <verb> --help" for scoped help.');
  return `${lines.join('\n')}\n`;
}

/** Noun-level help: every verb with its usage line. */
export function renderModuleHelp(module: CommandModule): string {
  const lines: string[] = [];
  lines.push(VERSION_LINE);
  lines.push('');
  lines.push(module.summary);
  lines.push('');
  lines.push(`Usage: novaflow ${module.name} <verb> [args] [flags]`);
  lines.push('');
  lines.push('Verbs:');
  const width = Math.max(...module.verbs.map((verb) => verb.command.length));
  for (const verb of module.verbs) {
    lines.push(`  ${verb.command.padEnd(width)}  ${verb.summary}`);
  }
  lines.push('');
  lines.push('Global flags (accepted on every command, in any position):');
  lines.push(flagBlock(GLOBAL_FLAGS));
  lines.push('');
  lines.push('Exit codes:');
  lines.push(exitCodeBlock());
  lines.push('');
  lines.push(`Run "novaflow ${module.name} <verb> --help" for flags and examples.`);
  return `${lines.join('\n')}\n`;
}

/** Verb-level help: usage, args, flags, examples, exit codes. */
export function renderVerbHelp(verb: VerbSpec): string {
  const lines: string[] = [];
  lines.push(VERSION_LINE);
  lines.push('');
  lines.push(verb.summary);
  lines.push('');
  lines.push(`Usage: ${verb.usage}`);
  if (verb.positionals.length > 0) {
    lines.push('');
    lines.push('Arguments:');
    const width = Math.max(...verb.positionals.map((name) => name.length));
    const required = verb.minPositionals ?? verb.positionals.length;
    for (const [index, name] of verb.positionals.entries()) {
      lines.push(`  ${name.padEnd(width)}  ${index < required ? 'required' : 'optional'}`);
    }
  }
  if (verb.flags.length > 0) {
    lines.push('');
    lines.push('Flags:');
    lines.push(flagBlock(verb.flags));
  }
  lines.push('');
  lines.push('Global flags (accepted on every command, in any position):');
  lines.push(flagBlock(GLOBAL_FLAGS));
  if (verb.examples !== undefined && verb.examples.length > 0) {
    lines.push('');
    lines.push('Examples:');
    for (const example of verb.examples) lines.push(`  ${example}`);
  }
  lines.push('');
  lines.push('Exit codes:');
  lines.push(exitCodeBlock());
  return `${lines.join('\n')}\n`;
}
