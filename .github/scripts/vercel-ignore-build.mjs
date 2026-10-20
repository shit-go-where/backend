#!/usr/bin/env node
/**
 * Vercel "Ignored Build Step" (wired up by `ignoreCommand` in vercel.json).
 *
 * Vercel runs this at the start of every Git-triggered build and reads the exit code:
 *   exit 0  -> skip (cancel) this build
 *   exit 1  -> build
 * Anything unexpected must end in a build, so every failure path below exits 1.
 *
 * What it does:
 *   1. Path filter (always on). Skips the build when the diff against the last successfully built
 *      commit only touches files that cannot change the deployed app (docs, CI config, tests).
 *   2. CI gate (opt-in). With SGW_REQUIRE_CI=1 in the Vercel project's Production environment
 *      variables, a production build waits for the GitHub Actions check runs of the commit and is
 *      cancelled if any of them failed. It fails open: no verdict within SGW_CI_WAIT_S seconds
 *      (default 600) or any API error means "build". Put `[skip-ci-gate]` in the commit message to
 *      bypass it (for example when shipping the fix for a red main).
 *      Public repos need no token; for a private repo set GITHUB_TOKEN (read access to checks).
 *
 * Hobby has one concurrent build, so a waiting gate queues later builds behind it. See README.md
 * ("Deploy gate").
 *
 * Local test: SGW_IGNORE_DRY_RUN=1 node .github/scripts/vercel-ignore-build.mjs
 */
import { execFileSync } from 'node:child_process';

const env = process.env;
const BUILD = 1;
const SKIP = 0;
const log = (msg) => console.log(`[ignore-build] ${msg}`);

/** Files that cannot change what is deployed. Keep this list short and obvious. */
const IRRELEVANT = [
  /^\.github\//,
  /^docs\//,
  /^test\//,
  /^\.agents\//,
  /^\.claude\//,
  /^\.windsurf\//,
  /^vitest(\.[a-z]+)?\.config\.ts$/,
  /^skills-lock\.json$/,
  /^API_CONTRACT\.md$/,
  /^openapi\.json$/,
  /(^|\/)[^/]+\.md$/,
];

function changedFiles() {
  const sha = env.VERCEL_GIT_COMMIT_SHA;
  const prev = env.VERCEL_GIT_PREVIOUS_SHA;
  if (!sha || !prev) return null;
  try {
    const out = execFileSync('git', ['diff', '--name-only', prev, sha], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean);
  } catch {
    return null; // previous commit not in the (shallow) clone
  }
}

function pathVerdict() {
  const files = changedFiles();
  if (!files) return { build: true, why: 'no previous build to compare with' };
  if (files.length === 0) return { build: true, why: 'empty diff (redeploy of the same commit)' };
  const relevant = files.filter((f) => !IRRELEVANT.some((re) => re.test(f)));
  if (relevant.length > 0) return { build: true, why: `deploy-relevant files changed (${relevant.slice(0, 3).join(', ')}${relevant.length > 3 ? ', ...' : ''})` };
  return { build: false, why: `only docs/CI/tests changed (${files.length} file${files.length === 1 ? '' : 's'})` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAD = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

/** 'green' | 'red' | 'unknown' */
async function ciVerdict() {
  const { VERCEL_GIT_REPO_OWNER: owner, VERCEL_GIT_REPO_SLUG: repo, VERCEL_GIT_COMMIT_SHA: sha } = env;
  if (!owner || !repo || !sha) return 'unknown';
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const waitMs = Number(env.SGW_CI_WAIT_S || 600) * 1000;
  const pollMs = Number(env.SGW_CI_POLL_S || 15) * 1000;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sgw-vercel-ignore-build' };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const started = Date.now();
  for (;;) {
    let runs;
    try {
      const res = await fetch(`${api}/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        log(`GitHub API answered ${res.status}`);
        return 'unknown';
      }
      runs = ((await res.json()).check_runs ?? []).filter((r) => r.app?.slug === 'github-actions');
    } catch (e) {
      log(`GitHub API error: ${e.message}`);
      return 'unknown';
    }
    const bad = runs.filter((r) => BAD.has(r.conclusion));
    if (bad.length > 0) {
      log(`failed check: ${bad.map((r) => `${r.name} (${r.conclusion})`).join(', ')}`);
      return 'red';
    }
    if (runs.length > 0 && runs.every((r) => r.status === 'completed')) return 'green';
    if (Date.now() - started + pollMs > waitMs) {
      log(`no verdict after ${Math.round((Date.now() - started) / 1000)} s (${runs.length} check runs)`);
      return 'unknown';
    }
    log(runs.length === 0 ? 'waiting for CI to start...' : `waiting for CI (${runs.filter((r) => r.status !== 'completed').length} of ${runs.length} still running)...`);
    await sleep(pollMs);
  }
}

async function main() {
  const gate = env.SGW_REQUIRE_CI === '1' && env.VERCEL_ENV === 'production';
  const bypass = /\[skip-ci-gate\]/i.test(env.VERCEL_GIT_COMMIT_MESSAGE ?? '');

  const p = pathVerdict();
  log(`${p.build ? 'build' : 'skip'}: ${p.why}`);
  if (!p.build) return SKIP;

  if (gate && !bypass) {
    const v = await ciVerdict();
    if (v === 'red') {
      log('CI is red for this commit: cancelling the production build. Fix forward, or add [skip-ci-gate] to the commit message.');
      return SKIP;
    }
    log(v === 'green' ? 'CI is green' : 'CI verdict unknown: building anyway (the gate fails open)');
  } else if (gate && bypass) {
    log('[skip-ci-gate] in the commit message: not checking CI');
  }
  return BUILD;
}

main()
  .then((code) => {
    if (env.SGW_IGNORE_DRY_RUN === '1') log(`(dry run) would exit ${code}`);
    process.exit(env.SGW_IGNORE_DRY_RUN === '1' ? 0 : code);
  })
  .catch((e) => {
    log(`unexpected error, building: ${e?.stack ?? e}`);
    process.exit(BUILD);
  });
