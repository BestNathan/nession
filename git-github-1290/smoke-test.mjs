// Dependency-free deterministic mock checks; does not call a real browser or API.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
const app = { innerHTML: '' };
const listeners = new Map();
const document = {
  getElementById: id => { assert.equal(id, 'app'); return app; },
  addEventListener: (name, fn) => listeners.set(name, fn),
  querySelector: () => ({focus(){},setSelectionRange(){}})
};
const js = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
assert.doesNotMatch(js, /\bfetch\s*\(/);
assert.doesNotMatch(js, /localStorage|sessionStorage/);
runInNewContext(js, { document });
let count=0;
function check(label, condition) {assert.ok(condition, label);count++}
function click(action,value) {
  const el={dataset:{action,value},closest:()=>el};
  listeners.get('click')({target:el});
}
function change(key,value) {listeners.get('change')({target:{dataset:{select:key},value}})}
check('initial Terminal',app.innerHTML.includes('data-testid="terminal-surface"'));
click('toggle-context');
check('context disclosure',app.innerHTML.includes('data-testid="context-capsule"'));
click('choose-git');
check('Git directly in Workspace',app.innerHTML.includes('data-testid="workspace-surface"'));
check('no Git Peek',!app.innerHTML.includes('data-testid="git-peek-body"')&&!app.innerHTML.includes('aria-label="Git Peek"'));
check('local Changes',app.innerHTML.includes('Working tree'));
click('select-file','crates/nession-git/src/runtime/remote.rs');
check('file selection',app.innerHTML.includes('remote.rs')&&app.innerHTML.includes('typed remote fixture'));
click('local-tab','history');
check('History',app.innerHTML.includes('feat: GitHub repository context'));
click('local-tab','branches');
check('Branches',app.innerHTML.includes('release/next'));
click('section','github');
check('GitHub identity',app.innerHTML.includes('demo-org/nession'));
click('github-tab','prs');
check('PR branch relation',app.innerHTML.includes('Matched PR #2534'));
change('remote','fork');
check('fork identity',app.innerHTML.includes('demo-fork/nession'));
check('no false fork branch PR',app.innerHTML.includes('No matching PR for selected fork'));
click('github-tab','actions');
check('Actions scope',app.innerHTML.includes('Current branch'));
click('scope','repo');
check('repo-wide scope',app.innerHTML.includes('Most recent run across all branches'));
change('scenario','auth');
check('auth failure',app.innerHTML.includes('Authentication required'));
click('to-local');
check('local Git unaffected',app.innerHTML.includes('Working tree'));
change('scenario','ambiguous');
click('section','github');
check('ambiguous remote',app.innerHTML.includes('Multiple GitHub remotes'));
click('resolve-ambiguity','upstream');
check('safe discovered remote',app.innerHTML.includes('demo-org/nession'));
change('scenario','noRemote');
check('no remote',app.innerHTML.includes('No GitHub remote'));
change('scenario','empty');
check('empty valid',app.innerHTML.includes('No matching issues'));
change('scenario','noRuns');
click('github-tab','actions');
check('no runs valid',app.innerHTML.includes('No runs yet'));
click('refresh');
check('refresh counter',app.innerHTML.includes('Snapshot #2'));
click('reset');
check('reset Terminal',app.innerHTML.includes('data-testid="terminal-surface"'));
console.log(count+' / '+count+' deterministic prototype assertions passed (VM mock, not browser verification)');