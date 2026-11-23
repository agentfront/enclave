import * as acorn from 'acorn';

import { transformAgentScript } from '../agentscript-transformer';
import { takeStatementMarkers } from '../statement-markers';
import { extractLargeStrings } from '../transforms/string-extraction.transform';

function markedLocations(code: string): string[] {
  const transformed = transformAgentScript(code, { statementMarkers: true, maxIterations: 100 });
  const program = acorn.parse(transformed, { ecmaVersion: 'latest', sourceType: 'script' });
  const locations = takeStatementMarkers(program);
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const location = locations.get(node);
    if (location) found.push(`${location.line}:${location.column}:${location.type}`);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(program);
  return found;
}

describe('statement markers', () => {
  it('marks every statement with its place in the script as written, also when the script awaits at the top', () => {
    expect(markedLocations("const a = await callTool('x', {});\nif (a) return 1;\nreturn 2;")).toEqual([
      '1:0:VariableDeclaration',
      '2:0:IfStatement',
      '2:7:ReturnStatement',
      '3:0:ReturnStatement',
    ]);
  });

  it('marks the statements of loops, switches, labels and callbacks, and keeps a labeled loop a loop', () => {
    const code = [
      'outer: for (const a of [1]) { continue outer; }',
      'switch (1) { case 1: x(); break; }',
      'const f = (v) => { return v; };',
    ].join('\n');
    const transformed = transformAgentScript(code, { statementMarkers: true, maxIterations: 100 });
    expect(transformed).toContain('outer: for');
    expect(markedLocations(code)).toEqual([
      '1:0:LabeledStatement',
      '1:30:ContinueStatement',
      '2:0:SwitchStatement',
      '2:21:ExpressionStatement',
      '2:26:BreakStatement',
      '3:0:VariableDeclaration',
      '3:19:ReturnStatement',
    ]);
  });

  it('drops the statements of the script that read as markers, and puts none without the option', () => {
    const forged = '"__ag_statement:99:9:Forged";\nreturn 1;';
    expect(markedLocations(forged)).toEqual(['2:0:ReturnStatement']);
    expect(transformAgentScript('const a = 1;')).not.toContain('__ag_statement');
  });

  it('never moves a marker to the sidecar, whatever the extraction threshold', () => {
    const transformed = transformAgentScript('const a = 1;', { statementMarkers: true });
    const program = acorn.parse(transformed, { ecmaVersion: 'latest', sourceType: 'script' });
    const extracted: string[] = [];
    extractLargeStrings(program, { threshold: 1, onExtract: (value) => (extracted.push(value), '__REF_x__') });
    expect(extracted).toEqual([]);
  });
});
