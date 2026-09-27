/**
 * Tool Namespace Bindings
 *
 * Builds the `toolNamespaces` objects (`mail.list(args)`) INSIDE a sandbox realm. The objects and
 * their methods are created by code evaluated in that realm, so the script never receives a host
 * object: each namespace is a frozen, null-prototype object whose methods are realm-local arrow
 * functions that call the realm's own `callTool` (and therefore the enclave's tool-call gate).
 *
 * The configuration crosses into the realm as a JSON string and is parsed there. No source code is
 * generated from it; names were validated by `normalizeToolNamespaces` on the host, and the
 * factory skips prototype keys again as defense in depth.
 *
 * @packageDocumentation
 */

import type { NormalizedToolNamespace } from '@enclave-vm/ast';

/**
 * Source of an expression that, evaluated in a sandbox realm, captures that realm's `JSON.parse`
 * and `Object.freeze` and returns `install(callTool, namespacesJson)`.
 *
 * `install` returns a frozen, null-prototype map from namespace name to namespace object. Each
 * method is `(args, options) => callTool(toolName, args === undefined ? {} : args, options)`.
 */
export const TOOL_NAMESPACE_FACTORY_SOURCE = `
(function () {
  'use strict';
  var parse = JSON.parse;
  var freeze = Object.freeze;
  var isArray = Array.isArray;

  function isSafeKey(key) {
    return typeof key === 'string' && key.length > 0 &&
      !(key.charAt(0) === '_' && key.charAt(1) === '_') &&
      key !== 'constructor' && key !== 'prototype';
  }

  function bind(callTool, toolName) {
    return (args, options) => callTool(toolName, args === undefined ? {} : args, options);
  }

  return function install(callTool, namespacesJson) {
    var spec = parse(namespacesJson);
    var namespaces = { __proto__: null };
    if (isArray(spec)) {
      for (var i = 0; i < spec.length; i++) {
        var ns = spec[i];
        if (!ns || !isSafeKey(ns.name) || !isArray(ns.methods)) continue;
        var target = { __proto__: null };
        for (var j = 0; j < ns.methods.length; j++) {
          var method = ns.methods[j];
          if (!method || !isSafeKey(method.name) || typeof method.toolName !== 'string') continue;
          target[method.name] = bind(callTool, method.toolName);
        }
        freeze(target);
        namespaces[ns.name] = target;
      }
    }
    freeze(namespaces);
    return namespaces;
  };
})()
`.trim();

/** A namespace name paired with the realm-local object that implements it. */
export interface ToolNamespaceBinding {
  readonly name: string;
  readonly value: unknown;
}

/**
 * Build the namespace objects with an `install` function obtained by evaluating
 * {@link TOOL_NAMESPACE_FACTORY_SOURCE} in the sandbox realm.
 *
 * @param install The realm-local `install` function
 * @param callTool The realm's gated `callTool`
 * @param namespaces Validated namespaces
 * @returns One binding per namespace, in configuration order
 */
export function buildToolNamespaceBindings(
  install: unknown,
  callTool: unknown,
  namespaces: readonly NormalizedToolNamespace[],
): ToolNamespaceBinding[] {
  if (namespaces.length === 0) return [];
  if (typeof install !== 'function') {
    throw new Error('Tool namespace factory is not available in the sandbox');
  }
  const built = (install as (callTool: unknown, json: string) => Record<string, unknown>)(
    callTool,
    JSON.stringify(namespaces),
  );
  return namespaces.map((ns) => ({ name: ns.name, value: built[ns.name] }));
}
