import * as walk from 'acorn-walk';
import { ValidationRule, ValidationContext, ValidationSeverity } from '../interfaces';
import { walkAll, type AnyNode } from '../utils/ast-walk';
import { sharedScopes } from '../utils/scope-analysis';
import { evaluateStatic } from '../utils/static-eval';
import { memberKeyNames, peekKeyNames, propertyKeyNames } from './static-keys';

/** Timers that compile their first argument into code when it is not a function. */
const STRING_TIMERS: ReadonlySet<string> = new Set(['setTimeout', 'setInterval']);

/** Functions that compile a string they are given. */
const CODE_FUNCTIONS: ReadonlySet<string> = new Set(['eval', 'Function']);

/** How the name of a timer is read where it is a computed key: through the variables of the script. */
const KEYS = { variables: true };

/** `list[0]`: the first argument a call gets when `...list` is its first argument. */
function firstElementOf(list: AnyNode): AnyNode {
  return {
    type: 'MemberExpression',
    object: list,
    property: { type: 'Literal', value: 0, raw: '0' },
    computed: true,
    optional: false,
  };
}

/** Methods and functions whose result is a text or a list, never a function. */
const TEXT_RESULTS: ReadonlySet<string> = new Set([
  'String',
  'charAt',
  'concat',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'entries',
  'escape',
  'filter',
  'flat',
  'flatMap',
  'fromCharCode',
  'fromCodePoint',
  'join',
  'keys',
  'map',
  'normalize',
  'padEnd',
  'padStart',
  'raw',
  'repeat',
  'replace',
  'replaceAll',
  'reverse',
  'slice',
  'sort',
  'split',
  'stringify',
  'substr',
  'substring',
  'toExponential',
  'toFixed',
  'toISOString',
  'toJSON',
  'toLocaleLowerCase',
  'toLocaleString',
  'toLocaleUpperCase',
  'toLowerCase',
  'toPrecision',
  'toString',
  'toUpperCase',
  'trim',
  'trimEnd',
  'trimStart',
  'unescape',
  'values',
]);

/**
 * Whether an expression can never be a function, whatever it holds: a text (a template, a string
 * something is added to, the result of a method that gives a text), a list or an object. A timer
 * converts such an argument to a string and compiles it; that its text is only known at run time
 * does not make it a function.
 */
function isNeverFunction(node: AnyNode): boolean {
  switch (node?.type) {
    case 'Literal':
      return typeof node.value === 'string';
    case 'TemplateLiteral':
    case 'ArrayExpression':
    case 'ObjectExpression':
      return true;
    case 'ParenthesizedExpression':
    case 'ChainExpression':
      return isNeverFunction(node.expression);
    case 'AwaitExpression':
      return isNeverFunction(node.argument);
    case 'BinaryExpression':
      return node.operator === '+' && (isNeverFunction(node.left) || isNeverFunction(node.right));
    case 'AssignmentExpression':
      return isNeverFunction(node.right);
    case 'SequenceExpression':
      return isNeverFunction(node.expressions?.[node.expressions.length - 1]);
    case 'ConditionalExpression':
      return isNeverFunction(node.consequent) || isNeverFunction(node.alternate);
    case 'LogicalExpression':
      return isNeverFunction(node.left) || isNeverFunction(node.right);
    case 'NewExpression':
      return node.callee?.type === 'Identifier' && node.callee.name === 'String';
    case 'TaggedTemplateExpression': {
      // String.raw`...` is a text
      const tag: AnyNode = node.tag;
      return tag?.type === 'MemberExpression' && !tag.computed && tag.property?.name === 'raw';
    }
    case 'CallExpression': {
      let callee: AnyNode = node.callee;
      while (callee?.type === 'ChainExpression' || callee?.type === 'ParenthesizedExpression')
        callee = callee.expression;
      if (callee?.type === 'Identifier') return TEXT_RESULTS.has(callee.name);
      if (callee?.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') {
        return TEXT_RESULTS.has(callee.property.name);
      }
      return false;
    }
    default:
      return false;
  }
}

function locationOf(node: AnyNode): { line: number; column: number } | undefined {
  return node?.loc ? { line: node.loc.start.line, column: node.loc.start.column } : undefined;
}

/**
 * Rule that prevents usage of eval and related constructs
 *
 * Blocks:
 * - eval() calls
 * - new Function() calls
 * - setTimeout/setInterval with a string as the first argument, in every spelling of the string
 *   that is made of constants (a literal, a template literal, pieces that are joined, a `const`,
 *   the first element of a list that is spread), or that is a string whatever its text is (a
 *   template, a string something is added to, `String(value)`); called by name or as a member
 *   (`window.setTimeout(...)`), with `new`, or as the tag of a template. A first argument that is
 *   a function, or whose kind is only known at run time, is not refused.
 * - setTimeout/setInterval used as a value (stored in a variable, passed to a function, taken out
 *   of an object under another name, called through `.call`, `.apply` or `.bind`): the call that follows is out of this rule's sight, and
 *   can be given a string. A timer is called where it is named. `typeof setTimeout` is allowed.
 * - with statements (scope manipulation)
 * - dynamic import() expressions (code loading)
 */
export class NoEvalRule implements ValidationRule {
  readonly name = 'no-eval';
  readonly description = 'Prevents usage of eval and dynamic code execution';
  readonly defaultSeverity = ValidationSeverity.ERROR;
  readonly enabledByDefault = true;

  validate(context: ValidationContext): void {
    // The timer references that are called where they stand: their first argument is checked
    const called = new Set<unknown>();

    const checkTimerCall = (callee: AnyNode, args: AnyNode[]): void => {
      const reference = this.timerReference(callee, context);
      if (!reference) return;
      called.add(reference.node);
      // The first argument the timer gets: `...list` may give none, so what follows it may be first
      let count = 0;
      while (count < args.length && args[count].type === 'SpreadElement') count++;
      if (args.slice(0, count + 1).some((argument) => this.isCode(argument, context))) {
        context.report({
          code: 'NO_EVAL',
          message: `Use of ${reference.name} with string argument is not allowed (acts like eval)`,
          location: locationOf(callee),
        });
      }
    };

    walk.simple(context.ast as any, {
      CallExpression: (node: AnyNode) => {
        const callee = node.callee;

        // Check for eval()
        if (callee.type === 'Identifier' && callee.name === 'eval') {
          context.report({
            code: 'NO_EVAL',
            message: 'Use of eval() is not allowed',
            location: locationOf(callee),
          });
        }

        // `Function('code')` compiles like `new Function('code')`
        if (callee.type === 'Identifier' && callee.name === 'Function') {
          context.report({
            code: 'NO_EVAL',
            message: 'Use of Function constructor is not allowed (acts like eval)',
            location: locationOf(callee),
          });
        }

        // Check for setTimeout/setInterval with string argument
        checkTimerCall(callee, node.arguments ?? []);
      },

      NewExpression: (node: AnyNode) => {
        const callee = node.callee;

        // Check for new Function()
        if (callee.type === 'Identifier' && callee.name === 'Function') {
          context.report({
            code: 'NO_EVAL',
            message: 'Use of Function constructor is not allowed (acts like eval)',
            location: locationOf(callee),
          });
        }

        checkTimerCall(callee, node.arguments ?? []);
      },

      TaggedTemplateExpression: (node: AnyNode) => {
        // A timer as a tag gets the pieces of the template, which it converts to a string
        const reference = this.timerReference(node.tag, context);
        if (!reference) return;
        called.add(reference.node);
        context.report({
          code: 'NO_EVAL',
          message: `Use of ${reference.name} with string argument is not allowed (acts like eval)`,
          location: locationOf(node.tag),
        });
      },

      WithStatement: (node: AnyNode) => {
        // Check for with statement (scope manipulation)
        context.report({
          code: 'NO_EVAL',
          message: 'Use of with statement is not allowed (manipulates scope)',
          location: locationOf(node),
        });
      },

      ImportExpression: (node: AnyNode) => {
        // Check for dynamic import() expressions
        context.report({
          code: 'NO_EVAL',
          message: 'Dynamic import() is not allowed (enables dynamic code loading)',
          location: locationOf(node),
        });
      },
    });

    this.checkTimerValues(context, called);
  }

  /**
   * A timer that is not called where it is named is a value: it is stored, passed on, or called
   * through `.call`, `.apply` or `.bind`, and what it is then called with is not seen here.
   */
  private checkTimerValues(context: ValidationContext, called: ReadonlySet<unknown>): void {
    const report = (timer: string, node: AnyNode): void => {
      context.report({
        code: 'NO_EVAL',
        message: `Use of ${timer} as a value is not allowed (it can then be called with a string, which acts like eval)`,
        location: locationOf(node),
        data: { timer, position: 'value' },
      });
    };

    // By name. A function the script declares under the name is the script's; a `var` of the
    // name at the top of a script is still the timer of the host.
    for (const reference of sharedScopes(context.ast).references) {
      if (!reference.read) continue;
      const parent = reference.parent;
      if (parent?.type === 'UnaryExpression' && parent.operator === 'typeof') continue;

      if (STRING_TIMERS.has(reference.name)) {
        if (called.has(reference.node) || reference.binding?.kind === 'function') continue;
        report(reference.name, reference.node);
      } else if (CODE_FUNCTIONS.has(reference.name) && !reference.resolved) {
        // `eval` and `Function` under another name compile what they are given all the same.
        // (Called by name they are reported above; `x instanceof Function` uses neither.)
        const isCallee =
          (parent?.type === 'CallExpression' || parent?.type === 'NewExpression') && parent.callee === reference.node;
        const isTest = parent?.type === 'BinaryExpression' && parent.operator === 'instanceof';
        if (isCallee || isTest) continue;
        context.report({
          code: 'NO_EVAL',
          message: `Use of ${reference.name} as a value is not allowed (it can then be called out of sight)`,
          location: locationOf(reference.node),
          data: { function: reference.name, position: 'value' },
        });
      }
    }

    walkAll(context.ast, (node, ancestors) => {
      // As a member: `window.setTimeout`, `timers['setTimeout']`
      if (node.type === 'MemberExpression' && !called.has(node)) {
        const names = node.computed
          ? peekKeyNames(context, node.property, KEYS)
          : node.property?.type === 'Identifier'
            ? [String(node.property.name)]
            : [];
        const timer = names.find((name) => STRING_TIMERS.has(name));
        if (timer === undefined) return;

        let child: AnyNode = node;
        let index = ancestors.length - 1;
        while (ancestors[index]?.type === 'ChainExpression' || ancestors[index]?.type === 'ParenthesizedExpression') {
          child = ancestors[index];
          index--;
        }
        const parent = ancestors[index];
        if (parent?.type === 'UnaryExpression' && (parent.operator === 'typeof' || parent.operator === 'delete'))
          return;
        // `scheduler.setTimeout = fn` defines one; it does not use one
        if (parent?.type === 'AssignmentExpression' && parent.left === child && parent.operator === '=') return;
        report(timer, node);
        return;
      }

      // Taken out of an object under another name: `const { setTimeout: later } = scheduler`
      if (node.type === 'Property' && ancestors[ancestors.length - 1]?.type === 'ObjectPattern') {
        const names = node.computed ? peekKeyNames(context, node.key, KEYS) : propertyKeyNames(context, node);
        const timers = names.filter((name) => STRING_TIMERS.has(name));
        if (timers.length === 0) return;
        // Under its own name it is called by that name, and the call is checked. (A computed key
        // may be one of several names: every timer among them has to be that name.)
        const target = node.value?.type === 'AssignmentPattern' ? node.value.left : node.value;
        if (target?.type === 'Identifier' && timers.every((name) => name === target.name)) return;
        report(timers[0], node.key);
      }
    });
  }

  /** The timer a callee names: `setTimeout`, `timers.setTimeout`, `timers['setTimeout']`. */
  private timerReference(callee: AnyNode, context: ValidationContext): { name: string; node: AnyNode } | undefined {
    let target = callee;
    while (target?.type === 'ChainExpression' || target?.type === 'ParenthesizedExpression') target = target.expression;
    if (target?.type === 'Identifier') {
      return STRING_TIMERS.has(target.name) ? { name: target.name, node: target } : undefined;
    }
    if (target?.type === 'MemberExpression') {
      const name = memberKeyNames(context, target, KEYS).find((key) => STRING_TIMERS.has(key));
      return name === undefined ? undefined : { name, node: target };
    }
    return undefined;
  }

  /**
   * Whether a timer would compile its first argument: the argument is, or may be, something
   * other than a function. A string in any spelling that is made of constants, an array or an
   * object (they are converted to a string), a variable the script can be seen assigning one of
   * these to, the first element of a list that is spread, and constants that cannot be
   * evaluated. A function and a value that is only known at run time are left alone.
   */
  private isCode(argument: AnyNode, context: ValidationContext): boolean {
    if (argument.type === 'Literal') return typeof argument.value === 'string';
    if (isNeverFunction(argument)) return true;
    // `timer(...list)`: a list that is written out gives its first element
    if (argument.type === 'SpreadElement' && argument.argument?.type === 'ArrayExpression') {
      const first: AnyNode = argument.argument.elements?.[0];
      if (first && first.type !== 'SpreadElement' && isNeverFunction(first)) return true;
    }
    const expression = argument.type === 'SpreadElement' ? firstElementOf(argument.argument) : argument;
    return evaluateStatic(context.ast, expression, { variables: true }).some(
      (value) =>
        value.type === 'unresolved' ||
        value.type === 'object' ||
        (value.type === 'primitive' && typeof value.value === 'string'),
    );
  }
}
