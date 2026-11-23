import * as acorn from 'acorn';
import {
  AGENTSCRIPT_PERMISSIVE_GLOBALS,
  analyzeScopes,
  normalizeToolNamespaces,
  type NormalizedToolNamespace,
  type ScopeBinding,
  type ScopeReference,
  type ToolNamespaces,
} from '@enclave-vm/ast';
import { indexToolNamespaces, toolArgumentsOf, toolReferenceOfCallee } from './tool-references';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- acorn does not export per-node types
type AnyNode = any;

export interface ScriptLocation {
  line: number;
  column: number;
}

export interface ScriptToolCall {
  /** null when the script computes the tool's name */
  toolName: string | null;
  /** The arguments written as literals; null when the arguments are not an object literal */
  args: Record<string, unknown> | null;
  /** The argument properties whose value is only known at run time (`...` for a spread) */
  computedArgs: string[];
  location: ScriptLocation;
  /** How many loops repeat the call: loop statements, iteration callbacks, `parallel(items, fn)` */
  loopDepth: number;
  insideParallel: boolean;
}

export interface ScriptFlow {
  /** Index in `toolCalls` of the call whose result flows, or null when the value's origin is unknown */
  from: number | null;
  /** Index in `toolCalls` of the call whose arguments receive the value */
  to: number;
  /** The variables the value was followed through, from the result to the arguments */
  via: string[];
}

export interface ScriptLoopBound {
  location: ScriptLocation;
  /** Indexes in `toolCalls` of the calls whose results the loop goes over */
  over: number[];
  /** The literal number of items the loop is cut to (`.slice(0, 20)`), or null */
  limit: number | null;
  /** Indexes in `toolCalls` of the calls the loop repeats */
  calls: number[];
  /** The most tool calls the loop makes, or null when the source does not bound it */
  maxCalls: number | null;
  /** Whether `maxCalls` is within the `callBudget` given to the analysis */
  withinBudget?: boolean;
}

export interface ScriptAnalysis {
  toolCalls: ScriptToolCall[];
  flows: ScriptFlow[];
  bounds: ScriptLoopBound[];
  /** false when the script has more tool calls than the analysis lists */
  complete: boolean;
}

export interface ScriptAnalysisOptions {
  toolNamespaces?: ToolNamespaces | ReadonlyArray<NormalizedToolNamespace>;
  /** The tool calls one run may make (`maxToolCalls`) */
  callBudget?: number;
}

export class ScriptAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptAnalysisError';
  }
}

const MAX_LISTED_CALLS = 1000;
const MAX_TRACKED_ORIGINS = 32;
const MAX_LIMIT_DEPTH = 16;
const UNKNOWN_ORIGIN = -1;
const NOT_LITERAL = Symbol('not literal');

const REPEATED_LOOP_PARTS: Readonly<Record<string, readonly string[]>> = {
  ForStatement: ['test', 'update', 'body'],
  ForInStatement: ['left', 'body'],
  ForOfStatement: ['left', 'body'],
  WhileStatement: ['test', 'body'],
  DoWhileStatement: ['body', 'test'],
};
const ITERATION_METHODS = new Set([
  'forEach',
  'map',
  'flatMap',
  'filter',
  'reduce',
  'reduceRight',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
]);
const ITEM_KEEPING_METHODS = new Set(['map', 'filter', 'reverse', 'toReversed', 'sort', 'toSorted']);
const MUTATING_METHODS = new Set(['push', 'unshift', 'splice', 'fill', 'set', 'add']);
const ARRAY_CHANGING_METHODS = new Set([...MUTATING_METHODS, 'pop', 'shift', 'sort', 'reverse', 'copyWithin']);
const PARALLEL_NAMES = new Set(['parallel', '__safe_parallel']);
const BUILT_IN_NAMES = new Set([...AGENTSCRIPT_PERMISSIVE_GLOBALS, ...PARALLEL_NAMES]);
const RUNTIME_PREFIXES = ['__safe_', '__ag_'];
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

interface PathStep {
  node: AnyNode;
  key: string;
}

interface LoopEntry {
  node: AnyNode;
  iterable: AnyNode | null;
  directCalls: number[];
  allCalls: number[];
  nested: LoopEntry[];
}

interface Collected {
  origins: Set<number>;
  deps: Set<ScopeBinding>;
  freeNames: Set<string>;
}

function emptyCollected(): Collected {
  return { origins: new Set(), deps: new Set(), freeNames: new Set() };
}

/** A name the language or the AgentScript runtime provides: its value comes from no outside source */
function isBuiltInName(name: string): boolean {
  return BUILT_IN_NAMES.has(name) || RUNTIME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isNode(value: unknown): value is AnyNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

function appendTo<K, V>(lists: Map<K, V[]>, key: K, value: V): void {
  const list = lists.get(key);
  if (list) list.push(value);
  else lists.set(key, [value]);
}

function forEachChild(node: AnyNode, visit: (child: AnyNode, key: string) => void): void {
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) if (isNode(item)) visit(item, key);
    } else if (isNode(child)) {
      visit(child, key);
    }
  }
}

/** Whether code mentions `arguments`, outside the non-arrow functions nested in it */
function mentionsArguments(node: AnyNode): boolean {
  if (node.type === 'Identifier') return node.name === 'arguments';
  if (node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration') return false;
  let found = false;
  forEachChild(node, (child) => {
    found = found || mentionsArguments(child);
  });
  return found;
}

/** Whether a callback can get the array it is called for: as the parameter at `arrayParam`, a rest parameter or `arguments` */
function mayReceiveArray(callback: AnyNode, arrayParam: number): boolean {
  if (!FUNCTION_TYPES.has(callback?.type)) return true;
  if (callback.params.length > arrayParam) return true;
  if (callback.params.some((param: AnyNode) => param.type === 'RestElement')) return true;
  return callback.type !== 'ArrowFunctionExpression' && mentionsArguments(callback.body);
}

function walkWithPath(root: AnyNode, visit: (node: AnyNode, path: readonly PathStep[]) => void): void {
  const path: PathStep[] = [];
  const descend = (node: AnyNode, key: string): void => {
    path.push({ node, key });
    visit(node, path);
    forEachChild(node, descend);
    path.pop();
  };
  descend(root, '');
}

function literalValue(node: AnyNode): unknown {
  switch (node?.type) {
    case 'Literal':
      return node.regex || node.bigint !== undefined ? NOT_LITERAL : node.value;
    case 'TemplateLiteral':
      return node.expressions.length === 0 && typeof node.quasis[0]?.value?.cooked === 'string'
        ? node.quasis[0].value.cooked
        : NOT_LITERAL;
    case 'UnaryExpression':
      return node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number'
        ? -node.argument.value
        : NOT_LITERAL;
    case 'ArrayExpression': {
      const items = node.elements.map((element: AnyNode) =>
        isNode(element) && element.type !== 'SpreadElement' ? literalValue(element) : NOT_LITERAL,
      );
      return items.includes(NOT_LITERAL) ? NOT_LITERAL : items;
    }
    case 'ObjectExpression': {
      const entries: Array<[string, unknown]> = [];
      for (const property of node.properties) {
        const key = propertyKey(property);
        const value = key === undefined ? NOT_LITERAL : literalValue(property.value);
        if (value === NOT_LITERAL) return NOT_LITERAL;
        entries.push([key as string, value]);
      }
      return Object.fromEntries(entries);
    }
    default:
      return NOT_LITERAL;
  }
}

function propertyKey(property: AnyNode): string | undefined {
  if (property.type !== 'Property' || property.kind !== 'init' || property.method) return undefined;
  if (!property.computed && property.key.type === 'Identifier') return property.key.name;
  const key = literalValue(property.key);
  return typeof key === 'string' || typeof key === 'number' ? String(key) : undefined;
}

function describeArguments(argsNode: AnyNode): Pick<ScriptToolCall, 'args' | 'computedArgs'> {
  if (argsNode === undefined) return { args: {}, computedArgs: [] };
  if (argsNode.type !== 'ObjectExpression') return { args: null, computedArgs: [] };
  const entries: Array<[string, unknown]> = [];
  const computedArgs: string[] = [];
  for (const property of argsNode.properties) {
    if (property.type === 'SpreadElement') {
      computedArgs.push('...');
      continue;
    }
    const key = propertyKey(property);
    const value = key === undefined ? NOT_LITERAL : literalValue(property.value);
    if (value === NOT_LITERAL) computedArgs.push(key ?? '[computed]');
    else entries.push([key as string, value]);
  }
  return { args: Object.fromEntries(entries), computedArgs };
}

function rootIdentifier(node: AnyNode): AnyNode | undefined {
  let current = node;
  while (current?.type === 'MemberExpression' || current?.type === 'ChainExpression') {
    current = current.type === 'ChainExpression' ? current.expression : current.object;
  }
  return current?.type === 'Identifier' ? current : undefined;
}

function staticMethodName(callee: AnyNode): string | undefined {
  if (callee?.type !== 'MemberExpression') return undefined;
  if (!callee.computed && callee.property.type === 'Identifier') return callee.property.name;
  const name = literalValue(callee.property);
  return typeof name === 'string' ? name : undefined;
}

function integerLiteral(node: AnyNode): number | undefined {
  const value = literalValue(node);
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function sliceLimit(args: AnyNode[], receiverLimit: number | null): number | null {
  const start = args.length > 0 ? integerLiteral(args[0]) : 0;
  const end = args.length > 1 ? integerLiteral(args[1]) : undefined;
  let limit: number | null = null;
  if (start !== undefined && end !== undefined && start >= 0 && end >= 0) limit = Math.max(0, end - start);
  else if (start !== undefined && start < 0 && args.length < 2) limit = -start;
  if (limit === null) return receiverLimit;
  return receiverLimit === null ? limit : Math.min(limit, receiverLimit);
}

/** Static facts about a script's tool calls for a reviewer: parses it, runs nothing, best effort. */
export function analyzeScript(code: string, options: ScriptAnalysisOptions = {}): ScriptAnalysis {
  if (typeof code !== 'string') throw new TypeError('analyzeScript: the script must be a string');
  const callBudget = options.callBudget;
  if (callBudget !== undefined && !(Number.isInteger(callBudget) && callBudget >= 0)) {
    throw new TypeError('analyzeScript: callBudget must be a non-negative integer');
  }
  const namespaces = indexToolNamespaces(
    Array.isArray(options.toolNamespaces)
      ? (options.toolNamespaces as ReadonlyArray<NormalizedToolNamespace>)
      : normalizeToolNamespaces(options.toolNamespaces as ToolNamespaces | undefined),
  );

  let ast: AnyNode;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
    });
  } catch (error) {
    throw new ScriptAnalysisError(`The script could not be parsed: ${(error as Error).message}`);
  }

  const scopes = analyzeScopes(ast);
  const referenceOf = new Map<AnyNode, ScopeReference>(
    scopes.references.map((reference): [AnyNode, ScopeReference] => [reference.node, reference]),
  );
  const declarationOf = new Map<AnyNode, ScopeBinding>();
  for (const binding of scopes.bindings) {
    if (!declarationOf.has(binding.node)) declarationOf.set(binding.node, binding);
    for (const redeclaration of binding.redeclarations ?? []) declarationOf.set(redeclaration.node, binding);
  }
  const bindingOf = (identifier: AnyNode): ScopeBinding | undefined =>
    declarationOf.get(identifier) ?? referenceOf.get(identifier)?.binding;

  const sourcesOf = new Map<ScopeBinding, AnyNode[]>();
  const unknownBindings = new Set<ScopeBinding>(
    scopes.bindings.filter((binding) => binding.redeclarations?.length || binding.startsAs || binding.initializes),
  );
  const bindPattern = (pattern: AnyNode, source: AnyNode | null): void => {
    switch (pattern?.type) {
      case 'Identifier':
      case 'MemberExpression':
      case 'ChainExpression': {
        const binding = bindingOf(pattern.type === 'Identifier' ? pattern : rootIdentifier(pattern));
        if (!binding) return;
        if (source === null) unknownBindings.add(binding);
        else appendTo(sourcesOf, binding, source);
        return;
      }
      case 'ObjectPattern':
        for (const property of pattern.properties) {
          bindPattern(property.type === 'RestElement' ? property.argument : property.value, source);
        }
        return;
      case 'ArrayPattern':
        for (const element of pattern.elements) bindPattern(element, source);
        return;
      case 'RestElement':
        bindPattern(pattern.argument, source);
        return;
      case 'AssignmentPattern':
        bindPattern(pattern.left, source);
        bindPattern(pattern.left, pattern.right);
        return;
    }
  };

  const callNodes: AnyNode[] = [];
  const callIndexOf = new Map<AnyNode, number>();
  const toolCalls: ScriptToolCall[] = [];
  const loops: LoopEntry[] = [];
  const statementLoops = new Map<AnyNode, LoopEntry>();
  const callbackLoops = new Map<AnyNode, LoopEntry>();
  const parallelFunctions = new Set<AnyNode>();
  let complete = true;

  const enclosingLoops = (path: readonly PathStep[]): LoopEntry[] => {
    const enclosing: LoopEntry[] = [];
    for (let depth = 0; depth < path.length - 1; depth++) {
      const ancestor = path[depth].node;
      const statementLoop = statementLoops.get(ancestor);
      if (statementLoop && REPEATED_LOOP_PARTS[ancestor.type].includes(path[depth + 1].key)) {
        enclosing.push(statementLoop);
      }
      const callbackLoop = callbackLoops.get(ancestor);
      if (callbackLoop) enclosing.push(callbackLoop);
    }
    return enclosing;
  };
  const addLoop = (node: AnyNode, iterable: AnyNode | null, path: readonly PathStep[]): LoopEntry => {
    const entry: LoopEntry = { node, iterable, directCalls: [], allCalls: [], nested: [] };
    enclosingLoops(path).at(-1)?.nested.push(entry);
    loops.push(entry);
    return entry;
  };

  const parentOf = new Map<AnyNode, PathStep>();
  walkWithPath(ast, (node, path) => {
    parentOf.set(node, { node: path[path.length - 2]?.node, key: path[path.length - 1].key });
    if (REPEATED_LOOP_PARTS[node.type]) {
      const iterable = node.type === 'ForOfStatement' || node.type === 'ForInStatement' ? node.right : null;
      statementLoops.set(node, addLoop(node, iterable, path));
      if (iterable) {
        bindPattern(node.left.type === 'VariableDeclaration' ? node.left.declarations[0].id : node.left, iterable);
      }
    } else if (node.type === 'VariableDeclarator' && node.init) {
      bindPattern(node.id, node.init);
    } else if (node.type === 'AssignmentExpression') {
      bindPattern(node.left, node.right);
    } else if (node.type === 'CatchClause' && node.param) {
      bindPattern(node.param, null);
    } else if (FUNCTION_TYPES.has(node.type)) {
      if (node.type === 'FunctionDeclaration' && node.id) bindPattern(node.id, node);
      const loop = callbackLoops.get(node);
      for (const param of node.params) bindPattern(param, loop?.iterable ?? null);
    } else if (node.type === 'CallExpression') {
      const method = staticMethodName(node.callee);
      if (method !== undefined && MUTATING_METHODS.has(method)) {
        for (const argument of node.arguments) bindPattern(node.callee.object, argument);
      }
      const [first, second] = node.arguments;
      if (method !== undefined && ITERATION_METHODS.has(method) && FUNCTION_TYPES.has(first?.type)) {
        callbackLoops.set(first, addLoop(first, node.callee.object, path));
      }
      if (node.callee.type === 'Identifier' && PARALLEL_NAMES.has(node.callee.name)) {
        if (FUNCTION_TYPES.has(second?.type)) {
          callbackLoops.set(second, addLoop(second, first, path));
          parallelFunctions.add(second);
        }
        for (const task of first?.type === 'ArrayExpression' ? first.elements : []) {
          if (FUNCTION_TYPES.has(task?.type)) parallelFunctions.add(task);
        }
      }
      const reference = toolReferenceOfCallee(namespaces, node.callee, node.arguments);
      if (reference) {
        if (toolCalls.length >= MAX_LISTED_CALLS) {
          complete = false;
          return;
        }
        const index = toolCalls.length;
        const enclosing = enclosingLoops(path);
        for (const loop of enclosing) loop.allCalls.push(index);
        enclosing.at(-1)?.directCalls.push(index);
        callIndexOf.set(node, index);
        callNodes.push(node);
        toolCalls.push({
          toolName: reference.isStaticName ? reference.toolName : null,
          ...describeArguments(toolArgumentsOf(node)),
          location: { line: node.loc.start.line, column: node.loc.start.column },
          loopDepth: enclosing.length,
          insideParallel: path.some((step) => parallelFunctions.has(step.node)),
        });
      }
    }
  });

  const collectReturns = (fn: AnyNode, into: Collected): void => {
    if (fn.expression) {
      collect(fn.body, into);
      return;
    }
    const search = (node: AnyNode): void => {
      if (FUNCTION_TYPES.has(node.type)) return;
      if (node.type === 'ReturnStatement') collect(node.argument, into);
      forEachChild(node, search);
    };
    forEachChild(fn.body, search);
  };
  const collect = (node: AnyNode, into: Collected): void => {
    if (!isNode(node)) return;
    const callIndex = callIndexOf.get(node);
    if (callIndex !== undefined) {
      into.origins.add(callIndex);
      return;
    }
    switch (node.type) {
      case 'Identifier': {
        const reference = referenceOf.get(node);
        if (reference?.read && reference.binding) into.deps.add(reference.binding);
        else if (reference?.read && !reference.resolved && !isBuiltInName(node.name)) into.freeNames.add(node.name);
        return;
      }
      case 'ThisExpression':
      case 'Super':
        into.origins.add(UNKNOWN_ORIGIN);
        return;
      case 'ConditionalExpression':
        collect(node.consequent, into);
        collect(node.alternate, into);
        return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        collectReturns(node, into);
        return;
    }
    forEachChild(node, (child) => collect(child, into));
  };

  const resolved = new Map<ScopeBinding, Map<number, ScopeBinding | null>>();
  const dependents = new Map<ScopeBinding, ScopeBinding[]>();
  const queue: Array<[ScopeBinding, number]> = [];
  const addOrigin = (binding: ScopeBinding, origin: number, from: ScopeBinding | null): void => {
    const origins = resolved.get(binding) ?? new Map<number, ScopeBinding | null>();
    resolved.set(binding, origins);
    const tracked = origins.size >= MAX_TRACKED_ORIGINS ? UNKNOWN_ORIGIN : origin;
    if (origins.has(tracked)) return;
    origins.set(tracked, tracked === origin ? from : null);
    queue.push([binding, tracked]);
  };
  for (const binding of unknownBindings) addOrigin(binding, UNKNOWN_ORIGIN, null);
  for (const [binding, sources] of sourcesOf) {
    const into = emptyCollected();
    for (const source of sources) collect(source, into);
    if (into.freeNames.size > 0) addOrigin(binding, UNKNOWN_ORIGIN, null);
    for (const origin of into.origins) addOrigin(binding, origin, null);
    for (const dep of into.deps) appendTo(dependents, dep, binding);
  }
  while (queue.length > 0) {
    const [binding, origin] = queue.pop() as [ScopeBinding, number];
    for (const dependent of dependents.get(binding) ?? []) addOrigin(dependent, origin, binding);
  }

  const pathTo = (binding: ScopeBinding, origin: number): string[] => {
    const names: string[] = [];
    for (let current: ScopeBinding | null | undefined = binding; current; ) {
      names.unshift(current.name);
      current = resolved.get(current)?.get(origin);
    }
    return names;
  };
  const originsOf = (nodes: AnyNode[]): Map<number, string[]> => {
    const into = emptyCollected();
    for (const node of nodes) collect(node, into);
    const origins = new Map<number, string[]>([...into.origins].map((origin): [number, string[]] => [origin, []]));
    if (into.freeNames.size > 0 && !origins.has(UNKNOWN_ORIGIN)) origins.set(UNKNOWN_ORIGIN, [...into.freeNames]);
    for (const dep of into.deps) {
      for (const origin of resolved.get(dep)?.keys() ?? []) {
        if (!origins.has(origin)) origins.set(origin, pathTo(dep, origin));
      }
    }
    return origins;
  };

  const flows: ScriptFlow[] = [];
  callNodes.forEach((node, index) => {
    const inputs = [...node.arguments, ...(node.callee.computed ? [node.callee.property] : [])];
    for (const [origin, via] of originsOf(inputs)) {
      flows.push({ from: origin === UNKNOWN_ORIGIN ? null : origin, to: index, via });
    }
  });

  const referencesOf = new Map<ScopeBinding, AnyNode[]>();
  for (const reference of scopes.references) {
    if (reference.binding) appendTo(referencesOf, reference.binding, reference.node);
  }
  const isWriteTarget = (member: AnyNode): boolean => {
    const { node: holder, key } = parentOf.get(member) ?? { node: undefined, key: '' };
    switch (holder?.type) {
      case 'AssignmentExpression':
      case 'AssignmentPattern':
      case 'ForOfStatement':
      case 'ForInStatement':
        return key === 'left';
      case 'UpdateExpression':
      case 'ArrayPattern':
      case 'RestElement':
        return true;
      case 'UnaryExpression':
        return holder.operator === 'delete';
      case 'Property':
        return parentOf.get(holder)?.node?.type === 'ObjectPattern';
      default:
        return false;
    }
  };
  // A read that leaves the array as it is and keeps it under its name: anything else drops its bound
  const isPlainRead = (identifier: AnyNode): boolean => {
    const { node: holder, key } = parentOf.get(identifier) ?? { node: undefined, key: '' };
    if (holder?.type === 'ForOfStatement' || holder?.type === 'ForInStatement') return key === 'right';
    if (holder?.type === 'CallExpression' && key === 'arguments') {
      const parallelCall = holder.callee.type === 'Identifier' && PARALLEL_NAMES.has(holder.callee.name);
      return parallelCall && holder.arguments[0] === identifier && !mayReceiveArray(holder.arguments[1], 2);
    }
    if (holder?.type !== 'MemberExpression' || key !== 'object' || isWriteTarget(holder)) return false;
    const call = parentOf.get(holder);
    if (call?.node?.type !== 'CallExpression' || call.key !== 'callee') return true;
    const method = staticMethodName(holder);
    if (method === undefined || ARRAY_CHANGING_METHODS.has(method)) return false;
    const arrayParam = method === 'reduce' || method === 'reduceRight' ? 3 : 2;
    return !ITERATION_METHODS.has(method) || !mayReceiveArray(call.node.arguments[0], arrayParam);
  };
  const limitOf = (node: AnyNode, depth = 0): number | null => {
    if (!isNode(node) || depth > MAX_LIMIT_DEPTH) return null;
    if (node.type === 'ArrayExpression') {
      return node.elements.every((element: AnyNode) => isNode(element) && element.type !== 'SpreadElement')
        ? node.elements.length
        : null;
    }
    if (node.type === 'ChainExpression') return limitOf(node.expression, depth + 1);
    if (node.type === 'Identifier') {
      const binding = referenceOf.get(node)?.binding;
      const onlyRead = binding && !unknownBindings.has(binding) && (referencesOf.get(binding) ?? []).every(isPlainRead);
      const sources = onlyRead ? sourcesOf.get(binding) : undefined;
      return sources?.length === 1 ? limitOf(sources[0], depth + 1) : null;
    }
    const method = node.type === 'CallExpression' ? staticMethodName(node.callee) : undefined;
    if (method === 'slice') return sliceLimit(node.arguments, limitOf(node.callee.object, depth + 1));
    if (method !== undefined && ITEM_KEEPING_METHODS.has(method)) return limitOf(node.callee.object, depth + 1);
    return null;
  };
  const maxCallsMemo = new Map<LoopEntry, number | null>();
  const maxCallsOf = (loop: LoopEntry): number | null => {
    if (maxCallsMemo.has(loop)) return maxCallsMemo.get(loop) as number | null;
    let perIteration: number | null = loop.directCalls.length;
    for (const nested of loop.nested) {
      const nestedCalls = maxCallsOf(nested);
      perIteration = perIteration === null || nestedCalls === null ? null : perIteration + nestedCalls;
    }
    const limit = loop.iterable ? limitOf(loop.iterable) : null;
    const maxCalls = perIteration === 0 ? 0 : perIteration === null || limit === null ? null : limit * perIteration;
    maxCallsMemo.set(loop, maxCalls);
    return maxCalls;
  };

  const bounds: ScriptLoopBound[] = [];
  for (const loop of loops) {
    const over = loop.iterable ? [...originsOf([loop.iterable]).keys()].filter((origin) => origin >= 0) : [];
    if (over.length === 0) continue;
    const maxCalls = maxCallsOf(loop);
    bounds.push({
      location: { line: loop.node.loc.start.line, column: loop.node.loc.start.column },
      over: over.sort((left, right) => left - right),
      limit: limitOf(loop.iterable),
      calls: loop.allCalls,
      maxCalls,
      ...(callBudget !== undefined ? { withinBudget: maxCalls !== null && maxCalls <= callBudget } : {}),
    });
  }

  return { toolCalls, flows, bounds, complete };
}
