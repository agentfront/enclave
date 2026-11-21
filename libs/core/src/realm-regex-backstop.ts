/**
 * The runtime half of "AgentScript has no regular expressions", shared by the VMs.
 *
 * @packageDocumentation
 */

/**
 * Source of a statement evaluated in a sandbox realm (the inner realm of the double VM, the realm
 * of the single VM) when a realm allowlist without `RegExp` is in force: it makes regular
 * expressions unusable there.
 *
 * AgentScript has no regular expressions, and the validator refuses every way to write or run one.
 * This is the runtime half of that rule: `String.prototype.match/matchAll/search` build a RegExp
 * from a STRING argument inside the engine (no `RegExp` binding and no literal needed), and a
 * backtracking pattern run that way is not interruptible work the iteration limit can see.
 * Every regular expression of the realm reaches its matcher through `RegExp.prototype`, so the
 * methods there are replaced by a function that throws, and the prototype is frozen.
 */
export const REALM_REGEX_BACKSTOP_SOURCE = `
(function () {
  'use strict';
  var defineProperty = Object.defineProperty;
  var freeze = Object.freeze;
  var RealmTypeError = TypeError;
  var proto = RegExp.prototype;
  var refuse = () => {
    throw new RealmTypeError('Regular expressions are not available in this sandbox');
  };
  freeze(refuse);
  var keys = ['exec', 'test', 'compile', Symbol.match, Symbol.matchAll, Symbol.replace, Symbol.search, Symbol.split];
  for (var i = 0; i < keys.length; i++) {
    defineProperty(proto, keys[i], { value: refuse, writable: false, configurable: false, enumerable: false });
  }
  freeze(proto);
})()
`.trim();
