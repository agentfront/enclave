/**
 * Tool Namespaces
 *
 * Lets a host expose its tools to AgentScript as namespaced functions. With
 * `{ mail: ['list', 'send'] }`, `await mail.list(args)` inside the sandbox is exactly
 * `await callTool('mail.list', args)`: the same gate (tool-call cap, rate limit, suspicious-sequence
 * checks, result sanitization) and the same tool handler. A method can also name its tool
 * explicitly: `{ users: { list: 'users:list' } }`.
 *
 * This module only validates and normalizes the configuration, so every runtime that builds the
 * bindings (`@enclave-vm/core` adapters, `@enclave-vm/browser`) refuses exactly the same names.
 *
 * @packageDocumentation
 */

import { AGENTSCRIPT_DISALLOWED_IDENTIFIERS, AGENTSCRIPT_PERMISSIVE_GLOBALS } from './presets/agentscript.preset';

/**
 * Tool namespaces as a host configures them.
 *
 * - `{ mail: ['list', 'send'] }`: `mail.list(args)` calls the tool `mail.list`.
 * - `{ users: { list: 'users:list' } }`: `users.list(args)` calls the tool `users:list`.
 */
export type ToolNamespaces = Readonly<Record<string, ReadonlyArray<string> | Readonly<Record<string, string>>>>;

/** One validated namespace method: the property name and the tool it calls. */
export interface ToolNamespaceMethod {
  readonly name: string;
  readonly toolName: string;
}

/** One validated namespace, in configuration order. Plain data, safe to serialize. */
export interface NormalizedToolNamespace {
  readonly name: string;
  readonly methods: ReadonlyArray<ToolNamespaceMethod>;
}

export interface NormalizeToolNamespacesOptions {
  /**
   * Further names a namespace may not take, such as the host's custom globals
   * (a namespace would otherwise shadow, or be shadowed by, one of them).
   */
  reservedNames?: Iterable<string>;
}

/** Longest tool name a method may map to. */
export const MAX_TOOL_NAMESPACE_TOOL_NAME_LENGTH = 256;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Keys that reach a prototype instead of the object in hand. */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Words a namespace cannot be bound to: reserved words and strict-mode restricted names (a
 * binding of one is a syntax error or a shadowed language value).
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set(
  (
    'break case catch class const continue debugger default delete do else enum export extends false finally ' +
    'for function if import in instanceof new null return super switch this throw true try typeof var void ' +
    'while with yield let static implements interface package private protected public await eval arguments ' +
    'undefined NaN Infinity'
  ).split(' '),
);

/**
 * Names the sandbox already provides, or that the validator treats as global-object access.
 * A namespace with one of these names would shadow the runtime for the script.
 */
const SANDBOX_NAMES: ReadonlySet<string> = new Set([
  ...AGENTSCRIPT_PERMISSIVE_GLOBALS,
  'parallel',
  'Boolean',
  'window',
  'globalThis',
  'self',
  'global',
]);

const DISALLOWED: ReadonlySet<string> = new Set(AGENTSCRIPT_DISALLOWED_IDENTIFIERS);

function fail(message: string): never {
  throw new TypeError(`Invalid toolNamespaces: ${message}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkNamespaceName(name: string, reserved: ReadonlySet<string>): void {
  if (!IDENTIFIER.test(name)) fail(`namespace "${name}" is not a valid identifier`);
  if (name.startsWith('__') || PROTOTYPE_KEYS.has(name)) fail(`namespace "${name}" is a reserved name`);
  if (RESERVED_WORDS.has(name)) fail(`namespace "${name}" is a reserved word`);
  if (SANDBOX_NAMES.has(name)) fail(`namespace "${name}" would shadow a sandbox global`);
  if (DISALLOWED.has(name)) fail(`namespace "${name}" is an identifier AgentScript refuses`);
  if (reserved.has(name)) fail(`namespace "${name}" collides with a custom global`);
}

function checkMethodName(namespace: string, method: unknown): string {
  if (typeof method !== 'string') fail(`namespace "${namespace}" lists a method that is not a string`);
  const qualified = `${namespace}.${method}`;
  if (!IDENTIFIER.test(method)) fail(`method "${qualified}" is not a valid identifier`);
  if (method.startsWith('__') || PROTOTYPE_KEYS.has(method)) fail(`method "${qualified}" is a reserved name`);
  if (DISALLOWED.has(method)) fail(`method "${qualified}" is a property name AgentScript refuses`);
  return method;
}

function checkToolName(qualified: string, toolName: unknown): string {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    fail(`method "${qualified}" must map to a non-empty tool name`);
  }
  if (toolName.length > MAX_TOOL_NAMESPACE_TOOL_NAME_LENGTH) {
    fail(`method "${qualified}" maps to a tool name longer than ${MAX_TOOL_NAMESPACE_TOOL_NAME_LENGTH} characters`);
  }
  return toolName;
}

/**
 * Validate a `toolNamespaces` configuration and return it as plain data.
 *
 * Refuses (with a `TypeError` naming the offending entry): names that are not identifiers,
 * prototype keys (`__proto__`, `constructor`, `prototype`), names starting with `__` (reserved for
 * the runtime), reserved words and sandbox globals as namespaces, identifiers the AgentScript
 * validator refuses, namespaces that collide with `reservedNames`, duplicated methods, and empty
 * or oversized tool names.
 *
 * @param spec The host's configuration (`undefined` means no namespaces)
 * @param options Further reserved names
 * @returns The namespaces in configuration order
 */
export function normalizeToolNamespaces(
  spec: unknown,
  options: NormalizeToolNamespacesOptions = {},
): NormalizedToolNamespace[] {
  if (spec === undefined || spec === null) return [];
  if (!isPlainRecord(spec)) fail('expected an object mapping namespace names to methods');

  const reserved = new Set(options.reservedNames ?? []);
  const namespaces: NormalizedToolNamespace[] = [];

  for (const name of Object.keys(spec)) {
    checkNamespaceName(name, reserved);
    const entry = spec[name];
    const methods: ToolNamespaceMethod[] = [];
    const seen = new Set<string>();

    const add = (method: string, toolName: string): void => {
      if (seen.has(method)) fail(`method "${name}.${method}" is listed more than once`);
      seen.add(method);
      methods.push(Object.freeze({ name: method, toolName }));
    };

    if (Array.isArray(entry)) {
      for (const method of entry) {
        const checked = checkMethodName(name, method);
        add(checked, `${name}.${checked}`);
      }
    } else if (isPlainRecord(entry)) {
      for (const method of Object.keys(entry)) {
        const checked = checkMethodName(name, method);
        add(checked, checkToolName(`${name}.${checked}`, entry[method]));
      }
    } else {
      fail(`namespace "${name}" must be an array of method names or an object mapping methods to tool names`);
    }

    if (methods.length === 0) fail(`namespace "${name}" has no methods`);
    namespaces.push(Object.freeze({ name, methods: Object.freeze(methods) }));
  }

  return namespaces;
}
