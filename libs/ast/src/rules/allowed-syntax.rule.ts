import { ValidationRule, ValidationContext, ValidationSeverity } from '../interfaces';
import { RuleConfigurationError } from '../errors';
import { walkAll } from '../utils/ast-walk';

/**
 * Options for AllowedSyntaxRule
 */
export interface AllowedSyntaxOptions {
  /** ESTree node types a script may contain. Every other node type is refused. */
  allowedNodeTypes: readonly string[];
  /** Custom message template (use the {nodeType} and {construct} placeholders) */
  messageTemplate?: string;
}

/**
 * The node types of AgentScript v1 (after the AgentScript transformer has wrapped the script in
 * `async function __ag_main()` and rewritten its loops).
 *
 * Statement and expression forms the language is documented to have, and nothing else. In
 * particular it leaves out, because AgentScript has no use for them and each one is an escape or
 * reflection primitive:
 *
 * - `ThisExpression`: outside a method, `this` is the realm's global object, which hands a script
 *   every intrinsic the identifier rules refuse (`this[name]`).
 * - `ClassDeclaration` / `ClassExpression` / `ClassBody` / `MethodDefinition` /
 *   `PropertyDefinition` / `StaticBlock` / `Super` / `PrivateIdentifier`: classes are user-defined
 *   constructors (usable as `Symbol.species` targets and `instanceof` hooks) with `this`,
 *   `super` and initializer code that the function rules do not look at.
 * - `MetaProperty`: `new.target`, `import.meta`.
 * - `YieldExpression`, `WithStatement`, `DebuggerStatement`, `ImportExpression` and module
 *   declarations.
 *
 * `FunctionExpression`, `FunctionDeclaration` and the loop statements are listed here because
 * their own rules (`no-user-functions`, `forbidden-loop`) decide them with better messages.
 *
 * `TaggedTemplateExpression` is allowed (`String.raw` and user tags are an established part of the
 * language), with one caveat for rule authors: a tagged template is a CALL that is not a
 * `CallExpression`. A rule that checks how a function is called must either look at the function's
 * identity rather than at the call (`static-call-target` and `no-json-callbacks` do: a tag is not a
 * direct call, so `callTool\`x\`` and `JSON.parse\`x\`` are refused) or handle the node explicitly
 * (`no-regex-methods` does).
 */
export const AGENTSCRIPT_ALLOWED_NODE_TYPES: readonly string[] = Object.freeze([
  // Program structure
  'Program',
  'FunctionDeclaration', // only __ag_main: enforced by no-user-functions
  'BlockStatement',
  'ExpressionStatement',
  'EmptyStatement',
  'VariableDeclaration',
  'VariableDeclarator',
  'ReturnStatement',

  // Control flow
  'IfStatement',
  'SwitchStatement',
  'SwitchCase',
  'BreakStatement',
  'ContinueStatement',
  'LabeledStatement',
  'ThrowStatement',
  'TryStatement',
  'CatchClause',

  // Loops (which ones are usable is decided by forbidden-loop)
  'ForStatement',
  'ForOfStatement',
  'ForInStatement',
  'WhileStatement',
  'DoWhileStatement',

  // Values
  'Identifier',
  'Literal',
  'TemplateLiteral',
  'TemplateElement',
  'ArrayExpression',
  'ObjectExpression',
  'Property',
  'SpreadElement',

  // Functions (which ones are usable is decided by no-user-functions)
  'ArrowFunctionExpression',
  'FunctionExpression',

  // Operators
  'UnaryExpression',
  'UpdateExpression',
  'BinaryExpression',
  'LogicalExpression',
  'AssignmentExpression',
  'ConditionalExpression',
  'SequenceExpression',
  'AwaitExpression',

  // Calls and member access
  'CallExpression',
  'NewExpression',
  'TaggedTemplateExpression', // see the note above
  'MemberExpression',
  'ChainExpression',
  'ParenthesizedExpression',

  // Destructuring
  'ObjectPattern',
  'ArrayPattern',
  'RestElement',
  'AssignmentPattern',
]);

/** What to call a refused node type in an error message. */
const CONSTRUCT_NAMES: Record<string, string> = {
  ThisExpression: '`this`',
  Super: '`super`',
  MetaProperty: 'meta properties (`new.target`, `import.meta`)',
  ClassDeclaration: 'class declarations',
  ClassExpression: 'class expressions',
  ClassBody: 'classes',
  MethodDefinition: 'class methods',
  PropertyDefinition: 'class fields',
  StaticBlock: 'class static blocks',
  PrivateIdentifier: 'private names (`#name`)',
  YieldExpression: '`yield`',
  WithStatement: '`with` statements',
  DebuggerStatement: '`debugger` statements',
  ImportExpression: 'dynamic `import()`',
  ImportDeclaration: '`import` declarations',
  ExportNamedDeclaration: '`export` declarations',
  ExportDefaultDeclaration: '`export` declarations',
  ExportAllDeclaration: '`export` declarations',
};

/**
 * Rule that refuses every syntax node whose type is not explicitly allowed.
 *
 * The other rules name what they block, so a construct none of them names is accepted. This rule
 * is the other way around: it names what a script may be made of, and a construct that is not on
 * the list (including one a future ECMAScript version adds) is refused without anyone having to
 * think of it first.
 *
 * The walk is exhaustive (`walkAll`), so a node cannot hide in a position a per-type visitor table
 * does not descend into.
 *
 * @example
 * ```typescript
 * new AllowedSyntaxRule({ allowedNodeTypes: AGENTSCRIPT_ALLOWED_NODE_TYPES });
 * ```
 */
export class AllowedSyntaxRule implements ValidationRule {
  readonly name = 'allowed-syntax';
  readonly description = 'Refuses every syntax construct that is not explicitly allowed';
  readonly defaultSeverity = ValidationSeverity.ERROR;
  readonly enabledByDefault = true;

  private readonly allowed: ReadonlySet<string>;
  private readonly messageTemplate: string;

  constructor(options: AllowedSyntaxOptions) {
    if (!options || !Array.isArray(options.allowedNodeTypes) || options.allowedNodeTypes.length === 0) {
      throw new RuleConfigurationError('AllowedSyntaxRule requires at least one allowed node type', 'allowed-syntax');
    }
    this.allowed = new Set(options.allowedNodeTypes);
    this.messageTemplate = options.messageTemplate ?? 'Disallowed syntax: {construct} ({nodeType})';
  }

  validate(context: ValidationContext): void {
    walkAll(context.ast, (node) => {
      if (this.allowed.has(node.type)) return;

      const construct = CONSTRUCT_NAMES[node.type] ?? `"${node.type}" nodes`;
      context.report({
        code: 'DISALLOWED_SYNTAX',
        message: this.messageTemplate.replace('{construct}', construct).replace('{nodeType}', node.type),
        location: node.loc ? { line: node.loc.start.line, column: node.loc.start.column } : undefined,
        data: { nodeType: node.type },
      });
    });
  }
}
