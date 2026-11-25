#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { commitMessage } from './cherry-pick-stack.mjs';

const USAGE = `Usage: node scripts/cherry-pick-conflict.mjs <start|finish|verify> <dir>

Lets Codex resolve a conflict of the cherry-pick to main (.github/workflows/cherry-pick-prompt.yml). <dir> holds
conflict.json: { releaseBranch, targetBranch, pullRequest: { number, title, author, authorId, commits } }.

start   applies the PR's commits to HEAD as one change and leaves the conflicts in the working tree, with zdiff3
        markers. It writes prompt.md and schema.json for Codex.
finish  reads Codex's answer from answer.json and commits the resolution as the cherry-pick of the PR.
verify  lints, builds and tests the projects that commit affects and checks its format, and drops it on a failure.
        The tests run a second time before they count as failed: some are slow under load.

finish and verify write note.md, for the cherry-pick PR or the issue, and exit 1 when they refuse the resolution.`;

const CONFLICT_STATES = {
  UU: 'changed on both sides',
  AA: 'added on both sides',
  DU: 'changed by the PR, missing on the target branch',
  UD: 'deleted by the PR, changed on the target branch',
  UA: 'added by the PR',
  AU: 'added on the target branch',
  DD: 'deleted on both sides',
};

const CONFLICT_MARKER = /^(<{7}|\|{7}|>{7})( |$)|^={7}$/m;

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    resolved: { type: 'boolean' },
    summary: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, resolution: { type: 'string' } },
        required: ['path', 'resolution'],
        additionalProperties: false,
      },
    },
  },
  required: ['resolved', 'summary', 'files'],
  additionalProperties: false,
};

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeNote(dir, heading, paragraphs) {
  const text = [`## ${heading}`, ...paragraphs].filter(Boolean).join('\n\n');
  writeFileSync(path.join(dir, 'note.md'), `${text}\n`);
}

function codeList(paths) {
  return paths.map((file) => `\`${file}\``).join(', ');
}

function runLog() {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId } = process.env;
  return runId ? `[the run log](${server}/${repository}/actions/runs/${runId})` : 'the run log';
}

function conflictedFiles() {
  const status = run('git', ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=no']);
  return status
    .split('\0')
    .map((entry) => ({ state: entry.slice(0, 2), path: entry.slice(3) }))
    .filter((entry) => Object.hasOwn(CONFLICT_STATES, entry.state));
}

function squashedChange(commits) {
  const lastCommit = commits[commits.length - 1];
  return run('git', [
    'commit-tree',
    `${lastCommit}^{tree}`,
    '-p',
    `${commits[0]}^1`,
    '-m',
    'The change to cherry-pick',
  ]);
}

function hasConflictMarker(file) {
  return existsSync(file) && CONFLICT_MARKER.test(readFileSync(file, 'utf8'));
}

function readAnswer(dir) {
  try {
    const answer = readJson(path.join(dir, 'answer.json'));
    const isAnswer =
      typeof answer.resolved === 'boolean' && typeof answer.summary === 'string' && Array.isArray(answer.files);
    return isAnswer ? answer : null;
  } catch {
    return null;
  }
}

export function renderPrompt({ releaseBranch, targetBranch, pullRequest }, conflicted) {
  const release = `\`${releaseBranch}\``;
  const target = `\`${targetBranch}\``;
  return [
    '# Resolve the conflicts of a cherry-pick',
    '',
    `PR #${pullRequest.number}, "${pullRequest.title}", was merged to ${release}. Its change is being cherry-picked onto ${target}, and it conflicts. The working tree is ${target} with the change applied, and git left these files in conflict:`,
    '',
    ...conflicted.map((entry) => `- \`${entry.path}\`: ${CONFLICT_STATES[entry.state]}`),
    '',
    `The conflict markers are in the zdiff3 style: the lines between \`|||||||\` and \`=======\` are the text both sides started from. \`git show ${pullRequest.commits.join(' ')}\` shows the change as it was made on ${release}, and \`git log -p HEAD..origin/${releaseBranch} -- <file>\` what ${release} has that ${target} does not.`,
    '',
    '## Resolve them',
    '',
    `- Keep every change ${target} has, and apply the PR's change to it. Take one side as it is only when the other side's change is already in it.`,
    `- A CHANGELOG on ${release} has release headings (\`## [x.y.z] - <date>\`) that ${target} may not have. Add the PR's entries where ${target} keeps its unreleased ones, and do not copy the headings.`,
    `- If the PR changes code that ${target} does not have (a file, a function or an option that an earlier change on ${release} added), it depends on that change. Do not write that code: answer \`resolved: false\` and name the change it depends on.`,
    '- Change only what the conflicts need, with no refactoring. If the change cannot work without editing another file, edit it and say why.',
    '- Only edit files. Do not run a git command that changes the repository, such as add, commit, checkout, reset, stash or cherry-pick.',
    '',
    '## Check the result',
    '',
    '- No file may keep a conflict marker.',
    '- Format the files you changed with `npx prettier --write <files>`.',
    '- Build the Nx projects you changed, then run their tests: for example `NX_DAEMON=false npx nx build core`, then `npx jest -c libs/core/jest.config.ts <spec>` or `NX_DAEMON=false npx nx test core`. Some tests need the build. Dependencies are installed, and there is no network. AGENTS.md has the conventions of the repository.',
    '',
    '## Answer',
    '',
    '- `resolved`: true only when every conflict is resolved and what you changed builds and passes its tests.',
    '- `summary`: for the reviewer of the cherry-pick PR, what you did, or why you could not resolve the conflicts.',
    '- `files`: each file you changed, and how you resolved it.',
    '',
  ].join('\n');
}

export function startResolution(dir) {
  const conflict = readJson(path.join(dir, 'conflict.json'));
  const { number, commits } = conflict.pullRequest;
  const changes = run('git', ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=all']);
  if (changes !== '') {
    throw new Error(`The working tree has changes; commit or stash them first:\n${changes}`);
  }

  const pickArgs = ['-c', 'merge.conflictStyle=zdiff3', 'cherry-pick', '--no-commit', squashedChange(commits)];
  const pick = spawnSync('git', pickArgs, { encoding: 'utf8' });
  const conflicted = conflictedFiles();
  if (conflicted.length === 0) {
    run('git', ['reset', '--hard', '--quiet', 'HEAD']);
    const reason = pick.status === 0 ? 'applies without a conflict as one change' : (pick.stderr || pick.stdout).trim();
    throw new Error(`Nothing for Codex to resolve in #${number}: ${reason}`);
  }

  console.error(`#${number} conflicts in ${conflicted.map((entry) => entry.path).join(', ')}`);
  writeJson(path.join(dir, 'conflicted.json'), conflicted);
  writeJson(path.join(dir, 'schema.json'), ANSWER_SCHEMA);
  writeFileSync(path.join(dir, 'prompt.md'), renderPrompt(conflict, conflicted));
}

export function finishResolution(dir) {
  const { releaseBranch, targetBranch, pullRequest } = readJson(path.join(dir, 'conflict.json'));
  const conflictedPaths = readJson(path.join(dir, 'conflicted.json')).map((entry) => entry.path);
  const conflictLine = `The cherry-pick of #${pullRequest.number} to \`${targetBranch}\` conflicts in ${codeList(conflictedPaths)}.`;
  const refuse = (reason) => {
    run('git', ['reset', '--hard', '--quiet', 'HEAD']);
    writeNote(dir, 'Codex could not resolve the conflicts', [conflictLine, reason]);
    return false;
  };

  const answer = readAnswer(dir);
  if (!answer) return refuse(`Codex gave no answer; ${runLog()} has its output.`);
  if (!answer.resolved) return refuse(answer.summary);
  const withMarkers = conflictedPaths.filter(hasConflictMarker);
  if (withMarkers.length > 0) {
    return refuse(`Codex answered that it resolved them, but conflict markers are left in ${codeList(withMarkers)}.`);
  }

  run('git', ['add', '--all']);
  if (spawnSync('git', ['diff', '--cached', '--quiet']).status === 0) {
    return refuse(`The resolution leaves nothing to commit. Codex's summary: ${answer.summary}`);
  }
  const resolvedLine = `Conflicts in ${conflictedPaths.join(', ')} resolved by Codex.`;
  run('git', ['commit', '--quiet', '--message', commitMessage(pullRequest, releaseBranch, [resolvedLine])]);
  writeNote(dir, 'Conflicts resolved by Codex', [
    `${conflictLine} Codex resolved them; review the resolution before merging.`,
    answer.summary,
    answer.files.map((file) => `- \`${file.path}\`: ${file.resolution}`).join('\n'),
  ]);
  return true;
}

function checksOf(files) {
  const affected = ['nx', 'affected', '--base=HEAD~1', '--head=HEAD'];
  const checks = [
    { name: 'lint and build', command: 'npx', args: [...affected, '-t', 'lint', 'build'] },
    { name: 'tests', command: 'npx', args: [...affected, '-t', 'test', '--passWithNoTests'], attempts: 2 },
  ];
  if (files.length > 0) {
    checks.push({ name: 'format check', command: 'npx', args: ['prettier', '--check', '--ignore-unknown', ...files] });
  }
  return checks;
}

export function verifyResolution(dir) {
  const { targetBranch, pullRequest } = readJson(path.join(dir, 'conflict.json'));
  const files = run('git', ['diff', '--name-only', '--diff-filter=d', 'HEAD~1', 'HEAD']).split('\n').filter(Boolean);
  const passes = (check) =>
    Array.from({ length: check.attempts ?? 1 }).some(
      () => spawnSync(check.command, check.args, { stdio: ['ignore', 2, 2] }).status === 0,
    );
  const failed = checksOf(files).find((check) => !passes(check));
  if (!failed) {
    const passed =
      'The lint, build and tests of the projects the resolution affects pass, and so does the format check.';
    appendFileSync(path.join(dir, 'note.md'), `\n${passed}\n`);
    return true;
  }

  run('git', ['reset', '--hard', '--quiet', 'HEAD~1']);
  writeNote(dir, "Codex's resolution did not pass the checks", [
    `Codex resolved the conflicts of the cherry-pick of #${pullRequest.number} to \`${targetBranch}\`, but the ${failed.name} failed on the result; ${runLog()} has the output.`,
    `Codex's summary: ${readAnswer(dir)?.summary}`,
  ]);
  return false;
}

const COMMANDS = { start: startResolution, finish: finishResolution, verify: verifyResolution };

function main() {
  const [command, dir] = process.argv.slice(2);
  if (!Object.hasOwn(COMMANDS, command) || !dir) {
    console.error(USAGE);
    process.exit(2);
  }
  if (COMMANDS[command](dir) === false) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
