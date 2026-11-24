/** Where a statement of the script starts, and what kind of statement it is */
export interface StatementLocation {
  line: number;
  column: number;
  type: string;
}

interface Node {
  type: string;
  loc?: { start: { line: number; column: number } };
  [key: string]: unknown;
}

const MARKER_PREFIX = '__ag_statement:';
const MARKER_PATTERN = /^__ag_statement:(\d{1,9}):(\d{1,9}):([A-Za-z]{1,40})(:inline)?$/;
const INLINE_SUFFIX = ':inline';
const SINGLE_STATEMENT_KEYS = ['consequent', 'alternate', 'body'];
const UNMARKED_TYPES = new Set(['BlockStatement', 'EmptyStatement']);

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
}

function isStatementList(parent: Node, key: string): boolean {
  return (
    (key === 'body' && (parent.type === 'Program' || parent.type === 'BlockStatement')) ||
    (key === 'consequent' && parent.type === 'SwitchCase')
  );
}

/** A marker's location, and whether it stands in a block the transform made around an unbraced statement */
function readMarker(statement: unknown): { location: StatementLocation; inline: boolean } | undefined {
  if (!isNode(statement) || statement.type !== 'ExpressionStatement') return undefined;
  const expression = statement['expression'];
  if (!isNode(expression) || expression.type !== 'Literal' || typeof expression['value'] !== 'string') return undefined;
  const match = MARKER_PATTERN.exec(expression['value']);
  if (!match) return undefined;
  return { location: { line: Number(match[1]), column: Number(match[2]), type: match[3] }, inline: !!match[4] };
}

/** The location a marker statement carries, or `undefined` when `statement` is not a marker */
export function readStatementMarker(statement: unknown): StatementLocation | undefined {
  return readMarker(statement)?.location;
}

function marker(statement: Node, lineOffset: number, inline = false): Node {
  const start = statement.loc?.start ?? { line: lineOffset + 1, column: 0 };
  const value = `${MARKER_PREFIX}${start.line - lineOffset}:${start.column}:${statement.type}`;
  return {
    type: 'ExpressionStatement',
    expression: { type: 'Literal', value: inline ? value + INLINE_SUFFIX : value },
  };
}

/** The same string as a template literal: it keeps its value, and reads as no marker */
function asTemplate(statement: Node): Node {
  const text = (statement['expression'] as Node)['value'] as string;
  const quasi = { type: 'TemplateElement', value: { raw: text, cooked: text }, tail: true };
  return {
    type: 'ExpressionStatement',
    loc: statement.loc,
    expression: { type: 'TemplateLiteral', expressions: [], quasis: [quasi] },
  };
}

function markedList(statements: unknown[], lineOffset: number): unknown[] {
  const marked: unknown[] = [];
  for (const statement of statements) {
    const kept = readStatementMarker(statement) ? asTemplate(statement as Node) : statement;
    if (isNode(kept) && kept.loc && !UNMARKED_TYPES.has(kept.type)) marked.push(marker(kept, lineOffset));
    marked.push(kept);
  }
  return marked;
}

/**
 * Put a marker with the statement's location in the script before every statement, as an inert
 * string statement; a statement of the script that reads as a marker becomes a template literal
 */
export function markStatements(node: Node, lineOffset = 0): void {
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      if (isStatementList(node, key)) node[key] = markedList(value, lineOffset);
      for (const child of node[key] as unknown[]) if (isNode(child)) markStatements(child, lineOffset);
    } else if (isNode(value)) {
      const statementInPlace =
        SINGLE_STATEMENT_KEYS.includes(key) &&
        node.type.endsWith('Statement') &&
        node.type !== 'LabeledStatement' &&
        (value.type.endsWith('Statement') || value.type === 'VariableDeclaration') &&
        !UNMARKED_TYPES.has(value.type) &&
        value.loc !== undefined;
      const kept = statementInPlace && readStatementMarker(value) ? asTemplate(value) : value;
      // The block is taken away again before the run (see takeStatementMarkers): it adds no scope
      if (statementInPlace) node[key] = { type: 'BlockStatement', body: [marker(kept, lineOffset, true), kept] };
      markStatements(kept, lineOffset);
    }
  }
}

function unmarkedList(statements: unknown[], locations: WeakMap<object, StatementLocation>): unknown[] {
  const unmarked: unknown[] = [];
  let pending: StatementLocation | undefined;
  for (const statement of statements) {
    const location = readStatementMarker(statement);
    if (location) {
      pending = location;
      continue;
    }
    if (pending && isNode(statement)) locations.set(statement, pending);
    pending = undefined;
    unmarked.push(statement);
  }
  return unmarked;
}

/** The statement of a block the transform made around an unbraced statement, with its location */
function inlineMarked(block: Node): { statement: Node; location: StatementLocation } | undefined {
  const body = block['body'];
  if (block.type !== 'BlockStatement' || !Array.isArray(body) || body.length !== 2 || !isNode(body[1]))
    return undefined;
  const found = readMarker(body[0]);
  return found?.inline ? { statement: body[1], location: found.location } : undefined;
}

function collectMarkers(node: Node, locations: WeakMap<object, StatementLocation>): void {
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      if (isStatementList(node, key)) node[key] = unmarkedList(value, locations);
      for (const child of node[key] as unknown[]) if (isNode(child)) collectMarkers(child, locations);
    } else if (isNode(value)) {
      const inline = inlineMarked(value);
      if (inline) {
        node[key] = inline.statement;
        locations.set(inline.statement, inline.location);
      }
      collectMarkers(node[key] as Node, locations);
    }
  }
}

/** Take the markers out of a parsed program: the location in the script of each statement they marked */
export function takeStatementMarkers(program: object): WeakMap<object, StatementLocation> {
  const locations = new WeakMap<object, StatementLocation>();
  if (isNode(program)) collectMarkers(program, locations);
  return locations;
}
