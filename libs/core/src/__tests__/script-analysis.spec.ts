import { analyzeScript, ScriptAnalysisError } from '../analysis/script-analysis';
import { analyzeScript as analyzeScriptFromWorkerEntry } from '../worker';

const OVERDUE_INVOICES = `
const invoices = await callTool('list_invoices', { status: 'overdue' });
for (const invoice of invoices.items) {
  await callTool('send_email', { to: invoice.email });
}
`;

describe('analyzeScript', () => {
  it('reports the calls, the literal arguments, the flow and the unbounded loop of the issue example', () => {
    const analysis = analyzeScript(OVERDUE_INVOICES);

    expect(analysis.complete).toBe(true);
    expect(analysis.toolCalls).toEqual([
      {
        toolName: 'list_invoices',
        args: { status: 'overdue' },
        computedArgs: [],
        location: { line: 2, column: 23 },
        loopDepth: 0,
        insideParallel: false,
      },
      {
        toolName: 'send_email',
        args: {},
        computedArgs: ['to'],
        location: { line: 4, column: 8 },
        loopDepth: 1,
        insideParallel: false,
      },
    ]);
    expect(analysis.flows).toEqual([{ from: 0, to: 1, via: ['invoices', 'invoice'] }]);
    expect(analysis.bounds).toEqual([
      { location: { line: 3, column: 0 }, over: [0], limit: null, calls: [1], maxCalls: null },
    ]);
  });

  it('says whether a literal bound keeps a loop over a tool result within the call budget', () => {
    const code = `
      const users = await callTool('users.list', {});
      const firstTwenty = users.slice(0, 20);
      for (const user of firstTwenty) {
        await callTool('users.notify', { id: user.id });
      }
      for (const user of users.slice(5)) {
        await callTool('users.audit', { id: user.id });
      }
    `;

    expect(analyzeScript(code, { callBudget: 25 }).bounds).toEqual([
      expect.objectContaining({ over: [0], limit: 20, calls: [1], maxCalls: 20, withinBudget: true }),
      expect.objectContaining({ over: [0], limit: null, calls: [2], maxCalls: null, withinBudget: false }),
    ]);
    expect(analyzeScript(code, { callBudget: 10 }).bounds[0].withinBudget).toBe(false);
  });

  it('multiplies the bounds of nested loops', () => {
    const code = `
      const teams = await callTool('teams.list', {});
      for (const team of teams.slice(0, 3)) {
        await callTool('teams.read', { id: team.id });
        for (const member of team.members.slice(0, 4)) {
          await callTool('members.read', { id: member.id });
        }
      }
    `;

    const [outer, inner] = analyzeScript(code, { callBudget: 100 }).bounds;
    expect(outer).toEqual(expect.objectContaining({ limit: 3, calls: [1, 2], maxCalls: 15, withinBudget: true }));
    expect(inner).toEqual(expect.objectContaining({ limit: 4, calls: [2], maxCalls: 4 }));
  });

  it('reports a call through a tool namespace as the tool it stands for', () => {
    const analysis = analyzeScript("const sent = await mail.send({ to: 'a@example.com' }); return sent;", {
      toolNamespaces: { mail: { send: 'mail_send' } },
    });

    expect(analysis.toolCalls).toEqual([
      expect.objectContaining({ toolName: 'mail_send', args: { to: 'a@example.com' }, computedArgs: [] }),
    ]);
  });

  it('gives a computed tool name as null and keeps nested literal arguments', () => {
    const analysis = analyzeScript(`
      const name = 'a' + 'b';
      await callTool(name, { filter: { tags: ['x', 'y'], limit: -1 }, ...extra, [key]: 1 });
    `);

    expect(analysis.toolCalls[0]).toEqual(
      expect.objectContaining({
        toolName: null,
        args: { filter: { tags: ['x', 'y'], limit: -1 } },
        computedArgs: ['...', '[computed]'],
      }),
    );
  });

  it('marks calls inside parallel() and counts parallel(items, fn) as a loop', () => {
    const analysis = analyzeScript(`
      const ids = await callTool('ids.list', {});
      await parallel(ids.slice(0, 10), async (id) => callTool('ids.read', { id }));
      await parallel([() => callTool('a', {}), () => callTool('b', {})]);
    `);

    expect(analysis.toolCalls.map(({ loopDepth, insideParallel }) => ({ loopDepth, insideParallel }))).toEqual([
      { loopDepth: 0, insideParallel: false },
      { loopDepth: 1, insideParallel: true },
      { loopDepth: 0, insideParallel: true },
      { loopDepth: 0, insideParallel: true },
    ]);
    expect(analysis.flows).toEqual([{ from: 0, to: 1, via: ['ids', 'id'] }]);
    expect(analysis.bounds).toEqual([expect.objectContaining({ over: [0], limit: 10, calls: [1], maxCalls: 10 })]);
  });

  it('keeps the bound of an array that parallel() goes over', () => {
    const analysis = analyzeScript(`
      const ids = await callTool('ids.list', {});
      const first = ids.slice(0, 3);
      await parallel(first, async (id) => callTool('ids.read', { id }));
    `);

    expect(analysis.bounds).toEqual([expect.objectContaining({ limit: 3, maxCalls: 3 })]);
  });

  it('follows results through array callbacks, pushes and assignments', () => {
    const analysis = analyzeScript(`
      const orders = await callTool('orders.list', {});
      const emails = orders.map((order) => order.email);
      const collected = [];
      collected.push(await callTool('profile.read', {}));
      let target;
      target = emails[0];
      await callTool('mail.send', { to: target, cc: collected });
      await callTool('audit.log', { text: 'done' });
    `);

    expect(analysis.flows).toEqual([
      { from: 0, to: 2, via: ['orders', 'emails', 'target'] },
      { from: 1, to: 2, via: ['collected'] },
    ]);
  });

  it('marks a value whose origin it cannot follow as unknown', () => {
    const analysis = analyzeScript(`
      const send = async (address) => callTool('mail.send', { to: address });
      try {
        await callTool('risky', {});
      } catch (error) {
        await callTool('report', { message: error.message });
      }
    `);

    expect(analysis.flows).toEqual([
      { from: null, to: 0, via: ['address'] },
      { from: null, to: 2, via: ['error'] },
    ]);
  });

  it('counts a call in the loop variable of for...of as repeated, and not one in what it goes over', () => {
    const analysis = analyzeScript(`
      for (const { id = await callTool('ids.next', {}) } of await callTool('items.list', {})) {
        await callTool('items.read', { id });
      }
    `);

    expect(analysis.toolCalls.map(({ toolName, loopDepth }) => [toolName, loopDepth])).toEqual([
      ['ids.next', 1],
      ['items.list', 0],
      ['items.read', 1],
    ]);
  });

  it('keeps a bound only while the cut array is only read', () => {
    const loopOver = (setup: string) =>
      analyzeScript(`
        const users = await callTool('users.list', {});
        const limited = users.slice(0, 5);
        ${setup}
        for (const user of limited) { await callTool('users.notify', { id: user.id }); }
      `).bounds[0].limit;

    expect(loopOver('')).toBe(5);
    expect(
      loopOver(
        'const count = limited.length; const names = limited.map((user) => user.name); const first = limited[0];',
      ),
    ).toBe(5);
    expect(loopOver('limited.length++;')).toBeNull();
    expect(loopOver('limited.length = 100;')).toBeNull();
    expect(loopOver('limited.sort();')).toBeNull();
    expect(loopOver('const alias = limited;')).toBeNull();
    expect(loopOver('const alias = limited; alias.push(...users);')).toBeNull();
    expect(loopOver('let alias = limited; alias[50] = users[0];')).toBeNull();
    expect(loopOver('const alias = limited || []; alias.push(2);')).toBeNull();
    expect(loopOver('const grow = (list) => list.push(1); grow(limited);')).toBeNull();
    expect(loopOver('const holder = { list: limited };')).toBeNull();
  });

  it('marks a value read from a name the script does not declare as unknown, but not a built-in or a literal', () => {
    const analysis = analyzeScript(`
      await callTool('mail.send', { to: context.email });
      await callTool('mail.send', { to: 'a@example.com', copies: Math.max(1, 2), cc: undefined, n: NaN });
      const address = context.backup;
      await callTool('mail.send', { to: address });
    `);

    expect(analysis.flows).toEqual([
      { from: null, to: 0, via: ['context'] },
      { from: null, to: 2, via: ['address'] },
    ]);
  });

  it('reads a script that is already wrapped in its main function', () => {
    const analysis = analyzeScript(`async function __ag_main() {${OVERDUE_INVOICES}}`);

    expect(analysis.toolCalls.map((call) => call.toolName)).toEqual(['list_invoices', 'send_email']);
    expect(analysis.flows).toEqual([{ from: 0, to: 1, via: ['invoices', 'invoice'] }]);
  });

  it('parses the script and runs nothing', () => {
    const marker = '__analyzeScriptRan';
    analyzeScript(`globalThis.${marker} = true; await callTool('x', {});`);

    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it('refuses a script it cannot parse', () => {
    expect(() => analyzeScript('const = 1;')).toThrow(ScriptAnalysisError);
    expect(() => analyzeScript(42 as unknown as string)).toThrow(TypeError);
    expect(() => analyzeScript('return 1;', { callBudget: -1 })).toThrow(TypeError);
  });

  it('is the same analysis from the worker entry', () => {
    expect(analyzeScriptFromWorkerEntry(OVERDUE_INVOICES)).toEqual(analyzeScript(OVERDUE_INVOICES));
  });
});
