import * as acorn from 'acorn';
import type * as ESTree from 'estree';
import { InterpreterError } from '../interpreter';
import { BINARY_OPERATORS, Op, UNARY_OPERATORS, UPDATE_DECREMENT, UPDATE_PREFIX } from './ops';

export class Code {
  readonly ops: number[] = [];
  readonly consts: unknown[] = [];
  nlocals = 0;
  simpleParams = 0;
  constructor(
    readonly id: number,
    readonly name: string,
  ) {}
}

export interface StatementInfo {
  type: string;
  line: number;
  column: number;
}

export interface CompiledProgram {
  source: string;
  hash: string;
  codes: Code[];
  statements: StatementInfo[];
}

interface Binding {
  idx: number;
  mutable: boolean;
}

class CScope {
  readonly names = new Map<string, Binding>();
  constructor(readonly parent: CScope | null) {}
  declare(name: string, mutable: boolean): void {
    if (this.names.has(name)) throw new InterpreterError(`'${name}' has already been declared`);
    this.names.set(name, { idx: this.names.size, mutable });
  }
}

interface LoopContext {
  breakDepth: number;
  continueDepth: number;
  breaks: number[];
  continues: number[];
}

type FunctionNode = ESTree.FunctionDeclaration | ESTree.FunctionExpression | ESTree.ArrowFunctionExpression;

interface FnState {
  code: Code;
  scope: CScope;
  depth: number;
  loops: LoopContext[];
  chainExits: number[][];
}

function fnv1a(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function patternNames(pattern: ESTree.Pattern, out: string[]): void {
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern.name);
      return;
    case 'ObjectPattern':
      for (const p of pattern.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out);
      return;
    case 'ArrayPattern':
      for (const el of pattern.elements) if (el) patternNames(el, out);
      return;
    case 'RestElement':
      patternNames(pattern.argument, out);
      return;
    case 'AssignmentPattern':
      patternNames(pattern.left, out);
      return;
    default:
      throw new InterpreterError(`Unsupported pattern: ${pattern.type}`);
  }
}

export function compile(source: string): CompiledProgram {
  const program = acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    locations: true,
  }) as unknown as ESTree.Program;
  const compiler = new Compiler();
  compiler.compileProgram(program);
  return { source, hash: fnv1a(source), codes: compiler.codes, statements: compiler.statements };
}

class Compiler {
  readonly codes: Code[] = [];
  readonly statements: StatementInfo[] = [];
  private fn!: FnState;

  compileProgram(program: ESTree.Program): void {
    const code = new Code(0, 'main');
    this.codes.push(code);
    const scope = new CScope(null);
    this.fn = { code, scope, depth: 1, loops: [], chainExits: [] };
    this.compileBody(program.body as ESTree.Statement[], scope);
    this.emit(Op.UNDEF, 0);
    this.emit(Op.RET, 0);
    code.nlocals = scope.names.size;
  }

  private emit(op: Op, arg: number): number {
    const ops = this.fn.code.ops;
    ops.push(op, arg);
    return ops.length - 2;
  }

  private here(): number {
    return this.fn.code.ops.length;
  }

  private patch(at: number, target: number): void {
    this.fn.code.ops[at + 1] = target;
  }

  private constant(value: unknown): number {
    const consts = this.fn.code.consts;
    const at = consts.indexOf(value);
    if (at >= 0 && typeof value !== 'object') return at;
    consts.push(value);
    return consts.length - 1;
  }

  private declareAll(statements: ESTree.Statement[], scope: CScope): void {
    for (const s of statements) {
      if (s.type === 'VariableDeclaration') {
        const names: string[] = [];
        for (const d of s.declarations) patternNames(d.id, names);
        for (const n of names) scope.declare(n, s.kind !== 'const');
      } else if (s.type === 'FunctionDeclaration' && s.id) {
        scope.declare(s.id.name, false);
      }
    }
  }

  private compileBody(statements: ESTree.Statement[], scope: CScope): void {
    this.declareAll(statements, scope);
    for (const s of statements) {
      if (s.type === 'FunctionDeclaration' && s.id) {
        this.emit(Op.CLOSURE, this.compileFunction(s, s.id.name));
        this.emit(Op.DECL, this.resolve(s.id.name)!.addr);
      }
    }
    for (const s of statements) if (s.type !== 'FunctionDeclaration') this.statement(s);
  }

  private compileFunction(node: FunctionNode, name: string): number {
    if (node.generator) throw new InterpreterError('Generator functions are not supported');
    const code = new Code(this.codes.length, name);
    this.codes.push(code);
    const saved = this.fn;
    const scope = new CScope(saved.scope);
    this.fn = { code, scope, depth: 1, loops: [], chainExits: [] };
    const simple = node.params.every((p) => p.type === 'Identifier');
    if (simple) {
      for (const p of node.params) scope.declare((p as ESTree.Identifier).name, true);
      code.simpleParams = node.params.length;
    } else {
      code.simpleParams = -1;
      const names: string[] = [];
      for (const p of node.params) patternNames(p, names);
      for (const n of names) scope.declare(n, true);
      node.params.forEach((p, i) => {
        this.emit(Op.DUP, 0);
        if (p.type === 'RestElement') {
          this.emit(Op.REST, i);
          this.pattern(p.argument, true);
        } else {
          this.emit(Op.CONST, this.constant(i));
          this.emit(Op.GETELEM, 0);
          this.pattern(p, true);
        }
      });
      this.emit(Op.POP, 0);
    }
    if (node.body.type === 'BlockStatement') {
      this.compileBody(node.body.body, scope);
      this.emit(Op.UNDEF, 0);
    } else {
      const loc = node.body.loc!.start;
      this.statements.push({ type: 'ReturnStatement', line: loc.line, column: loc.column });
      this.emit(Op.STMT, this.statements.length - 1);
      this.expr(node.body);
    }
    this.emit(Op.RET, 0);
    code.nlocals = scope.names.size;
    this.fn = saved;
    return code.id;
  }

  private resolve(name: string): { addr: number; binding: Binding } | undefined {
    let depth = 0;
    for (let s: CScope | null = this.fn.scope; s; s = s.parent, depth++) {
      const binding = s.names.get(name);
      if (binding) return { addr: (depth << 16) | binding.idx, binding };
    }
    return undefined;
  }

  private pushScope(statements: ESTree.Statement[], extra: (scope: CScope) => void = () => undefined): boolean {
    const scope = new CScope(this.fn.scope);
    extra(scope);
    this.declareAll(statements, scope);
    if (scope.names.size === 0) return false;
    this.fn.scope = scope;
    this.fn.depth++;
    this.emit(Op.PUSHENV, scope.names.size);
    return true;
  }

  private popScope(): void {
    this.emit(Op.POPENV, 0);
    this.fn.scope = this.fn.scope.parent!;
    this.fn.depth--;
  }

  private statement(node: ESTree.Statement): void {
    if (node.type !== 'BlockStatement') {
      const loc = node.loc!.start;
      this.statements.push({ type: node.type, line: loc.line, column: loc.column });
      this.emit(Op.STMT, this.statements.length - 1);
    }
    switch (node.type) {
      case 'VariableDeclaration':
        for (const d of node.declarations) {
          if (d.init) this.expr(d.init);
          else this.emit(Op.UNDEF, 0);
          this.pattern(d.id, true);
        }
        return;
      case 'FunctionDeclaration':
        return;
      case 'ExpressionStatement':
        this.expr(node.expression);
        this.emit(Op.POP, 0);
        return;
      case 'BlockStatement': {
        const pushed = this.pushScope(node.body);
        for (const s of node.body) {
          if (s.type === 'FunctionDeclaration' && s.id) {
            this.emit(Op.CLOSURE, this.compileFunction(s, s.id.name));
            this.emit(Op.DECL, this.resolve(s.id.name)!.addr);
          }
        }
        for (const s of node.body) if (s.type !== 'FunctionDeclaration') this.statement(s);
        if (pushed) this.popScope();
        return;
      }
      case 'IfStatement': {
        this.expr(node.test);
        const jf = this.emit(Op.JF, 0);
        this.statement(node.consequent);
        if (node.alternate) {
          const jmp = this.emit(Op.JMP, 0);
          this.patch(jf, this.here());
          this.statement(node.alternate);
          this.patch(jmp, this.here());
        } else {
          this.patch(jf, this.here());
        }
        return;
      }
      case 'ForOfStatement':
        return this.forOf(node);
      case 'ForStatement':
        return this.forStatement(node);
      case 'WhileStatement': {
        const top = this.here();
        this.expr(node.test);
        const jf = this.emit(Op.JF, 0);
        const loop = this.enterLoop(this.fn.depth, this.fn.depth);
        this.statement(node.body);
        this.emit(Op.JMP, top);
        this.exitLoop(loop, this.here(), top);
        this.patch(jf, this.here());
        return;
      }
      case 'ReturnStatement':
        if (node.argument) this.expr(node.argument);
        else this.emit(Op.UNDEF, 0);
        this.emit(Op.RET, 0);
        return;
      case 'ThrowStatement':
        this.expr(node.argument);
        this.emit(Op.THROW, 0);
        return;
      case 'BreakStatement':
      case 'ContinueStatement': {
        if (node.label) throw new InterpreterError('Labels are not supported');
        const loop = this.fn.loops[this.fn.loops.length - 1];
        if (!loop) throw new InterpreterError(`${node.type} outside a loop`);
        const isBreak = node.type === 'BreakStatement';
        const target = isBreak ? loop.breakDepth : loop.continueDepth;
        for (let d = this.fn.depth; d > target; d--) this.emit(Op.POPENV, 0);
        (isBreak ? loop.breaks : loop.continues).push(this.emit(Op.JMP, 0));
        return;
      }
      case 'EmptyStatement':
        return;
      default:
        throw new InterpreterError(`Unsupported statement: ${node.type}`);
    }
  }

  private enterLoop(breakDepth: number, continueDepth: number): LoopContext {
    const loop: LoopContext = { breakDepth, continueDepth, breaks: [], continues: [] };
    this.fn.loops.push(loop);
    return loop;
  }

  private exitLoop(loop: LoopContext, breakTarget: number, continueTarget: number): void {
    this.fn.loops.pop();
    for (const at of loop.breaks) this.patch(at, breakTarget);
    for (const at of loop.continues) this.patch(at, continueTarget);
  }

  private forOf(node: ESTree.ForOfStatement): void {
    if (node.await) throw new InterpreterError('for await is not supported');
    this.expr(node.right);
    this.emit(Op.ITERINIT, 0);
    const base = this.fn.depth;
    const next = this.emit(Op.ITERNEXT, 0);
    const body = node.body.type === 'BlockStatement' ? node.body.body : [node.body];
    const left = node.left;
    const pushed = this.pushScope(body, (scope) => {
      if (left.type === 'VariableDeclaration') {
        const names: string[] = [];
        patternNames(left.declarations[0].id, names);
        for (const n of names) scope.declare(n, left.kind !== 'const');
      }
    });
    if (left.type === 'VariableDeclaration') this.pattern(left.declarations[0].id, true);
    else this.pattern(left as ESTree.Pattern, false);
    const loop = this.enterLoop(base, this.fn.depth);
    for (const s of body) {
      if (s.type === 'FunctionDeclaration' && s.id) {
        this.emit(Op.CLOSURE, this.compileFunction(s, s.id.name));
        this.emit(Op.DECL, this.resolve(s.id.name)!.addr);
      }
    }
    for (const s of body) if (s.type !== 'FunctionDeclaration') this.statement(s);
    const cont = this.here();
    if (pushed) this.popScope();
    this.emit(Op.JMP, next);
    const brk = this.here();
    this.emit(Op.POP, 0);
    this.exitLoop(loop, brk, cont);
    this.patch(next, this.here());
  }

  private forStatement(node: ESTree.ForStatement): void {
    const init = node.init;
    const declares = init?.type === 'VariableDeclaration' && init.kind !== 'var' ? [init] : [];
    const pushed = this.pushScope(declares);
    if (init) {
      if (init.type === 'VariableDeclaration') this.statement(init);
      else {
        this.expr(init);
        this.emit(Op.POP, 0);
      }
    }
    const top = this.here();
    let jf = -1;
    if (node.test) {
      this.expr(node.test);
      jf = this.emit(Op.JF, 0);
    }
    const loop = this.enterLoop(this.fn.depth, this.fn.depth);
    this.statement(node.body);
    const cont = this.here();
    if (pushed) this.emit(Op.COPYENV, 0);
    if (node.update) {
      this.expr(node.update);
      this.emit(Op.POP, 0);
    }
    this.emit(Op.JMP, top);
    const brk = this.here();
    this.exitLoop(loop, brk, cont);
    if (jf >= 0) this.patch(jf, brk);
    if (pushed) this.popScope();
  }

  private pattern(node: ESTree.Pattern, declare: boolean): void {
    switch (node.type) {
      case 'Identifier': {
        const found = this.resolve(node.name);
        if (!found) throw new InterpreterError(`'${node.name}' is not defined`);
        if (declare) this.emit(Op.DECL, found.addr);
        else {
          if (!found.binding.mutable) throw new InterpreterError(`Assignment to constant '${node.name}'`);
          this.emit(Op.STOREPOP, found.addr);
        }
        return;
      }
      case 'ObjectPattern':
        for (const p of node.properties) {
          if (p.type === 'RestElement') throw new InterpreterError('Object rest is not supported');
          this.emit(Op.DUP, 0);
          if (p.computed) {
            this.expr(p.key as ESTree.Expression);
            this.emit(Op.GETELEM, 0);
          } else {
            this.emit(Op.GETPROP, this.constant(this.keyName(p.key)));
          }
          this.pattern(p.value, declare);
        }
        this.emit(Op.POP, 0);
        return;
      case 'ArrayPattern':
        node.elements.forEach((el, i) => {
          if (!el) return;
          this.emit(Op.DUP, 0);
          if (el.type === 'RestElement') {
            this.emit(Op.REST, i);
            this.pattern(el.argument, declare);
          } else {
            this.emit(Op.CONST, this.constant(i));
            this.emit(Op.GETELEM, 0);
            this.pattern(el, declare);
          }
        });
        this.emit(Op.POP, 0);
        return;
      case 'AssignmentPattern': {
        const skip = this.emit(Op.JNUK, 0);
        this.expr(node.right);
        this.patch(skip, this.here());
        this.pattern(node.left, declare);
        return;
      }
      default:
        throw new InterpreterError(`Unsupported pattern: ${node.type}`);
    }
  }

  private keyName(key: ESTree.Expression | ESTree.PrivateIdentifier): string {
    if (key.type === 'Identifier') return key.name;
    if (key.type === 'Literal') return String(key.value);
    throw new InterpreterError('Unsupported property key');
  }

  private expr(node: ESTree.Expression | ESTree.SpreadElement | ESTree.Super | ESTree.PrivateIdentifier): void {
    switch (node.type) {
      case 'Literal':
        if ((node as ESTree.RegExpLiteral).regex) throw new InterpreterError('Regular expressions are not supported');
        if (node.value === undefined) this.emit(Op.UNDEF, 0);
        else this.emit(Op.CONST, this.constant(node.value));
        return;
      case 'Identifier': {
        if (node.name === 'undefined') {
          this.emit(Op.UNDEF, 0);
          return;
        }
        const found = this.resolve(node.name);
        if (found) this.emit(Op.LOAD, found.addr);
        else this.emit(Op.GLOBAL, this.constant(node.name));
        return;
      }
      case 'TemplateLiteral': {
        for (const e of node.expressions) this.expr(e);
        this.emit(Op.TPL, this.constant(node.quasis.map((q) => q.value.cooked ?? '')));
        return;
      }
      case 'ArrayExpression':
        this.emit(Op.NEWARR, 0);
        for (const el of node.elements) {
          if (!el) {
            this.emit(Op.UNDEF, 0);
            this.emit(Op.APPEND, 0);
          } else if (el.type === 'SpreadElement') {
            this.expr(el.argument);
            this.emit(Op.SPREAD, 0);
          } else {
            this.expr(el);
            this.emit(Op.APPEND, 0);
          }
        }
        return;
      case 'ObjectExpression':
        this.emit(Op.NEWOBJ, 0);
        for (const p of node.properties) {
          if (p.type === 'SpreadElement') {
            this.expr(p.argument);
            this.emit(Op.OBJSPREAD, 0);
            continue;
          }
          if (p.kind !== 'init' || p.method)
            throw new InterpreterError('Getters, setters and methods are not supported');
          if (p.computed) {
            this.expr(p.key as ESTree.Expression);
            this.expr(p.value as ESTree.Expression);
            this.emit(Op.DEFELEM, 0);
          } else {
            this.expr(p.value as ESTree.Expression);
            this.emit(Op.DEFPROP, this.constant(this.keyName(p.key)));
          }
        }
        return;
      case 'UnaryExpression': {
        if (node.operator === 'delete') throw new InterpreterError('delete is not supported');
        if (node.operator === 'typeof' && node.argument.type === 'Identifier' && !this.resolve(node.argument.name)) {
          this.emit(Op.GLOBAL, this.constant(node.argument.name));
        } else {
          this.expr(node.argument);
        }
        this.emit(Op.UN, UNARY_OPERATORS.indexOf(node.operator as (typeof UNARY_OPERATORS)[number]));
        return;
      }
      case 'BinaryExpression': {
        const code = BINARY_OPERATORS.indexOf(node.operator as (typeof BINARY_OPERATORS)[number]);
        if (code < 0) throw new InterpreterError(`Unsupported operator: ${node.operator}`);
        this.expr(node.left);
        this.expr(node.right);
        this.emit(Op.BIN, code);
        return;
      }
      case 'LogicalExpression': {
        this.expr(node.left);
        const jump = this.emit(node.operator === '&&' ? Op.JFK : node.operator === '||' ? Op.JTK : Op.JNNK, 0);
        this.expr(node.right);
        this.patch(jump, this.here());
        return;
      }
      case 'ConditionalExpression': {
        this.expr(node.test);
        const jf = this.emit(Op.JF, 0);
        this.expr(node.consequent);
        const jmp = this.emit(Op.JMP, 0);
        this.patch(jf, this.here());
        this.expr(node.alternate);
        this.patch(jmp, this.here());
        return;
      }
      case 'SequenceExpression':
        node.expressions.forEach((e, i) => {
          this.expr(e);
          if (i < node.expressions.length - 1) this.emit(Op.POP, 0);
        });
        return;
      case 'ChainExpression': {
        this.fn.chainExits.push([]);
        this.expr(node.expression);
        const exits = this.fn.chainExits.pop()!;
        for (const at of exits) this.patch(at, this.here());
        return;
      }
      case 'MemberExpression':
        this.expr(node.object);
        this.optional(node.optional);
        if (node.computed) {
          this.expr(node.property);
          this.emit(Op.GETELEM, 0);
        } else {
          this.emit(Op.GETPROP, this.constant(this.keyName(node.property)));
        }
        return;
      case 'CallExpression':
        return this.call(node);
      case 'NewExpression': {
        this.expr(node.callee);
        for (const a of node.arguments) {
          if (a.type === 'SpreadElement') throw new InterpreterError('Spread in new is not supported');
          this.expr(a);
        }
        this.emit(Op.NEW, node.arguments.length);
        return;
      }
      case 'AwaitExpression':
        this.expr(node.argument);
        this.emit(Op.AWAIT, 0);
        return;
      case 'AssignmentExpression':
        return this.assignment(node);
      case 'UpdateExpression':
        return this.update(node);
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        this.emit(
          Op.CLOSURE,
          this.compileFunction(node, node.type === 'FunctionExpression' && node.id ? node.id.name : 'anonymous'),
        );
        return;
      default:
        throw new InterpreterError(`Unsupported expression: ${node.type}`);
    }
  }

  private optional(optional: boolean): void {
    if (!optional) return;
    const exits = this.fn.chainExits[this.fn.chainExits.length - 1];
    exits.push(this.emit(Op.OPTJ, 0));
  }

  private args(args: (ESTree.Expression | ESTree.SpreadElement)[]): boolean {
    const spread = args.some((a) => a.type === 'SpreadElement');
    if (!spread) {
      for (const a of args) this.expr(a);
      return false;
    }
    this.emit(Op.NEWARR, 0);
    for (const a of args) {
      if (a.type === 'SpreadElement') {
        this.expr(a.argument);
        this.emit(Op.SPREAD, 0);
      } else {
        this.expr(a);
        this.emit(Op.APPEND, 0);
      }
    }
    return true;
  }

  private call(node: ESTree.SimpleCallExpression): void {
    const callee = node.callee;
    if (callee.type === 'MemberExpression') {
      this.expr(callee.object);
      this.optional(callee.optional);
      this.emit(Op.DUP, 0);
      if (callee.computed) {
        this.expr(callee.property);
        this.emit(Op.GETELEM, 0);
      } else {
        this.emit(Op.GETPROP, this.constant(this.keyName(callee.property)));
      }
      this.optional(node.optional);
      const spread = this.args(node.arguments);
      this.emit(spread ? Op.CALLMA : Op.CALLM, node.arguments.length);
      return;
    }
    if (callee.type === 'Super') throw new InterpreterError('super is not supported');
    this.expr(callee);
    this.optional(node.optional);
    const spread = this.args(node.arguments);
    this.emit(spread ? Op.CALLA : Op.CALL, node.arguments.length);
  }

  private assignment(node: ESTree.AssignmentExpression): void {
    const op = node.operator;
    const left = node.left;
    if (left.type === 'Identifier') {
      const found = this.resolve(left.name);
      if (!found) throw new InterpreterError(`'${left.name}' is not defined`);
      if (!found.binding.mutable) throw new InterpreterError(`Assignment to constant '${left.name}'`);
      if (op === '=') {
        this.expr(node.right);
      } else if (op === '&&=' || op === '||=' || op === '??=') {
        this.emit(Op.LOAD, found.addr);
        const jump = this.emit(op === '&&=' ? Op.JFK : op === '||=' ? Op.JTK : Op.JNNK, 0);
        this.expr(node.right);
        this.emit(Op.STORE, found.addr);
        this.patch(jump, this.here());
        return;
      } else {
        this.emit(Op.LOAD, found.addr);
        this.expr(node.right);
        this.emit(Op.BIN, this.binaryOf(op));
      }
      this.emit(Op.STORE, found.addr);
      return;
    }
    if (left.type === 'MemberExpression') {
      this.expr(left.object);
      const key = left.computed ? -1 : this.constant(this.keyName(left.property));
      if (left.computed) this.expr(left.property);
      if (op === '=') {
        this.expr(node.right);
      } else if (op === '&&=' || op === '||=' || op === '??=') {
        this.emit(left.computed ? Op.DUP2 : Op.DUP, 0);
        this.emit(left.computed ? Op.GETELEM : Op.GETPROP, key);
        const jump = this.emit(op === '&&=' ? Op.JFK : op === '||=' ? Op.JTK : Op.JNNK, 0);
        this.expr(node.right);
        this.emit(left.computed ? Op.SETELEM : Op.SETPROP, key);
        const end = this.emit(Op.JMP, 0);
        this.patch(jump, this.here());
        this.emit(Op.NIP, left.computed ? 2 : 1);
        this.patch(end, this.here());
        return;
      } else {
        this.emit(left.computed ? Op.DUP2 : Op.DUP, 0);
        this.emit(left.computed ? Op.GETELEM : Op.GETPROP, key);
        this.expr(node.right);
        this.emit(Op.BIN, this.binaryOf(op));
      }
      this.emit(left.computed ? Op.SETELEM : Op.SETPROP, key);
      return;
    }
    if (op !== '=') throw new InterpreterError('Unsupported assignment target');
    this.expr(node.right);
    this.emit(Op.DUP, 0);
    this.pattern(left, false);
  }

  private binaryOf(op: string): number {
    const code = BINARY_OPERATORS.indexOf(op.slice(0, -1) as (typeof BINARY_OPERATORS)[number]);
    if (code < 0) throw new InterpreterError(`Unsupported operator: ${op}`);
    return code;
  }

  private update(node: ESTree.UpdateExpression): void {
    const flags = (node.operator === '--' ? UPDATE_DECREMENT : 0) | (node.prefix ? UPDATE_PREFIX : 0);
    const arg = node.argument;
    if (arg.type === 'Identifier') {
      const found = this.resolve(arg.name);
      if (!found) throw new InterpreterError(`'${arg.name}' is not defined`);
      if (!found.binding.mutable) throw new InterpreterError(`Assignment to constant '${arg.name}'`);
      this.emit(Op.UPDVAR, found.addr | flags);
      return;
    }
    if (arg.type === 'MemberExpression') {
      this.expr(arg.object);
      if (arg.computed) {
        this.expr(arg.property);
        this.emit(Op.UPDELEM, flags);
      } else {
        this.emit(Op.UPDPROP, this.constant(this.keyName(arg.property)) | flags);
      }
      return;
    }
    throw new InterpreterError('Unsupported update target');
  }
}
