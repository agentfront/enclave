/**
 * Compiling scripts for sandbox realms without sharing compiled code between realms.
 *
 * ## The engine defect this works around
 *
 * V8 keeps a compilation cache: compiling the same source text again returns the SAME compiled
 * functions, and a `vm.Script` run in several contexts instantiates the same compiled functions in
 * each. Once one of those functions has been hot enough to get baseline (Sparkplug) code, every
 * NEW closure of it, in every later context, is entered through the lazy-compile builtin straight
 * into that baseline code.
 *
 * In V8 13.x (Node.js 24) that entry path is broken for builds without the V8 sandbox, which is
 * what Node.js ships. The baseline prologue saves the "dispatch handle" register into a stack
 * frame that the garbage collector scans as tagged values, assuming the register holds a handle.
 * Without the sandbox the calling convention does not include that register, so on this path it
 * holds whatever the previous builtin left there. A garbage collection that starts while the
 * function is being entered then follows that value as if it were a pointer:
 *
 *   ClearStaleLeftTrimmedPointerVisitor::VisitRootPointers  <- SIGSEGV
 *   InternalFrame::Iterate
 *   Heap::CollectGarbage
 *   Runtime_StackGuardWithGap
 *   Builtins_BaselineOutOfLinePrologue
 *
 * The process dies with SIGSEGV. Measured on Node.js 24.18.0 (arm64, V8 13.6.233), each process
 * running one AgentScript 500 times under `--stress-incremental-marking` (which only makes
 * collections frequent):
 *
 * - enclave 2.18.0 as released: 4 of 30 processes crashed;
 * - the same code with more setup work per execution: 19 of 20;
 * - with this workaround: 0 of 20 (double VM and single VM), and 0 of 56 in earlier trials;
 * - the same larger setup without the workaround but with the baseline compiler switched off
 *   (`node --no-sparkplug`): 0 of 20, against 20 of 20 without the flag in the same batch.
 *
 * Without the flag the larger setup crashed 2 of 24 processes that ran the script 1,300 times.
 * The x64 builtin saves the register in the same unconditional way; only arm64 was measured.
 * Node.js 22 (V8 12.4) does not have the code in question, and V8 14.1 (Node.js 25) fixed it: the
 * prologue now saves the register only when the calling convention includes it.
 *
 * ## The workaround
 *
 * The defect needs a compiled function to be instantiated a second time. On an affected engine
 * every source compiled for a sandbox realm therefore gets a unique trailing comment, so nothing
 * is ever found in the compilation cache, and a script that would have been compiled once and run
 * in every context is compiled per use instead.
 *
 * The cost is the compilation cache itself: running the SAME script repeatedly takes as long as
 * running a script the engine has not seen before (which is what a host that executes generated
 * code pays anyway): 5.5 ms instead of 3.0 ms for a small script in the double VM. Each execution
 * also leaves its compiled scripts (about 0.4 MB) in the engine's compilation cache, which drops
 * them after several major garbage collections or when memory runs short. Engines without the
 * defect keep sharing compiled code.
 *
 * ## A process that runs without the baseline compiler
 *
 * The defect is in the entry into baseline code, so a process started with `node --no-sparkplug`
 * cannot have it (0 crashes in 68 processes, against 44 of 44 without the flag). There the
 * workaround is switched off and compiled code is shared again, which gives the repeated-script
 * time and the memory of an unaffected engine back, at the price the flag itself has: code that is
 * not optimized yet runs in the interpreter. The flag is read from `process.execArgv` once, when
 * this module is loaded. It cannot be given in `NODE_OPTIONS` (Node.js refuses it there), and a
 * command line that mentions the baseline compiler in any other way keeps the workaround on.
 *
 * ## Why the comment also varies in length
 *
 * The engine keeps every script it compiled in its compilation cache until several major garbage
 * collections have passed, and looks a new source up there by the hash of its text. V8 computes
 * the hash of a string longer than 16,383 characters from its LENGTH alone, so long sources of
 * one length all land on the same entry chain and the lookup compares the new source with each
 * of them, character by character. Sources that differ only in a counter at their end are the
 * worst case: every comparison runs to the last characters. Measured on Node.js 24.18.0 with the
 * double VM's 137,000-character bootstrap, a same-length marker made one compilation take 0.85 ms
 * at first, 9 ms on average over the first 1,000 executions and 26 ms over the second 1,000.
 *
 * The marker of a long source is therefore padded to one of {@link UNIQUE_SOURCE_LENGTHS}
 * lengths in rotation: the sources compiled most recently all differ in length, hash differently
 * and are never compared (0.85 ms per compilation, flat, over 6,000 executions).
 *
 * @packageDocumentation
 */

import * as vm from 'vm';

/**
 * Whether a V8 version can crash when compiled sandbox code is shared between realms (see the
 * module documentation): V8 13.x, which is every Node.js 24 release.
 *
 * @param v8Version `process.versions.v8`, or undefined where there is no Node.js `process`
 */
export function isSharedScriptCodeUnsafe(v8Version: string | undefined): boolean {
  return typeof v8Version === 'string' && /^13\./.test(v8Version);
}

/**
 * Whether the command line of this process switched the baseline compiler (Sparkplug) off, which
 * removes the code the defect is in (see the module documentation).
 *
 * Only the spellings V8 accepts for that one flag count. Any other argument that mentions the
 * baseline compiler, such as a `--sparkplug` that follows it or `--always-sparkplug`, makes the
 * answer false: where the command line is not plainly "off", the workaround stays on.
 *
 * @param execArgv `process.execArgv`
 */
export function isBaselineCompilerOff(execArgv: readonly unknown[] | undefined): boolean {
  if (!Array.isArray(execArgv)) return false;
  let off = false;
  for (const argument of execArgv) {
    if (typeof argument !== 'string' || !/sparkplug/i.test(argument)) continue;
    if (!BASELINE_COMPILER_OFF_FLAGS.has(argument)) return false;
    off = true;
  }
  return off;
}

/** `--no-sparkplug` as V8 accepts it: with or without the dash after `no`, and with `_` for `-`. */
const BASELINE_COMPILER_OFF_FLAGS: ReadonlySet<string> = new Set(['--no-sparkplug', '--nosparkplug', '--no_sparkplug']);

/**
 * V8 computes the hash of a string longer than this from its length alone
 * (`String::kMaxHashCalcLength`); see the module documentation.
 */
const HASHED_BY_LENGTH_ABOVE = 16383;

/**
 * How many different lengths the marker of a long source rotates through: of the long sources of
 * one length passed to {@link uniqueSource}, this many in a row all come back with different
 * lengths, however many short sources are made unique in between.
 */
export const UNIQUE_SOURCE_LENGTHS = 4096;

/** Digits of the counter in a marker. Fixed, so that the counter does not change its length. */
const COUNTER_DIGITS = 16;

let uniqueSourceCounter = 0;

/** Counts the long sources only, so that their lengths rotate whatever else is compiled. */
let paddedSourceCounter = 0;

/**
 * Return `source` with a trailing comment that makes its text unique in this process, so that the
 * engine compiles it afresh. The comment is on a line of its own after the source: it changes no
 * line or column number and cannot be swallowed by a `//` comment the source ends with.
 *
 * A source long enough for the engine to hash it by its length also gets a different length each
 * time (see the module documentation).
 */
export function uniqueSource(source: string): string {
  uniqueSourceCounter += 1;
  const marker = `\n// enclave-script ${String(uniqueSourceCounter).padStart(COUNTER_DIGITS, '0')}`;
  if (source.length + marker.length <= HASHED_BY_LENGTH_ABOVE) return source + marker;
  paddedSourceCounter = (paddedSourceCounter + 1) % UNIQUE_SOURCE_LENGTHS;
  return source + marker + ' '.repeat(paddedSourceCounter);
}

/** What {@link createSandboxScriptApi} returns. */
export interface SandboxScriptApi {
  /**
   * Compile a script that is used for ONE sandbox realm (the script of an execution, or a helper
   * built for it).
   */
  compileSandboxScript(source: string, options?: vm.ScriptOptions): vm.Script;

  /**
   * The `Script` class to hand to code that compiles scripts for sandbox realms itself (the
   * parent VM of the double VM does).
   */
  SandboxScript: typeof vm.Script;

  /**
   * A helper script that is run in every sandbox realm an adapter creates. Where sharing
   * compiled code is safe it is compiled once and run in each context; otherwise it is compiled
   * for each context it is run in.
   */
  ReusableSandboxScript: new (source: string, options?: vm.ScriptOptions) => ReusableScript;
}

/** A script that can be run in any number of contexts. */
export interface ReusableScript {
  runInContext(context: vm.Context, options?: vm.RunningScriptOptions): unknown;
}

/**
 * Build the script-compilation functions for an engine.
 *
 * @param uniqueSources true to never share compiled code: every source is made unique before it
 *   is compiled, and a reusable script is compiled per use
 * @param Script the script class to compile with (a test passes one that records its sources)
 */
export function createSandboxScriptApi(uniqueSources: boolean, Script: typeof vm.Script = vm.Script): SandboxScriptApi {
  const prepare = (source: string): string => (uniqueSources ? uniqueSource(source) : source);

  const SandboxScript: typeof vm.Script = uniqueSources
    ? class UniqueSourceScript extends Script {
        constructor(source: string, options?: vm.ScriptOptions | string) {
          super(uniqueSource(String(source)), options as vm.ScriptOptions);
        }
      }
    : Script;

  class ReusableSandboxScript implements ReusableScript {
    private readonly compiled: vm.Script | undefined;

    constructor(
      private readonly source: string,
      private readonly options?: vm.ScriptOptions,
    ) {
      // Compiled here in both modes, so that a source that does not compile fails where the
      // script is defined. Without sharing, this first compilation is only that check.
      const script = new Script(prepare(source), options);
      this.compiled = uniqueSources ? undefined : script;
    }

    runInContext(context: vm.Context, options?: vm.RunningScriptOptions): unknown {
      const script = this.compiled ?? new Script(prepare(this.source), this.options);
      return script.runInContext(context, options);
    }
  }

  return {
    compileSandboxScript: (source, options) => new Script(prepare(source), options),
    SandboxScript,
    ReusableSandboxScript,
  };
}

/**
 * Whether this process can crash when compiled sandbox code is shared between realms: an affected
 * engine, started with its baseline compiler on.
 */
export const SHARED_SCRIPT_CODE_IS_UNSAFE: boolean = (() => {
  try {
    if (typeof process === 'undefined') return false;
    return isSharedScriptCodeUnsafe(process.versions?.v8) && !isBaselineCompilerOff(process.execArgv);
  } catch {
    return false;
  }
})();

const api = createSandboxScriptApi(SHARED_SCRIPT_CODE_IS_UNSAFE);

/** {@link SandboxScriptApi.compileSandboxScript} for this engine. */
export const compileSandboxScript = api.compileSandboxScript;

/** {@link SandboxScriptApi.SandboxScript} for this engine. */
export const SandboxScript = api.SandboxScript;

/** {@link SandboxScriptApi.ReusableSandboxScript} for this engine. */
export const ReusableSandboxScript = api.ReusableSandboxScript;
