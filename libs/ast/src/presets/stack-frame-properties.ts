/**
 * Property names of the engine's stack trace API that are refused by the presets that allow
 * `Error`.
 *
 * `prepareStackTrace` is the hook that replaces the text of `error.stack` with structured call
 * sites. A call site holds live objects of the frame it describes (`getThis`, `getFunction`),
 * including frames that are not the script's, and `caller` of a function is the function that
 * called it, which is the host's where the host calls a function of the script. A script has no
 * use for any of them: refusing the names, in every spelling, keeps `error.stack` a string and a
 * frame out of reach.
 */
export const STACK_FRAME_PROPERTIES: readonly string[] = Object.freeze([
  'prepareStackTrace',
  'getThis',
  'getFunction',
  'caller',
]);

/**
 * The name that installs the hook, refused as a key of an object literal as well: a hook can be
 * installed by copying an object onto `Error`.
 */
export const STACK_FRAME_OBJECT_KEYS: readonly string[] = Object.freeze(['prepareStackTrace']);
