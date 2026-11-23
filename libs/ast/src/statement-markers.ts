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
const MARKER_PATTERN = /^__ag_statement:(\d{1,9}):(\d{1,9}):([A-Za-z]{1,40})$/;
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

/** The location a marker statement carries, or `undefined` when `statement` is not a marker */
export function readStatementMarker(statement: unknown): StatementLocation | undefined {
  if (!isNode(statement) || statement.type !== 'ExpressionStatement') return undefined;
  const expression = statement['expression'];
  if (!isNode(expression) || expression.type !== 'Literal' || typeof expression['value'] !== 'string') return undefined;
  const match = MARKER_PATTERN.exec(expression['value']);
  return match ? { line: Number(match[1]), column: Number(match[2]), type: match[3] } : undefined;
}

function marker(statement: Node, lineOffset: number): Node {
  const start = statement.loc?.start ?? { line: lineOffset + 1, column: 0 };
  const value = `${MARKER_PREFIX}${start.line - lineOffset}:${start.column}:${statement.type}`;
  return { type: 'ExpressionStatement', expression: { type: 'Literal', value } };
}

function markedList(statements: unknown[], lineOffset: number): unknown[] {
  const marked: unknown[] = [];
  for (const statement of statements) {
    if (readStatementMarker(statement)) continue;
    if (isNode(statement) && !UNMARKED_TYPES.has(statement.type)) marked.push(marker(statement, lineOffset));
    marked.push(statement);
  }
  return marked;
}

/**
 * Put a marker with the statement's location in the script before every statement, as an inert
 * string statement, and drop the statements of the script that read as markers
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
        value.type.endsWith('Statement') &&
        value.type !== 'BlockStatement';
      node[key] = statementInPlace ? { type: 'BlockStatement', body: [value] } : value;
      markStatements(node[key] as Node, lineOffset);
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

function collectMarkers(node: Node, locations: WeakMap<object, StatementLocation>): void {
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      if (isStatementList(node, key)) node[key] = unmarkedList(value, locations);
      for (const child of node[key] as unknown[]) if (isNode(child)) collectMarkers(child, locations);
    } else if (isNode(value)) {
      collectMarkers(value, locations);
    }
  }
}

/** Take the markers out of a parsed program: the location in the script of each statement they marked */
export function takeStatementMarkers(program: object): WeakMap<object, StatementLocation> {
  const locations = new WeakMap<object, StatementLocation>();
  if (isNode(program)) collectMarkers(program, locations);
  return locations;
}
