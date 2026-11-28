/**
 * Shared placeholder for a command owned by a later phase.
 *
 * The module and its dispatch already exist, so wiring the real implementation
 * means editing only that command's file — never the dispatcher or a sibling.
 */
import { NovaError } from '../../core/errors.js';

export function notImplemented(feature: string, phase: string, spec: string): NovaError {
  return new NovaError('VALIDATION_ERROR', `novaflow ${feature} is not available in this build.`, {
    hint: `Planned in ${phase} for ${spec}; the module already owns its dispatch at src/cli/commands/${feature}.ts.`,
  });
}
