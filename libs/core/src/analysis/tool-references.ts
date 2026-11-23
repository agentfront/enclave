import type { NormalizedToolNamespace } from '@enclave-vm/ast';

/** Tool name of a call whose tool is only known when the script runs */
export const DYNAMIC_TOOL_NAME = '<dynamic>';

export interface ToolReference {
  /** The tool's name, or `<dynamic>` */
  toolName: string;
  isStaticName: boolean;
}

export interface ToolReferenceNode {
  type?: string;
  name?: string;
  value?: unknown;
  computed?: boolean;
  object?: ToolReferenceNode;
  property?: ToolReferenceNode;
  callee?: ToolReferenceNode;
  arguments?: ToolReferenceNode[];
  expressions?: ToolReferenceNode[];
  quasis?: Array<{ value?: { cooked?: string | null } }>;
}

/** Namespace name -> method name -> tool name */
export type ToolNamespaceIndex = ReadonlyMap<string, ReadonlyMap<string, string>>;

export function indexToolNamespaces(namespaces: ReadonlyArray<NormalizedToolNamespace> = []): ToolNamespaceIndex {
  const index = new Map<string, Map<string, string>>();
  for (const namespace of namespaces) {
    if (typeof namespace?.name !== 'string' || !Array.isArray(namespace.methods)) {
      continue;
    }
    const methods = new Map<string, string>();
    for (const method of namespace.methods) {
      if (typeof method?.name === 'string' && typeof method.toolName === 'string') {
        methods.set(method.name, method.toolName);
      }
    }
    index.set(namespace.name, methods);
  }
  return index;
}

/** A string literal, or a template literal without substitutions */
export function staticString(node: ToolReferenceNode | undefined): string | undefined {
  if (node?.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node?.type === 'TemplateLiteral' && node.expressions?.length === 0 && node.quasis?.length === 1) {
    const cooked = node.quasis[0].value?.cooked;
    return typeof cooked === 'string' ? cooked : undefined;
  }
  return undefined;
}

/** `mail.send`, `mail['send']` (static) or `mail[name]` (dynamic) on a tool namespace */
export function toolReferenceOfMember(
  namespaces: ToolNamespaceIndex,
  member: ToolReferenceNode | undefined,
): ToolReference | undefined {
  if (member?.type !== 'MemberExpression' || member.object?.type !== 'Identifier') {
    return undefined;
  }
  const methods = namespaces.get(member.object.name ?? '');
  if (!methods) {
    return undefined;
  }
  const methodName = member.computed
    ? staticString(member.property)
    : member.property?.type === 'Identifier'
      ? member.property.name
      : undefined;
  if (methodName === undefined) {
    return member.computed ? { toolName: DYNAMIC_TOOL_NAME, isStaticName: false } : undefined;
  }
  const toolName = methods.get(methodName);
  return toolName === undefined ? undefined : { toolName, isStaticName: true };
}

/** The tool of `callTool(name, args)`, `__safe_callTool(name, args)` or a namespace method call */
export function toolReferenceOfCallee(
  namespaces: ToolNamespaceIndex,
  callee: ToolReferenceNode | undefined,
  args: ToolReferenceNode[] | undefined,
): ToolReference | undefined {
  if (callee?.type === 'Identifier') {
    if (callee.name !== 'callTool' && callee.name !== '__safe_callTool') {
      return undefined;
    }
    const toolName = staticString(args?.[0]);
    return toolName === undefined
      ? { toolName: DYNAMIC_TOOL_NAME, isStaticName: false }
      : { toolName, isStaticName: true };
  }
  return toolReferenceOfMember(namespaces, callee);
}

/** The second argument of `callTool`, the first of a namespace method */
export function toolArgumentsOf(call: ToolReferenceNode): ToolReferenceNode | undefined {
  const args = call.arguments ?? [];
  return call.callee?.type === 'Identifier' ? args[1] : args[0];
}
