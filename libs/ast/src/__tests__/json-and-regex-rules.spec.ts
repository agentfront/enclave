/**
 * What two options of the AgentScript rule set do:
 * - `NoJsonCallbacksRule` with `requireDirectUse`: the global `JSON` may only be used as
 *   `JSON.parse(...)` / `JSON.stringify(...)`, called directly;
 * - `NoRegexMethodsRule` with `allowStringArguments: false`: `match`, `matchAll` and `search` take
 *   no pattern, literal or not.
 */

import { JSAstValidator } from '../validator';
import { NoJsonCallbacksRule } from '../rules/no-json-callbacks.rule';
import { NoRegexMethodsRule } from '../rules/no-regex-methods.rule';
import { ValidationSeverity } from '../interfaces';

async function issues(validator: JSAstValidator, source: string) {
  const result = await validator.validate(source, {
    parseOptions: { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true },
  });
  return result.issues.map(
    (issue) => `${issue.severity === ValidationSeverity.ERROR ? 'error' : 'warning'}:${issue.code}`,
  );
}

describe('NoJsonCallbacksRule with requireDirectUse', () => {
  const validator = new JSAstValidator([new NoJsonCallbacksRule({ requireDirectUse: true })]);

  it.each([
    ['parse', 'const value = JSON.parse(text);'],
    ['stringify with indentation', 'const text = JSON.stringify(value, null, 2);'],
    ['a method name in brackets', "const text = JSON['stringify'](value);"],
    ['typeof', "const known = typeof JSON.parse === 'function';"],
  ])('accepts %s', async (_name, source) => {
    expect(await issues(validator, source)).toEqual([]);
  });

  it('flags a method other than parse and stringify', async () => {
    expect(await issues(validator, 'const copy = JSON.valueOf();')).toEqual(['error:JSON_INDIRECT_USE']);
  });

  it('checks the arguments of a call whose method name is a template literal', async () => {
    expect(await issues(validator, 'const value = JSON[`parse`](text, revive);')).toEqual([
      'error:JSON_CALLBACK_NOT_ALLOWED',
    ]);
  });

  it('leaves a variable of the script that is called JSON alone', async () => {
    expect(await issues(validator, 'const JSON = { value: 1 }; const read = JSON.value;')).toEqual([]);
  });
});

describe('NoRegexMethodsRule with allowStringArguments: false', () => {
  const validator = new JSAstValidator([new NoRegexMethodsRule({ allowStringArguments: false })]);

  it.each([
    ['a string literal', "const found = text.match('a');"],
    ['a variable', 'let text; let pattern; const found = text.match(pattern);'],
    ['a variable given to search', 'let text; let pattern; const at = text.search(pattern);'],
  ])('flags match with %s', async (_name, source) => {
    expect(await issues(validator, source)).toEqual(['error:NO_REGEX_METHOD']);
  });

  it('keeps the warning for a method of that name on a global listed in hostObjectNames', async () => {
    const withNamespace = new JSAstValidator([
      new NoRegexMethodsRule({ allowStringArguments: false, hostObjectNames: ['docs'] }),
    ]);

    expect(await issues(withNamespace, 'let args; const hits = docs.search(args);')).toEqual([
      'warning:REGEX_METHOD_DYNAMIC',
    ]);
    // A variable of the script with that name is not the global
    expect(await issues(withNamespace, 'let args; const docs = text; const hits = docs.search(args);')).toEqual([
      'error:NO_REGEX_METHOD',
    ]);
  });

  it('flags the same call on a global that is not listed: it may be a string', async () => {
    expect(await issues(validator, 'let args; const hits = docs.search(args);')).toEqual(['error:NO_REGEX_METHOD']);
  });

  it('keeps the warning when the argument is an object literal of data', async () => {
    expect(await issues(validator, 'let index; const hits = index.search({ query: 1 });')).toEqual([
      'warning:REGEX_METHOD_DYNAMIC',
    ]);
  });

  it('accepts the methods that take a string as it is', async () => {
    expect(
      await issues(validator, "let text; const parts = text.split(','); const next = text.replace('a', 'b');"),
    ).toEqual([]);
  });
});
