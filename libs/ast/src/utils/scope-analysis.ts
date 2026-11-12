/**
 * Lexical scope analysis.
 *
 * Classifies every `Identifier` in a program as a binding, a reference or a plain name, and resolves
 * each reference against the scopes that enclose it.
 *
 * Why this exists: the validator and the identifier transform used to keep ONE flat set of
 * "declared names" for the whole program. A declaration in any scope then whitelisted that name
 * everywhere, so `{ let globalThis; } globalThis` (or an arrow parameter, or a catch binding of the
 * same name) made the outer, genuinely global `globalThis` look like a local variable. They also
 * looked only at identifiers in expression position, so an assignment target (`x = 1`,
 * `[x] = y`, `for (x of y)`) was never checked at all.
 *
 * Resolution here is deliberately CONSERVATIVE: when two readings of the language disagree
 * (sloppy-mode function hoisting out of blocks), the narrower one is used, so a name is only ever
 * treated as local where it certainly is.
 *
 * @packageDocumentation
 */

import { isAstNode, type AnyNode } from './ast-walk';

/** How a binding was introduced. */
export type BindingKind = 'var' | 'let' | 'const' | 'function' | 'class' | 'param' | 'catch' | 'import';

/** An identifier that declares a variable. */
export interface ScopeBinding {
  node: AnyNode;
  name: string;
  kind: BindingKind;
}

/** An identifier that reads and/or writes a variable. */
export interface ScopeReference {
  node: AnyNode;
  name: string;
  /** The value is read (`x`, `x += 1`, `x++`, `typeof x`) */
  read: boolean;
  /** The variable is assigned (`x = 1`, `x += 1`, `x++`, `[x] = y`, `for (x of y)`, `delete x`) */
  write: boolean;
  /** A binding of this name is in scope at the reference; `false` means it reaches a global. */
  resolved: boolean;
  /** The node that holds the identifier, when there is one */
  parent?: AnyNode;
}

/** Result of {@link analyzeScopes}. */
export interface ScopeAnalysis {
  bindings: ScopeBinding[];
  references: ScopeReference[];
  /** References with `resolved === false`: these name a global, not a local variable. */
  freeReferences: ScopeReference[];
}

interface Scope {
  parent: Scope | null;
  /** The nearest enclosing function (or program) scope: where `var` lands. */
  functionScope: Scope;
  names: Set<string>;
}

interface PendingReference {
  node: AnyNode;
  scope: Scope;
  read: boolean;
  write: boolean;
  parent?: AnyNode;
}

type Role = 'read' | 'write' | 'readwrite' | 'binding';

function createScope(parent: Scope | null, isFunctionScope: boolean): Scope {
  const scope: Scope = { parent, functionScope: null as unknown as Scope, names: new Set() };
  scope.functionScope = isFunctionScope || !parent ? scope : parent.functionScope;
  return scope;
}

function isResolved(scope: Scope | null, name: string): boolean {
  for (let current = scope; current; current = current.parent) {
    if (current.names.has(name)) return true;
  }
  return false;
}

/**
 * Analyze the scopes of a parsed program (or any subtree).
 */
export function analyzeScopes(ast: unknown): ScopeAnalysis {
  const bindings: ScopeBinding[] = [];
  const pending: PendingReference[] = [];

  const declare = (scope: Scope, node: AnyNode, kind: BindingKind): void => {
    // `var` belongs to the enclosing function; everything else to the scope it is written in.
    const target = kind === 'var' ? scope.functionScope : scope;
    target.names.add(node.name);
    bindings.push({ node, name: node.name, kind });
  };

  const reference = (scope: Scope, node: AnyNode, role: Role, parent?: AnyNode): void => {
    pending.push({ node, scope, read: role !== 'write', write: role !== 'read', parent });
  };

  /** A binding pattern or an assignment target. */
  const visitPattern = (
    node: AnyNode | null | undefined,
    scope: Scope,
    role: Role,
    kind: BindingKind,
    parent?: AnyNode,
  ): void => {
    if (!node) return;
    switch (node.type) {
      case 'Identifier':
        if (role === 'binding') declare(scope, node, kind);
        else reference(scope, node, role, parent);
        return;
      case 'ObjectPattern':
        for (const property of node.properties ?? []) {
          if (property.type === 'RestElement') {
            visitPattern(property.argument, scope, role, kind, property);
          } else {
            if (property.computed) visit(property.key, scope, property);
            visitPattern(property.value, scope, role, kind, property);
          }
        }
        return;
      case 'ArrayPattern':
        for (const element of node.elements ?? []) visitPattern(element, scope, role, kind, node);
        return;
      case 'RestElement':
        visitPattern(node.argument, scope, role, kind, node);
        return;
      case 'AssignmentPattern':
        // `({ x = 1 } = obj)`: the target keeps the Property as its parent, as `({ x } = obj)` does,
        // so that a consumer that renames the target can still write the key out.
        visitPattern(node.left, scope, role, kind, parent?.type === 'Property' ? parent : node);
        visit(node.right, scope, node);
        return;
      default:
        // A member expression as an assignment target (`obj.x = 1`), or anything unexpected.
        visit(node, scope, parent);
    }
  };

  const visitFunction = (node: AnyNode, outer: Scope): void => {
    // Parameters and body are two scopes. A parameter's default value is evaluated where the
    // parameters are declared and cannot see what the body declares: in
    // `(x = globalThis) => { let globalThis; }` the default reads the GLOBAL `globalThis`. With a
    // single scope the body's declaration would have made that reference look local.
    const paramScope = createScope(outer, true);
    // A function expression's own name is visible only inside it.
    if (node.type === 'FunctionExpression' && node.id) declare(paramScope, node.id, 'function');
    for (const param of node.params ?? []) visitPattern(param, paramScope, 'binding', 'param', node);

    // The body sees the parameters; its own `var` declarations stay in the body.
    const bodyScope = createScope(paramScope, true);
    if (node.body?.type === 'BlockStatement') {
      visitStatements(node.body.body, bodyScope, node.body);
    } else {
      visit(node.body, bodyScope, node);
    }
  };

  const visitClass = (node: AnyNode, outer: Scope): void => {
    const scope = createScope(outer, false);
    if (node.type === 'ClassExpression' && node.id) declare(scope, node.id, 'class');
    visit(node.superClass, scope, node);
    for (const member of node.body?.body ?? []) {
      if (member.type === 'StaticBlock') {
        visitStatements(member.body, createScope(scope, true), member);
        continue;
      }
      if (member.computed) visit(member.key, scope, member);
      // Field initializers run as their own function; methods are function expressions.
      if (member.value)
        visit(member.value, member.type === 'PropertyDefinition' ? createScope(scope, true) : scope, member);
    }
  };

  const visitStatements = (statements: AnyNode[] | undefined, scope: Scope, parent: AnyNode): void => {
    for (const statement of statements ?? []) visit(statement, scope, parent);
  };

  const visit = (node: AnyNode | null | undefined, scope: Scope, parent?: AnyNode): void => {
    if (!isAstNode(node)) return;

    switch (node.type) {
      case 'Identifier':
        reference(scope, node, 'read', parent);
        return;

      case 'VariableDeclaration': {
        const kind: BindingKind = node.kind === 'var' ? 'var' : node.kind === 'const' ? 'const' : 'let';
        for (const declarator of node.declarations ?? []) {
          visitPattern(declarator.id, scope, 'binding', kind, declarator);
          visit(declarator.init, scope, declarator);
        }
        return;
      }

      case 'FunctionDeclaration':
        // Bound in the scope it is written in. (Sloppy mode also hoists a block-level function to
        // the enclosing function; that wider reading is not assumed.)
        if (node.id) declare(scope, node.id, 'function');
        visitFunction(node, scope);
        return;

      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        visitFunction(node, scope);
        return;

      case 'ClassDeclaration':
        if (node.id) declare(scope, node.id, 'class');
        visitClass(node, scope);
        return;

      case 'ClassExpression':
        visitClass(node, scope);
        return;

      case 'BlockStatement':
        visitStatements(node.body, createScope(scope, false), node);
        return;

      case 'ForStatement': {
        const loop = createScope(scope, false);
        visit(node.init, loop, node);
        visit(node.test, loop, node);
        visit(node.update, loop, node);
        visit(node.body, loop, node);
        return;
      }

      case 'ForInStatement':
      case 'ForOfStatement': {
        const loop = createScope(scope, false);
        if (node.left?.type === 'VariableDeclaration') visit(node.left, loop, node);
        else visitPattern(node.left, loop, 'write', 'let', node);
        visit(node.right, loop, node);
        visit(node.body, loop, node);
        return;
      }

      case 'SwitchStatement': {
        visit(node.discriminant, scope, node);
        const block = createScope(scope, false);
        for (const switchCase of node.cases ?? []) {
          visit(switchCase.test, block, switchCase);
          visitStatements(switchCase.consequent, block, switchCase);
        }
        return;
      }

      case 'CatchClause': {
        const catchScope = createScope(scope, false);
        visitPattern(node.param, catchScope, 'binding', 'catch', node);
        visit(node.body, catchScope, node);
        return;
      }

      case 'AssignmentExpression':
        // `x = 1` only writes; `x += 1` reads and writes.
        visitPattern(node.left, scope, node.operator === '=' ? 'write' : 'readwrite', 'let', node);
        visit(node.right, scope, node);
        return;

      case 'UpdateExpression':
        if (node.argument?.type === 'Identifier') reference(scope, node.argument, 'readwrite', node);
        else visit(node.argument, scope, node);
        return;

      case 'UnaryExpression':
        // `delete name` removes a (global) binding: treat it as a write.
        if (node.operator === 'delete' && node.argument?.type === 'Identifier') {
          reference(scope, node.argument, 'write', node);
        } else {
          visit(node.argument, scope, node);
        }
        return;

      case 'MemberExpression':
        visit(node.object, scope, node);
        if (node.computed) visit(node.property, scope, node);
        return;

      case 'Property':
        // Object literal member (patterns are handled by visitPattern).
        if (node.computed) visit(node.key, scope, node);
        visit(node.value, scope, node);
        return;

      case 'MethodDefinition':
      case 'PropertyDefinition':
        if (node.computed) visit(node.key, scope, node);
        visit(node.value, scope, node);
        return;

      case 'LabeledStatement':
        visit(node.body, scope, node);
        return;

      case 'BreakStatement':
      case 'ContinueStatement':
      case 'MetaProperty':
      case 'PrivateIdentifier':
        // Labels and meta-property names are not variables.
        return;

      case 'ImportDeclaration':
        for (const specifier of node.specifiers ?? []) {
          if (specifier.local) declare(scope.functionScope, specifier.local, 'import');
        }
        return;

      case 'ExportNamedDeclaration':
        visit(node.declaration, scope, node);
        if (!node.source) {
          for (const specifier of node.specifiers ?? []) {
            if (specifier.local?.type === 'Identifier') reference(scope, specifier.local, 'read', specifier);
          }
        }
        return;

      case 'ExportAllDeclaration':
        return;

      default:
        visitChildren(node, scope);
    }
  };

  /** Every other node type: all child nodes are expressions/statements in the same scope. */
  const visitChildren = (node: AnyNode, scope: Scope): void => {
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'loc' || key === 'range') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) visit(item, scope, node);
      } else if (isAstNode(child)) {
        visit(child, scope, node);
      }
    }
  };

  const root = createScope(null, true);
  if (isAstNode(ast)) {
    if (ast.type === 'Program') visitStatements(ast.body, root, ast);
    else visit(ast, root);
  }

  // Declarations are visible throughout their scope, so resolve only once every scope is complete.
  const references: ScopeReference[] = pending.map((ref) => ({
    node: ref.node,
    name: ref.node.name,
    read: ref.read,
    write: ref.write,
    resolved: isResolved(ref.scope, ref.node.name),
    parent: ref.parent,
  }));

  return { bindings, references, freeReferences: references.filter((ref) => !ref.resolved) };
}
