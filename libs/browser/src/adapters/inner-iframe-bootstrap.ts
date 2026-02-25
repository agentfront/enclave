/**
 * Inner Iframe Bootstrap Generator
 *
 * Generates the HTML/JS content for the inner iframe where user code executes.
 * This is the innermost sandbox: it contains the safe runtime, prototype
 * hardening, frozen globals, and the user code itself.
 *
 * Communication with the outer iframe is via postMessage only.
 *
 * @packageDocumentation
 */

import { buildIframeHtml } from './iframe-html-builder';
import type { SerializedIframeConfig } from '../types';

export interface InnerIframeBootstrapOptions {
  userCode: string;
  config: SerializedIframeConfig;
  requestId: string;
}

/**
 * Generate the inner iframe HTML content
 */
export function generateInnerIframeHtml(options: InnerIframeBootstrapOptions): string {
  const { userCode, config, requestId } = options;

  const script = generateInnerIframeScript(userCode, config, requestId);
  return buildIframeHtml(script, { title: 'Enclave Inner Sandbox' });
}

function generateInnerIframeScript(userCode: string, config: SerializedIframeConfig, requestId: string): string {
  const blockedProperties = JSON.stringify(config.blockedProperties);
  const throwOnBlocked = config.throwOnBlocked;
  const maxIterations = config.maxIterations;
  const maxToolCalls = config.maxToolCalls;
  const memoryLimit = config.memoryLimit;
  const maxConsoleCalls = config.maxConsoleCalls;
  const maxConsoleOutputBytes = config.maxConsoleOutputBytes;

  return `
"use strict";
(function() {
  var requestId = ${JSON.stringify(requestId)};
  var aborted = false;
  var startTime = Date.now();
  var toolCallCount = 0;
  var iterationCount = 0;
  var consoleCalls = 0;
  var consoleOutputBytes = 0;

  // Pending tool call resolvers: callId -> { resolve, reject }
  var pendingToolCalls = {};

  // ============================================================
  // Safe Error
  // ============================================================
  function createSafeError(message, name) {
    var error = new Error(message);
    // Use _defineProperty (saved before neutralization) to set name as own property,
    // since Error.prototype.name is frozen and direct assignment throws in strict mode.
    try { _defineProperty(error, 'name', { value: name || 'Error', writable: false, configurable: false, enumerable: false }); }
    catch(e) { try { error.name = name || 'Error'; } catch(e2) {} }
    try { Object.setPrototypeOf(error, null); } catch(e) {}
    try {
      _defineProperty(error, 'constructor', { value: null, writable: false, configurable: false, enumerable: false });
      _defineProperty(error, '__proto__', { value: null, writable: false, configurable: false, enumerable: false });
      _defineProperty(error, 'stack', { value: undefined, writable: false, configurable: false, enumerable: false });
    } catch(e) {}
    try { Object.freeze(error); } catch(e) {}
    return error;
  }

  // ============================================================
  // Secure Proxy
  // ============================================================

  // Save built-in references BEFORE they get neutralized/replaced
  var _getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  var _ReflectGet = typeof Reflect !== 'undefined' ? Reflect.get : function(t,p) { return t[p]; };
  var _ReflectSet = typeof Reflect !== 'undefined' ? Reflect.set : function(t,p,v) { t[p]=v; return true; };
  var _Proxy = typeof Proxy !== 'undefined' ? Proxy : undefined;

  var blockedPropertiesSet = new Set(${blockedProperties});
  var proxyCache = new WeakMap();

  function createSecureProxy(obj, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 10) return obj;
    if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return obj;
    if (proxyCache.has(obj)) return proxyCache.get(obj);

    var proxy = new _Proxy(obj, {
      get: function(target, property, receiver) {
        var propName = String(property);
        var descriptor = _getOwnPropertyDescriptor(target, property);
        var isNonConfigurable = descriptor && !descriptor.configurable;

        if (descriptor && isNonConfigurable && 'value' in descriptor && descriptor.writable === false) {
          return descriptor.value;
        }

        if (blockedPropertiesSet.has(propName)) {
          if (isNonConfigurable) return _ReflectGet(target, property, receiver);
          ${
            throwOnBlocked
              ? `throw createSafeError("Security violation: Access to '" + propName + "' is blocked.");`
              : `return undefined;`
          }
        }

        var value = _ReflectGet(target, property, receiver);
        if (typeof value === 'function') {
          var boundMethod = value.bind(target);
          return createSecureProxy(boundMethod, depth + 1);
        }
        if (value !== null && typeof value === 'object') {
          return createSecureProxy(value, depth + 1);
        }
        return value;
      },
      set: function(target, property, value, receiver) {
        var propName = String(property);
        if (blockedPropertiesSet.has(propName)) {
          ${
            throwOnBlocked
              ? `throw createSafeError("Security violation: Setting '" + propName + "' is blocked.");`
              : `return false;`
          }
        }
        return _ReflectSet(target, property, value, receiver);
      },
      getPrototypeOf: function() { return null; }
    });

    proxyCache.set(obj, proxy);
    return proxy;
  }

  // ============================================================
  // PostMessage Communication with Outer Iframe
  // ============================================================
  function sendToOuter(msg) {
    msg.__enclave_msg__ = true;
    msg.requestId = requestId;
    try {
      window.parent.postMessage(msg, '*');
    } catch(e) { /* ignore */ }
  }

  // Listen for messages from outer iframe
  window.addEventListener('message', function(event) {
    var data = event.data;
    if (!data || data.__enclave_msg__ !== true) return;
    if (data.requestId && data.requestId !== requestId) return;

    if (data.type === 'tool-response') {
      var pending = pendingToolCalls[data.callId];
      if (pending) {
        delete pendingToolCalls[data.callId];
        if (data.error) {
          pending.reject(createSafeError(data.error.message, data.error.name));
        } else {
          pending.resolve(data.result);
        }
      }
    } else if (data.type === 'abort') {
      aborted = true;
    }
  });

  // ============================================================
  // Safe Runtime Functions
  // ============================================================

  // Generate unique call IDs
  var callIdCounter = 0;
  function generateCallId() {
    return 'c-' + (++callIdCounter) + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function __safe_callTool(toolName, args) {
    if (aborted) throw createSafeError('Execution aborted');

    toolCallCount++;
    if (toolCallCount > ${maxToolCalls}) {
      throw createSafeError('Maximum tool call limit exceeded (${maxToolCalls}).');
    }

    if (typeof toolName !== 'string' || !toolName) {
      throw createSafeError('Tool name must be a non-empty string', 'TypeError');
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw createSafeError('Tool arguments must be an object', 'TypeError');
    }

    // Double sanitization
    var sanitizedArgs;
    try { sanitizedArgs = JSON.parse(JSON.stringify(args)); }
    catch(e) { throw createSafeError('Tool arguments must be JSON-serializable'); }

    var callId = generateCallId();

    return new Promise(function(resolve, reject) {
      pendingToolCalls[callId] = { resolve: resolve, reject: reject };
      sendToOuter({
        type: 'tool-call',
        callId: callId,
        toolName: toolName,
        args: sanitizedArgs
      });
    });
  }

  function* __safe_forOf(iterable) {
    var iterations = 0;
    for (var item of iterable) {
      if (aborted) throw createSafeError('Execution aborted');
      iterations++;
      iterationCount++;
      if (iterations > ${maxIterations}) {
        throw createSafeError('Maximum iteration limit exceeded (${maxIterations}).');
      }
      yield item;
    }
  }

  function __safe_for(init, test, update, body) {
    var iterations = 0;
    init();
    while (test()) {
      if (aborted) throw createSafeError('Execution aborted');
      iterations++;
      iterationCount++;
      if (iterations > ${maxIterations}) {
        throw createSafeError('Maximum iteration limit exceeded (${maxIterations}).');
      }
      body();
      update();
    }
  }

  function __safe_while(test, body) {
    var iterations = 0;
    while (test()) {
      if (aborted) throw createSafeError('Execution aborted');
      iterations++;
      iterationCount++;
      if (iterations > ${maxIterations}) {
        throw createSafeError('Maximum iteration limit exceeded (${maxIterations}).');
      }
      body();
    }
  }

  function __safe_doWhile(body, test) {
    var iterations = 0;
    do {
      if (aborted) throw createSafeError('Execution aborted');
      iterations++;
      iterationCount++;
      if (iterations > ${maxIterations}) {
        throw createSafeError('Maximum iteration limit exceeded (${maxIterations}).');
      }
      body();
    } while (test());
  }

  function __safe_concat(left, right) {
    if (typeof left === 'number' && typeof right === 'number') return left + right;
    var result = (left) + (right);
    return result;
  }

  function __safe_template(quasis) {
    var values = [];
    for (var i = 1; i < arguments.length; i++) values.push(arguments[i]);
    var result = quasis[0];
    for (var j = 0; j < values.length; j++) {
      result += String(values[j]) + quasis[j + 1];
    }
    return result;
  }

  function __safe_parallel(fns, options) {
    if (!Array.isArray(fns)) throw createSafeError('parallel requires an array of functions', 'TypeError');
    if (fns.length === 0) return Promise.resolve([]);
    if (fns.length > 100) throw createSafeError('Cannot execute more than 100 operations in parallel.');

    for (var i = 0; i < fns.length; i++) {
      if (typeof fns[i] !== 'function') throw createSafeError('Item at index ' + i + ' is not a function', 'TypeError');
    }

    var concurrency = Math.min(Math.max(1, (options && options.maxConcurrency) || 10), 20);
    var results = new Array(fns.length);
    var errors = [];
    var currentIndex = 0;

    function runNext() {
      return new Promise(function(resolve) {
        function step() {
          if (currentIndex >= fns.length) { resolve(); return; }
          if (aborted) { resolve(); return; }
          var index = currentIndex++;
          Promise.resolve().then(function() { return fns[index](); }).then(function(result) {
            results[index] = result;
            step();
          }).catch(function(error) {
            errors.push({ index: index, error: error });
            step();
          });
        }
        step();
      });
    }

    var workers = [];
    for (var w = 0; w < Math.min(concurrency, fns.length); w++) workers.push(runNext());

    return Promise.all(workers).then(function() {
      if (errors.length > 0) {
        var msgs = errors.map(function(e) { return '[' + e.index + ']: ' + (e.error && e.error.message || e.error); }).join('\\n');
        throw createSafeError(errors.length + ' of ' + fns.length + ' parallel operations failed:\\n' + msgs);
      }
      return results;
    });
  }

  // ============================================================
  // Console Implementation (relayed via postMessage)
  // ============================================================
  var safeConsole = {};
  ['log', 'warn', 'error', 'info'].forEach(function(level) {
    safeConsole[level] = function() {
      consoleCalls++;
      if (consoleCalls > ${maxConsoleCalls}) return;

      var args = [];
      for (var i = 0; i < arguments.length; i++) {
        var arg = arguments[i];
        try { args.push(typeof arg === 'object' ? JSON.parse(JSON.stringify(arg)) : arg); }
        catch(e) { args.push(String(arg)); }
      }

      var size = 0;
      try { size = JSON.stringify(args).length; } catch(e) {}
      consoleOutputBytes += size;
      if (consoleOutputBytes > ${maxConsoleOutputBytes}) return;

      sendToOuter({ type: 'console', level: level, args: args });
    };
  });

  // ============================================================
  // Prototype Hardening
  // ============================================================

  // Shadow __proto__ on error prototypes
  (function() {
    var errorProtos = [
      Error.prototype, TypeError.prototype, RangeError.prototype,
      SyntaxError.prototype, ReferenceError.prototype, URIError.prototype, EvalError.prototype
    ];
    for (var i = 0; i < errorProtos.length; i++) {
      try {
        Object.defineProperty(errorProtos[i], '__proto__', {
          get: function() { return null; },
          set: function() {},
          configurable: false,
          enumerable: false
        });
      } catch(e) {}
    }
  })();

  // Block legacy prototype methods
  (function() {
    var methods = ['__lookupGetter__', '__lookupSetter__', '__defineGetter__', '__defineSetter__'];
    for (var i = 0; i < methods.length; i++) {
      try {
        Object.defineProperty(Object.prototype, methods[i], {
          value: function() { return undefined; },
          writable: false,
          configurable: false,
          enumerable: false
        });
      } catch(e) {}
    }
  })();

  // Memory-safe prototype patches (must run BEFORE freeze)
  (function() {
    var ml = ${memoryLimit};
    if (ml <= 0) return;
    var totalTracked = 0;
    function track(bytes) {
      totalTracked += bytes;
      if (totalTracked > ml) throw new RangeError('Memory limit exceeded');
    }

    var stringProto = Object.getPrototypeOf('');
    var arrayProto = Object.getPrototypeOf([]);

    try {
      var origRepeat = stringProto.repeat;
      Object.defineProperty(stringProto, 'repeat', { value: function(count) {
        var est = this.length * count * 2;
        if (est > ml) throw new RangeError('String.repeat would exceed memory limit');
        track(est);
        return origRepeat.call(this, count);
      }, writable: false, configurable: false });
    } catch(e) {}

    try {
      var origJoin = arrayProto.join;
      Object.defineProperty(arrayProto, 'join', { value: function(sep) {
        var s = sep === undefined ? ',' : String(sep);
        var est = 0;
        for (var i = 0; i < this.length; i++) {
          var item = this[i];
          est += (item === null || item === undefined) ? 0 : String(item).length;
          if (i > 0) est += s.length;
        }
        est *= 2;
        if (est > ml) throw new RangeError('Array.join would exceed memory limit');
        track(est);
        return origJoin.call(this, sep);
      }, writable: false, configurable: false });
    } catch(e) {}

    try {
      var origFill = arrayProto.fill;
      Object.defineProperty(arrayProto, 'fill', { value: function(value, start, end) {
        var len = this.length >>> 0;
        var k = (start === undefined ? 0 : (start >> 0));
        var finalEnd = (end === undefined ? len : (end >> 0));
        if (k < 0) k = Math.max(len + k, 0); else k = Math.min(k, len);
        if (finalEnd < 0) finalEnd = Math.max(len + finalEnd, 0); else finalEnd = Math.min(finalEnd, len);
        var fillCount = Math.max(0, finalEnd - k);
        var est = fillCount * 8;
        if (est > ml) throw new RangeError('Array.fill would exceed memory limit');
        track(est);
        return origFill.call(this, value, start, end);
      }, writable: false, configurable: false });
    } catch(e) {}
  })();

  // Freeze all prototypes
  (function() {
    var protos = [
      Object.prototype, Array.prototype, Function.prototype,
      String.prototype, Number.prototype, Boolean.prototype,
      Date.prototype, Error.prototype, TypeError.prototype,
      RangeError.prototype, SyntaxError.prototype, ReferenceError.prototype,
      URIError.prototype, EvalError.prototype, Promise.prototype
    ];
    for (var i = 0; i < protos.length; i++) {
      try { Object.freeze(protos[i]); } catch(e) {}
    }
  })();

  // ============================================================
  // Remove Dangerous Globals
  // ============================================================
  var dangerousGlobals = ${JSON.stringify(getDangerousGlobals(config.securityLevel))};
  for (var dg = 0; dg < dangerousGlobals.length; dg++) {
    try { delete window[dangerousGlobals[dg]]; } catch(e) {
      try { window[dangerousGlobals[dg]] = undefined; } catch(e2) {}
    }
  }

  // Always remove browser-specific dangerous globals
  // Note: 'location' is intentionally omitted — setting window.location = undefined
  // triggers a navigation that kills the iframe's event loop.
  // location is already restricted by the sandbox (no allow-same-origin).
  var browserDangerous = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
    'Worker', 'SharedWorker', 'ServiceWorker',
    'importScripts', 'localStorage', 'sessionStorage',
    'indexedDB', 'caches', 'navigator',
    'open', 'close', 'alert', 'confirm', 'prompt'
  ];
  for (var bd = 0; bd < browserDangerous.length; bd++) {
    try { delete window[browserDangerous[bd]]; } catch(e) {
      try { window[browserDangerous[bd]] = undefined; } catch(e2) {}
    }
  }

  // Note: window.document is a non-configurable accessor property that cannot be
  // deleted or redefined. It is shadowed via 'var document = undefined' in the
  // user code execution scope below.

  // ============================================================
  // Inject Safe Globals
  // ============================================================
  var SafeObject = function(value) {
    if (value === null || value === undefined) return {};
    return Object(value);
  };
  var safeObjMethods = [
    'keys', 'values', 'entries', 'fromEntries', 'assign', 'is', 'hasOwn',
    'freeze', 'isFrozen', 'seal', 'isSealed', 'preventExtensions', 'isExtensible',
    'getOwnPropertyNames', 'getOwnPropertySymbols', 'getPrototypeOf'
  ];
  for (var sm = 0; sm < safeObjMethods.length; sm++) {
    if (safeObjMethods[sm] in Object) SafeObject[safeObjMethods[sm]] = Object[safeObjMethods[sm]];
  }
  SafeObject.create = function(proto, props) {
    if (props !== undefined) throw createSafeError('Object.create with property descriptors is not allowed');
    return Object.create(proto);
  };
  SafeObject.prototype = Object.prototype;

  var blockedObjMethods = ['defineProperty', 'defineProperties', 'setPrototypeOf', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors'];
  for (var bm = 0; bm < blockedObjMethods.length; bm++) {
    (function(method) {
      SafeObject[method] = function() {
        throw createSafeError('Object.' + method + ' is not allowed (security restriction)');
      };
    })(blockedObjMethods[bm]);
  }

  // Save reference to Object.defineProperty before neutralizing it
  var _defineProperty = Object.defineProperty;

  // Neutralize dangerous static methods on intrinsic Object
  (function() {
    var RealObject = Object.getPrototypeOf({}).constructor;
    var dangerous = ['getOwnPropertyDescriptors', 'getOwnPropertyDescriptor', 'defineProperty', 'defineProperties', 'setPrototypeOf'];
    for (var i = 0; i < dangerous.length; i++) { try { delete RealObject[dangerous[i]]; } catch(e) {} }
  })();

  // Define all safe globals as non-writable, non-configurable, non-enumerable
  var safeGlobals = {
    __safe_callTool: createSecureProxy(__safe_callTool),
    callTool: createSecureProxy(__safe_callTool),
    __safe_forOf: createSecureProxy(__safe_forOf),
    __safe_for: createSecureProxy(__safe_for),
    __safe_while: createSecureProxy(__safe_while),
    __safe_doWhile: createSecureProxy(__safe_doWhile),
    __safe_concat: __safe_concat,
    __safe_template: __safe_template,
    __safe_parallel: createSecureProxy(__safe_parallel),
    parallel: createSecureProxy(__safe_parallel),
    __safe_console: safeConsole,
    console: safeConsole,
    __maxIterations: ${maxIterations},
    Math: createSecureProxy(Math),
    JSON: createSecureProxy(JSON),
    Array: createSecureProxy(Array),
    Object: createSecureProxy(SafeObject),
    String: createSecureProxy(String),
    Number: createSecureProxy(Number),
    Date: createSecureProxy(Date),
    Boolean: createSecureProxy(Boolean),
    RegExp: createSecureProxy(RegExp),
    Error: createSecureProxy(Error),
    TypeError: createSecureProxy(TypeError),
    RangeError: createSecureProxy(RangeError),
    Promise: createSecureProxy(Promise),
    undefined: undefined,
    NaN: NaN,
    Infinity: Infinity,
    isNaN: isNaN,
    isFinite: isFinite,
    parseInt: parseInt,
    parseFloat: parseFloat,
    encodeURI: encodeURI,
    decodeURI: decodeURI,
    encodeURIComponent: encodeURIComponent,
    decodeURIComponent: decodeURIComponent
  };

  // Inject custom globals if provided
  var customGlobals = ${JSON.stringify(config.globals || {})};
  for (var cgKey in customGlobals) {
    if (customGlobals.hasOwnProperty(cgKey)) {
      safeGlobals[cgKey] = createSecureProxy(customGlobals[cgKey]);
      safeGlobals['__safe_' + cgKey] = createSecureProxy(customGlobals[cgKey]);
    }
  }

  for (var gKey in safeGlobals) {
    if (safeGlobals.hasOwnProperty(gKey)) {
      try {
        _defineProperty(window, gKey, {
          value: safeGlobals[gKey],
          writable: false,
          configurable: false,
          enumerable: false
        });
      } catch(e) {}
    }
  }

  // ============================================================
  // Execute User Code
  // ============================================================
  (async function() {
    // Shadow non-deletable browser globals so user code sees undefined
    var document = undefined;

    try {
      // The transformed code defines __ag_main as a function declaration.
      // We embed it directly — CSP 'unsafe-inline' allows inline scripts
      // but blocks eval/new Function.
      ${generateUserCodeExecution(userCode)}

      var result = typeof __ag_main === 'function' ? await __ag_main() : undefined;

      // Sanitize result before sending
      var safeResult;
      try {
        safeResult = JSON.parse(JSON.stringify(result));
      } catch(e) {
        safeResult = undefined;
      }

      sendToOuter({
        type: 'result',
        success: true,
        value: safeResult,
        stats: {
          duration: Date.now() - startTime,
          toolCallCount: toolCallCount,
          iterationCount: iterationCount,
          startTime: startTime,
          endTime: Date.now()
        }
      });
    } catch(error) {
      sendToOuter({
        type: 'result',
        success: false,
        error: {
          name: (typeof error === 'string') ? 'Error' : ((error && error.name) ? String(error.name) : 'Error'),
          message: (typeof error === 'string') ? error : ((error && error.message) ? String(error.message) : 'Unknown error'),
          code: (typeof error === 'string') ? undefined : ((error && error.code) ? String(error.code) : undefined)
        },
        stats: {
          duration: Date.now() - startTime,
          toolCallCount: toolCallCount,
          iterationCount: iterationCount,
          startTime: startTime,
          endTime: Date.now()
        }
      });
    }
  })();
})();
`.trim();
}

/**
 * Generate the user code execution block.
 * Since we can't use new Function() (CSP blocks eval),
 * we embed the code directly in the script.
 */
function generateUserCodeExecution(userCode: string): string {
  // The user code has already been transformed by @enclave-vm/ast
  // and contains __ag_main() function definition.
  // We embed it directly - it runs in the same script context.
  return userCode;
}

/**
 * Dangerous globals to remove per security level
 */
function getDangerousGlobals(securityLevel: string): string[] {
  const base: Record<string, string[]> = {
    STRICT: [
      'Function',
      'eval',
      'globalThis',
      'Proxy',
      'Reflect',
      'SharedArrayBuffer',
      'Atomics',
      'WebAssembly',
      'Iterator',
      'AsyncIterator',
      'ShadowRealm',
      'WeakRef',
      'FinalizationRegistry',
      'performance',
      'Temporal',
    ],
    SECURE: [
      'Function',
      'eval',
      'globalThis',
      'Proxy',
      'SharedArrayBuffer',
      'Atomics',
      'WebAssembly',
      'Iterator',
      'AsyncIterator',
      'ShadowRealm',
      'WeakRef',
      'FinalizationRegistry',
    ],
    STANDARD: [
      'Function',
      'eval',
      'SharedArrayBuffer',
      'Atomics',
      'WebAssembly',
      'ShadowRealm',
      'WeakRef',
      'FinalizationRegistry',
    ],
    PERMISSIVE: ['ShadowRealm', 'SharedArrayBuffer', 'Atomics', 'WebAssembly'],
  };

  return base[securityLevel] || base['STANDARD'];
}
