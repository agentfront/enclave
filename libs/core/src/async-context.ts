/**
 * The async context a script runs in
 *
 * A host commonly calls `run()` inside `AsyncLocalStorage.run(store, ...)`: a request context, a
 * tracing span. Where the engine propagates such a store by copying it onto every async resource
 * (Node.js 22, and later versions started without async context frames), a promise that a script
 * creates in a `vm` context is such a resource: the store, an object of the host, hangs on it as
 * an own symbol-keyed property, with no membrane in between.
 *
 * So the script does not run in the caller's async context. Two async resources are made for an
 * execution:
 *
 * - one in which no store is current, for the script: what the engine copies onto the script's
 *   promises there is `undefined`;
 * - one that is the caller's context, for everything of the host that the script causes to run
 *   (the tool handler, the console handler, a function from `globals`): those still read the
 *   store of the `run()` that called them.
 *
 * Where the runtime has no `async_hooks` (a bundle for another runtime), both are plain calls.
 *
 * @packageDocumentation
 */

import { AsyncResource } from 'async_hooks';

/** The two contexts of one execution (see the module documentation). */
export interface AsyncContexts {
  /** Run `fn` in the async context of the caller of `run()`. */
  inHostContext<R>(fn: () => R): R;
  /** Run `fn` in an async context that carries no store of the host. */
  inScriptContext<R>(fn: () => R): R;
}

const PLAIN: AsyncContexts = {
  inHostContext: (fn) => fn(),
  inScriptContext: (fn) => fn(),
};

/**
 * The description of the symbol under which an `AsyncLocalStorage` keeps its store on an async
 * resource (`lib/async_hooks.js`, and `lib/internal/async_local_storage/async_hooks.js` later).
 */
const RESOURCE_STORE_SYMBOL = 'kResourceStore';

/**
 * Make the two async contexts of an execution. Call it where `run()` was called: the host
 * context is the one that is current here.
 */
export function separateAsyncContexts(): AsyncContexts {
  if (typeof AsyncResource !== 'function') {
    return PLAIN;
  }
  try {
    const host = new AsyncResource('EnclaveHostCallback');
    const script = new AsyncResource('EnclaveScript');
    // The script's resource was made in the caller's context and has its stores copied onto it
    // like any other. Without them, what is "current" inside it is no store at all.
    for (const key of Object.getOwnPropertySymbols(script)) {
      if (key.description === RESOURCE_STORE_SYMBOL) {
        delete (script as unknown as Record<symbol, unknown>)[key];
      }
    }
    return {
      inHostContext: (fn) => host.runInAsyncScope(fn),
      inScriptContext: (fn) => script.runInAsyncScope(fn),
    };
  } catch {
    return PLAIN;
  }
}
