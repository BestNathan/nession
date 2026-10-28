#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {cursorModel, claudeGatewayModel} from './model-selection.mjs';

assert.deepEqual(cursorModel({CURSOR_MODEL: 'composer-2.5'}),
  {id: 'composer-2.5', fast: true});
assert.deepEqual(cursorModel({CURSOR_MODEL: 'composer-2.5', CURSOR_MODEL_FAST: 'false'}),
  {id: 'composer-2.5', fast: false});
assert.deepEqual(cursorModel({CURSOR_MODEL: 'composer-2.5', CURSOR_MODEL_FAST: ''}),
  {id: 'composer-2.5', fast: true});
assert.throws(() => cursorModel({}), /missing CURSOR_MODEL/);
assert.throws(() => cursorModel({CURSOR_MODEL: ''}), /missing CURSOR_MODEL/);
assert.throws(() => cursorModel({CURSOR_MODEL: ' composer-2.5'}), /malformed CURSOR_MODEL/);
assert.throws(() => cursorModel({CURSOR_MODEL: 42}), /missing CURSOR_MODEL/);
// Another Provider's model variable must never satisfy the Cursor binding.
assert.throws(() => cursorModel({ANTHROPIC_MODEL: 'qwen3.7-plus'}), /missing CURSOR_MODEL/);

assert.equal(claudeGatewayModel('qwen3.7-plus', {provider: 'qwen'}), 'qwen3.7-plus');
assert.equal(claudeGatewayModel('deepseek-flash[1m]', {provider: 'deepseek'}),
  'deepseek-flash[1m]');
assert.throws(() => claudeGatewayModel(undefined, {provider: 'qwen'}), /missing ANTHROPIC_MODEL/);
assert.throws(() => claudeGatewayModel('', {provider: 'deepseek'}), /missing ANTHROPIC_MODEL/);
assert.throws(() => claudeGatewayModel(42, {provider: 'deepseek'}), /missing ANTHROPIC_MODEL/);
assert.throws(() => claudeGatewayModel('claude-sonnet-5', {provider: 'qwen'}), /Qwen model/);
assert.throws(() => claudeGatewayModel('glm-5', {provider: 'qwen'}), /Qwen model/);
assert.throws(() => claudeGatewayModel('qwen3.7-plus', {provider: 'cursor'}),
  /unsupported Claude Gateway provider/);
// A missing Environment model is not repaired by a same-family default.
assert.throws(() => claudeGatewayModel(undefined, {provider: 'deepseek', variable: 'ACCEPTANCE_CLAUDE_MODEL'}),
  /missing ACCEPTANCE_CLAUDE_MODEL/);

// SC-03: role workflows must not hardcode a model name as a fallback.
const HARDCODED = /\|\|\s*'(?:composer-|claude-(?:opus|sonnet|haiku)-)[^']*'/;
assert.match("x: ${{ vars.CURSOR_MODEL || 'composer-2.5' }}", HARDCODED);
assert.doesNotMatch("x: ${{ vars.CURSOR_MODEL }}", HARDCODED);
assert.doesNotMatch("x: ${{ vars.ANTHROPIC_MODEL || vars.ACCEPTANCE_CLAUDE_MODEL }}", HARDCODED);
for (const file of [
  '.github/workflows/agent-sc-acceptance.yml',
  '.github/workflows/agent-issue-audit.yml',
  '.github/workflows/agent-review.yml',
  '.github/workflows/agent-develop.yml',
  '.github/workflows/agent-provider-smoke.yml',
  '.github/workflows/agent-cursor-resume-seed.yml',
  '.github/workflows/agent-cursor-resume-verify.yml',
]) {
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), HARDCODED, file);
}
console.log('Agent model selection: Environment-only models, fail-closed missing/invalid/cross-provider cases and no workflow model literals passed');
