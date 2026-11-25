import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, 'cherry-pick-conflict.mjs');

describe('cherry-pick-conflict', () => {
  let repo;
  let dir;
  let fakeBin;
  const shas = {};

  function git(...args) {
    const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim();
  }

  async function commit(subject, files) {
    for (const [file, content] of Object.entries(files)) {
      await fs.writeFile(path.join(repo, file), content);
    }
    git('add', '-A');
    git('commit', '-q', '-m', subject);
    return git('rev-parse', 'HEAD');
  }

  function script(command, env = {}) {
    return spawnSync(process.execPath, [scriptPath, command, dir], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_RUN_ID: '', ...env },
    });
  }

  async function start(commits) {
    const pullRequest = { number: 21, title: 'fix(sdk): the change', author: 'octocat', authorId: 583231, commits };
    const conflict = { releaseBranch: 'release/1.11.x', targetBranch: 'main', pullRequest };
    await fs.writeFile(path.join(dir, 'conflict.json'), JSON.stringify(conflict));
    return script('start');
  }

  async function answer(value) {
    await fs.writeFile(path.join(dir, 'answer.json'), JSON.stringify(value));
  }

  function read(file) {
    return fs.readFile(path.join(repo, file), 'utf8');
  }

  function note() {
    return fs.readFile(path.join(dir, 'note.md'), 'utf8');
  }

  before(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'cherry-pick-conflict-'));
    fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), 'cherry-pick-conflict-bin-'));
    const fakeNpx = [
      '#!/bin/sh',
      'echo "npx $*" >&2',
      'case "$*" in *"-t test"*) if [ -n "$FAKE_FLAKE" ] && [ ! -f "$FAKE_FLAKE" ]; then touch "$FAKE_FLAKE"; exit 1; fi ;; esac',
      'exit "${FAKE_NPX_STATUS:-0}"',
      '',
    ].join('\n');
    await fs.writeFile(path.join(fakeBin, 'npx'), fakeNpx, { mode: 0o755 });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    await commit('chore: start', { 'shared.txt': 'one\ntwo\nthree\n' });

    git('checkout', '-q', '-b', 'release');
    shas.added = await commit('feat(sdk): add a helper (#20)', { 'helper.txt': 'helper\n' });
    shas.first = await commit('fix(sdk): the change, part one (#21)', { 'new.txt': 'new\n' });
    shas.second = await commit('fix(sdk): the change, part two (#21)', {
      'shared.txt': 'one\ntwo, from the release branch\nthree\n',
      'helper.txt': 'helper, changed\n',
    });

    git('checkout', '-q', 'main');
    shas.main = await commit('fix(sdk): two, on main', { 'shared.txt': 'one\ntwo, from main\nthree\n' });
  });

  after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(fakeBin, { recursive: true, force: true });
  });

  beforeEach(async () => {
    git('checkout', '-q', '-f', '-B', 'cherry-pick', shas.main);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cherry-pick-conflict-dir-'));
  });

  test('start applies the commits as one change and leaves the conflicts with zdiff3 markers', async () => {
    const res = await start([shas.first, shas.second]);
    assert.equal(res.status, 0, res.stderr);

    assert.equal(git('show', ':new.txt'), 'new');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'conflicted.json'), 'utf8')), [
      { state: 'DU', path: 'helper.txt' },
      { state: 'UU', path: 'shared.txt' },
    ]);
    assert.match(await read('shared.txt'), /<<<<<<< HEAD\ntwo, from main\n\|\|\|\|\|\|\| [^\n]+\ntwo\n=======\n/);

    const prompt = await fs.readFile(path.join(dir, 'prompt.md'), 'utf8');
    assert.match(prompt, /PR #21, "fix\(sdk\): the change", was merged to `release\/1\.11\.x`/);
    assert.match(
      prompt,
      /- `helper\.txt`: changed by the PR, missing on the target branch\n- `shared\.txt`: changed on both sides\n/,
    );
    assert.match(prompt, new RegExp(`git show ${shas.first} ${shas.second}`));
    const schema = JSON.parse(await fs.readFile(path.join(dir, 'schema.json'), 'utf8'));
    assert.deepEqual(schema.required, ['resolved', 'summary', 'files']);
  });

  test('start refuses a working tree with changes, and a change with nothing to resolve', async () => {
    await fs.writeFile(path.join(repo, 'shared.txt'), 'an edit of the maintainer\n');
    const dirty = await start([shas.second]);
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /The working tree has changes/);
    assert.equal(await read('shared.txt'), 'an edit of the maintainer\n');
    git('checkout', '-q', '--', 'shared.txt');

    const clean = await start([shas.first]);
    assert.equal(clean.status, 1);
    assert.match(clean.stderr, /Nothing for Codex to resolve in #21: applies without a conflict as one change/);
    assert.equal(git('status', '--porcelain'), '');
  });

  test('finish commits the resolution as the cherry-pick of the PR', async () => {
    await start([shas.first, shas.second]);
    await fs.writeFile(path.join(repo, 'shared.txt'), 'one\ntwo, from main and the release branch\nthree\n');
    await fs.rm(path.join(repo, 'helper.txt'));
    await answer({
      resolved: true,
      summary: 'Kept both edits of the second line.',
      files: [{ path: 'shared.txt', resolution: 'merged the two edits' }],
    });

    const res = script('finish');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(git('rev-parse', 'HEAD~1'), shas.main);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(
      git('log', '-1', '--format=%B'),
      [
        'Cherry-pick: fix(sdk): the change',
        '',
        'Cherry-picked from #21 (merged to release/1.11.x)',
        `Original commit: ${shas.first} ${shas.second}`,
        'Conflicts in helper.txt, shared.txt resolved by Codex.',
        '',
        'Co-Authored-By: octocat <583231+octocat@users.noreply.github.com>',
      ].join('\n'),
    );
    assert.equal(
      await note(),
      [
        '## Conflicts resolved by Codex',
        '',
        'The cherry-pick of #21 to `main` conflicts in `helper.txt`, `shared.txt`. Codex resolved them; review the resolution before merging.',
        '',
        'Kept both edits of the second line.',
        '',
        '- `shared.txt`: merged the two edits',
        '',
      ].join('\n'),
    );
  });

  test('finish refuses an answer that gives up, and keeps its reason', async () => {
    await start([shas.second]);
    await answer({ resolved: false, summary: 'It depends on #20, which main does not have.', files: [] });

    const res = script('finish');
    assert.equal(res.status, 1);
    assert.equal(git('rev-parse', 'HEAD'), shas.main);
    assert.equal(git('status', '--porcelain'), '');
    assert.match(await note(), /^## Codex could not resolve the conflicts\n\n.+\n\nIt depends on #20, which main/);
  });

  test('finish refuses a missing answer, a marker left in a file, and a resolution that changes nothing', async () => {
    await start([shas.second]);
    assert.equal(script('finish').status, 1);
    assert.match(await note(), /Codex gave no answer; the run log has its output/);

    await start([shas.second]);
    await answer({ resolved: true, summary: 'Done.', files: [] });
    assert.equal(script('finish').status, 1);
    assert.match(await note(), /conflict markers are left in `shared\.txt`\.\n$/);
    assert.equal(git('status', '--porcelain'), '');

    await start([shas.second]);
    await fs.writeFile(path.join(repo, 'shared.txt'), 'one\ntwo, from main\nthree\n');
    await fs.rm(path.join(repo, 'helper.txt'));
    assert.equal(script('finish').status, 1);
    assert.match(await note(), /The resolution leaves nothing to commit\. Codex's summary: Done\./);
    assert.equal(git('rev-parse', 'HEAD'), shas.main);
  });

  test('verify keeps a resolution that passes the checks, and drops one that fails them', async () => {
    const resolve = async () => {
      await start([shas.second]);
      await fs.writeFile(path.join(repo, 'shared.txt'), 'one\ntwo, merged\nthree\n');
      await fs.rm(path.join(repo, 'helper.txt'));
      await answer({ resolved: true, summary: 'Merged the second line.', files: [] });
      assert.equal(script('finish').status, 0);
    };
    const env = (status) => ({ PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, FAKE_NPX_STATUS: status });

    await resolve();
    const passed = script('verify', env('0'));
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stderr, /npx nx affected --base=HEAD~1 --head=HEAD -t lint build/);
    assert.match(passed.stderr, /npx prettier --check --ignore-unknown shared\.txt/);
    assert.equal(git('rev-parse', 'HEAD~1'), shas.main);
    assert.match(await note(), /\n\nThe lint, build and tests of the projects the resolution affects pass/);

    git('checkout', '-q', '-f', '-B', 'cherry-pick', shas.main);
    await resolve();
    const flaky = script('verify', { ...env('0'), FAKE_FLAKE: path.join(dir, 'flaked') });
    assert.equal(flaky.status, 0, flaky.stderr);
    assert.equal(flaky.stderr.match(/-t test/g).length, 2);
    assert.equal(git('rev-parse', 'HEAD~1'), shas.main);

    git('checkout', '-q', '-f', '-B', 'cherry-pick', shas.main);
    await resolve();
    const failed = script('verify', {
      ...env('1'),
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_RUN_ID: '7',
    });
    assert.equal(failed.status, 1);
    assert.equal(git('rev-parse', 'HEAD'), shas.main);
    assert.equal(
      await note(),
      [
        "## Codex's resolution did not pass the checks",
        '',
        'Codex resolved the conflicts of the cherry-pick of #21 to `main`, but the lint and build failed on the result; [the run log](https://github.com/o/r/actions/runs/7) has the output.',
        '',
        "Codex's summary: Merged the second line.",
        '',
      ].join('\n'),
    );
  });

  test('the command line refuses an unknown command', () => {
    const res = spawnSync(process.execPath, [scriptPath, 'push', '/tmp'], { encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage: node scripts\/cherry-pick-conflict\.mjs <start\|finish\|verify> <dir>/);
  });
});
