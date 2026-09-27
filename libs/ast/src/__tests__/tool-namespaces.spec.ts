import {
  AGENTSCRIPT_DISALLOWED_IDENTIFIERS,
  createAgentScriptPreset,
  JSAstValidator,
  normalizeToolNamespaces,
  MAX_TOOL_NAMESPACE_TOOL_NAME_LENGTH,
  TOOL_NAMESPACE_TOOL_NAME_PATTERN,
} from '../index';

describe('normalizeToolNamespaces', () => {
  it('returns no namespaces for an absent configuration', () => {
    expect(normalizeToolNamespaces(undefined)).toEqual([]);
    expect(normalizeToolNamespaces(null)).toEqual([]);
  });

  it('maps method lists to "<namespace>.<method>" tool names, in order', () => {
    expect(normalizeToolNamespaces({ mail: ['list', 'send'], math: ['add'] })).toEqual([
      {
        name: 'mail',
        methods: [
          { name: 'list', toolName: 'mail.list' },
          { name: 'send', toolName: 'mail.send' },
        ],
      },
      { name: 'math', methods: [{ name: 'add', toolName: 'math.add' }] },
    ]);
  });

  it('maps methods to explicit tool names', () => {
    expect(normalizeToolNamespaces({ users: { list: 'users:list', getById: 'users:get' } })).toEqual([
      {
        name: 'users',
        methods: [
          { name: 'list', toolName: 'users:list' },
          { name: 'getById', toolName: 'users:get' },
        ],
      },
    ]);
  });

  it('allows any identifier as namespace or method when it maps to a valid tool name', () => {
    expect(normalizeToolNamespaces({ _util: { $send: 'util:send' } })).toEqual([
      { name: '_util', methods: [{ name: '$send', toolName: 'util:send' }] },
    ]);
  });

  it('accepts exactly the tool names the worker and iframe protocols accept', () => {
    for (const toolName of ['a', 'mail.list', 'users:get', 'my_tool-2', 'A.b:c_d-e']) {
      expect(TOOL_NAMESPACE_TOOL_NAME_PATTERN.test(toolName)).toBe(true);
    }
    for (const toolName of ['_a', '1a', 'a/b', 'a b', 'a$', '', 'é']) {
      expect(TOOL_NAMESPACE_TOOL_NAME_PATTERN.test(toolName)).toBe(false);
    }
  });

  it('allows reserved words as method names (they are valid property names)', () => {
    expect(normalizeToolNamespaces({ files: ['delete', 'new'] })[0].methods.map((m) => m.name)).toEqual([
      'delete',
      'new',
    ]);
  });

  it('returns frozen, plain data', () => {
    const [ns] = normalizeToolNamespaces({ mail: ['list'] });
    expect(Object.isFrozen(ns)).toBe(true);
    expect(Object.isFrozen(ns.methods)).toBe(true);
    expect(Object.isFrozen(ns.methods[0])).toBe(true);
    expect(JSON.parse(JSON.stringify(ns))).toEqual(ns);
  });

  it('refuses names reserved by the caller', () => {
    expect(() => normalizeToolNamespaces({ mail: ['list'] }, { reservedNames: ['mail'] })).toThrow(/custom global/);
  });

  const refused: Array<[string, unknown, RegExp]> = [
    ['a non-object spec', ['mail.list'], /expected an object/],
    ['a class instance as spec', new (class Spec {})(), /expected an object/],
    ['an own __proto__ namespace', JSON.parse('{"__proto__": ["list"]}'), /reserved name/],
    ['constructor as namespace', { constructor: ['list'] }, /reserved name/],
    ['prototype as namespace', { prototype: ['list'] }, /reserved name/],
    ['a runtime prefix', { __safe_mail: ['list'] }, /reserved name/],
    ['a non-identifier namespace', { 'mail-box': ['list'] }, /not a valid identifier/],
    ['a reserved word as namespace', { delete: ['all'] }, /reserved word/],
    ['undefined as namespace', { undefined: ['x'] }, /reserved word/],
    ['callTool as namespace', { callTool: ['x'] }, /shadow a sandbox global/],
    ['Math as namespace', { Math: ['max'] }, /shadow a sandbox global/],
    ['console as namespace', { console: ['log'] }, /shadow a sandbox global/],
    ['parallel as namespace', { parallel: ['x'] }, /shadow a sandbox global/],
    ['globalThis as namespace', { globalThis: ['x'] }, /shadow a sandbox global/],
    ['a validator-refused namespace', { process: ['list'] }, /AgentScript refuses/],
    ['a validator-refused namespace (fetch)', { fetch: ['get'] }, /AgentScript refuses/],
    ['constructor as method', { mail: ['constructor'] }, /reserved name/],
    ['__proto__ as method', { mail: ['__proto__'] }, /reserved name/],
    ['prototype as method', { mail: ['prototype'] }, /reserved name/],
    ['a legacy accessor as method', { mail: ['__defineGetter__'] }, /reserved name/],
    ['a non-identifier method', { mail: ['list-all'] }, /not a valid identifier/],
    ['a validator-refused method', { http: ['fetch'] }, /AgentScript refuses/],
    ['a non-string method', { mail: [1] }, /not a string/],
    ['a duplicated method', { mail: ['list', 'list'] }, /more than once/],
    ['an empty namespace', { mail: [] }, /no methods/],
    ['an empty tool name', { mail: { list: '' } }, /non-empty tool name/],
    ['a non-string tool name', { mail: { list: 3 } }, /non-empty tool name/],
    ['an oversized tool name', { mail: { list: 'x'.repeat(MAX_TOOL_NAMESPACE_TOOL_NAME_LENGTH + 1) } }, /longer than/],
    ['a namespace that is neither a list nor a map', { mail: 'list' }, /must be an array/],
    // Tool names the worker_threads and iframe protocols refuse, so every adapter refuses them
    ['a mapped tool name with a slash', { files: { get: 'files/get' } }, /not a valid tool name/],
    ['a mapped tool name starting with a digit', { files: { get: '1files' } }, /not a valid tool name/],
    ['a namespace starting with "_" (tool "_util.list")', { _util: ['list'] }, /not a valid tool name/],
    ['a namespace starting with "$" (tool "$db.get")', { $db: ['get'] }, /not a valid tool name/],
    ['a method containing "$" (tool "mail.$send")', { mail: ['$send'] }, /not a valid tool name/],
  ];

  it.each(refused)('refuses %s', (_label, spec, message) => {
    expect(() => normalizeToolNamespaces(spec)).toThrow(TypeError);
    expect(() => normalizeToolNamespaces(spec)).toThrow(message);
    expect(() => normalizeToolNamespaces(spec)).toThrow(/^Invalid toolNamespaces: /);
  });

  it('refuses every method name the AgentScript validator refuses as a property', async () => {
    const validator = new JSAstValidator(createAgentScriptPreset({ allowedGlobals: ['ns', 'callTool'] }));
    for (const name of AGENTSCRIPT_DISALLOWED_IDENTIFIERS) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue;
      expect(() => normalizeToolNamespaces({ ns: [name] })).toThrow(/Invalid toolNamespaces/);
      const result = await validator.validate(`const r = ns.${name}({});`);
      expect(result.valid).toBe(false);
    }
  });
});

describe('AGENTSCRIPT_DISALLOWED_IDENTIFIERS', () => {
  it('is frozen so it cannot be weakened at runtime', () => {
    expect(Object.isFrozen(AGENTSCRIPT_DISALLOWED_IDENTIFIERS)).toBe(true);
  });

  it('is the list the AgentScript preset blocks', async () => {
    const validator = new JSAstValidator(createAgentScriptPreset());
    const result = await validator.validate('const p = process;');
    expect(result.valid).toBe(false);
    expect(AGENTSCRIPT_DISALLOWED_IDENTIFIERS).toContain('process');
  });
});
