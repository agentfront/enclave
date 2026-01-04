/**
 * Adapter Wrapper Factory
 *
 * Provides a function to wrap any SandboxAdapter with the double VM layer.
 *
 * @packageDocumentation
 */

import type { SandboxAdapter, SecurityLevel } from '../types';
import type { DoubleVmConfig } from './types';
import { DoubleVmWrapper } from './double-vm-wrapper';

/**
 * Wrap a sandbox adapter with the double VM layer
 *
 * When enabled, this creates a nested VM structure where:
 * - The Parent VM acts as a security barrier with enhanced validation
 * - The Inner VM is where user code actually executes
 * - Tool calls flow: Inner VM -> Parent VM validation -> Host handler
 *
 * When disabled, a security warning is logged and the original adapter
 * is returned unchanged. This is NOT recommended for production use.
 *
 * @param baseAdapter - The original adapter (returned when double VM is disabled;
 *   when enabled, a new DoubleVmWrapper is created instead of wrapping this adapter)
 * @param config - Double VM configuration
 * @param securityLevel - The security level for dangerous global removal
 * @returns The wrapped adapter (or original if disabled)
 */
export function wrapWithDoubleVm(
  baseAdapter: SandboxAdapter,
  config: DoubleVmConfig,
  securityLevel: SecurityLevel,
): SandboxAdapter {
  // If disabled, warn and return original adapter
  if (!config.enabled) {
    console.warn(
      '[SECURITY WARNING] Double VM is disabled. ' +
        'This reduces security isolation and is NOT recommended for production. ' +
        'User code will run in a single VM with direct tool handler access. ' +
        'To enable double VM protection, set doubleVm.enabled = true.',
    );
    return baseAdapter;
  }

  // Create the double VM wrapper
  // Note: The base adapter is not used - DoubleVmWrapper creates its own VMs
  // This is intentional: the double VM replaces the base adapter rather than wrapping it
  return new DoubleVmWrapper(config, securityLevel);
}

/**
 * Check if double VM is enabled in the config
 *
 * @param config - Partial double VM config
 * @returns Whether double VM is enabled (defaults to true)
 */
export function isDoubleVmEnabled(config?: Partial<DoubleVmConfig>): boolean {
  return config?.enabled !== false;
}
