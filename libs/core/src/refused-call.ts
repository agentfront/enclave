import { MAX_TOOL_NAMESPACE_TOOL_NAME_LENGTH } from '@enclave-vm/ast';

export type RefusedCallCode =
  | 'MAX_TOOL_CALLS_EXCEEDED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'OPERATION_NOT_ALLOWED'
  | 'OPERATION_BLOCKED'
  | 'SUSPICIOUS_SEQUENCE';

/** The first tool call the enclave itself refused in a run; set on the host side only, never by the script */
export interface RefusedCall {
  code: RefusedCallCode;
  toolName?: string;
  /** The id of the suspicious-sequence detector, with `SUSPICIOUS_SEQUENCE` */
  pattern?: string;
}

const REFUSED_CALL_CODES: ReadonlySet<unknown> = new Set<RefusedCallCode>([
  'MAX_TOOL_CALLS_EXCEEDED',
  'RATE_LIMIT_EXCEEDED',
  'OPERATION_NOT_ALLOWED',
  'OPERATION_BLOCKED',
  'SUSPICIOUS_SEQUENCE',
]);

export function refusedCallOf(code: unknown, toolName?: unknown, pattern?: unknown): RefusedCall | undefined {
  if (!REFUSED_CALL_CODES.has(code)) return undefined;
  return {
    code: code as RefusedCallCode,
    ...(typeof toolName === 'string' && { toolName: toolName.slice(0, MAX_TOOL_NAMESPACE_TOOL_NAME_LENGTH) }),
    ...(typeof pattern === 'string' && { pattern: pattern.slice(0, MAX_TOOL_NAMESPACE_TOOL_NAME_LENGTH) }),
  };
}
