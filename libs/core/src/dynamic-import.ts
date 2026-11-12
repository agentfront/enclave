/**
 * No dynamic import in a script, whatever checked it before
 *
 * Every validator preset refuses `import()`. A host can switch validation off, and then the
 * runtime is alone with it: a `vm` script that reaches a dynamic import is answered by Node.js
 * itself, with a promise and an error of the host realm, outside everything the sandbox wraps.
 * A `vm.Script` option does not change that. So the text that is about to be handed to an
 * adapter is looked at once more, by structure, and refused if it holds the construct.
 *
 * The text is only parsed when it contains the word at all, which a script almost never does.
 *
 * @packageDocumentation
 */

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

/** The message of the refusal. */
export const DYNAMIC_IMPORT_MESSAGE = 'Dynamic import() is not available in the sandbox';

/**
 * Why `code` may not run, or `undefined` if it holds no dynamic import.
 *
 * - `import(...)` anywhere, called or not, is refused, and so is `import.meta`.
 * - The word as a property name, in a string, in a comment or as part of a longer name is not
 *   the construct.
 * - Text that contains the word and cannot be parsed is refused as well: what cannot be read
 *   cannot be cleared.
 */
export function refuseDynamicImport(code: string): string | undefined {
  if (typeof code !== 'string' || !code.includes('import')) {
    return undefined;
  }
  let ast: acorn.Node;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowHashBang: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    }) as unknown as acorn.Node;
  } catch {
    return `${DYNAMIC_IMPORT_MESSAGE} (the script contains the word "import" and could not be parsed to rule it out)`;
  }
  let found = false;
  try {
    walk.full(ast, (node) => {
      if (node.type === 'ImportExpression') found = true;
      if (node.type === 'MetaProperty' && (node as unknown as { meta?: { name?: string } }).meta?.name === 'import') {
        found = true;
      }
    });
  } catch {
    // A tree the walker cannot finish (too deep): refuse rather than guess
    return DYNAMIC_IMPORT_MESSAGE;
  }
  return found ? DYNAMIC_IMPORT_MESSAGE : undefined;
}
