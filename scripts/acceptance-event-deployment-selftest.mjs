#!/usr/bin/env node
// Static deployment contract; no privileged service or GitHub App secrets.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const base='deploy/acceptance-relay/';
const yaml=fs.readFileSync(base+'compose.yaml','utf8');
const guide=fs.readFileSync(base+'README.md','utf8');
function sectionsOf(config){
  return Object.fromEntries(['state-init','ingress','publisher','webhook-recovery']
    .map(name=>{
      const start=config.indexOf('\n  '+name+':\n');
      assert.ok(start>=0,'missing service '+name);
      const remaining=config.slice(start+5+name.length);
      const end=remaining.search(/\n  [a-z][\w-]*:|\nvolumes:/);
      return [name,end<0?remaining:remaining.slice(0,end)];
    }));
}
function verify(config){
  const sections=sectionsOf(config);
  assert.match(config,/x-relay-base: &relay-base/);
  assert.match(config,/image: node:24-bookworm-slim/);
  assert.match(config,/user: "1000:1000"/);
  assert.match(config,/read_only: true/);
  assert.match(config,/no-new-privileges:true/);
  assert.match(config.split('\nservices:\n')[0],/acceptance-sqlite:\/state/);
  assert.ok(config.includes('../../:/repo:ro'),'trusted repo must mount read-only');
  assert.match(config,/127\.0\.0\.1:[^\n]*:8080/);
  assert.match(config,/ACCEPTANCE_RELAY_MODE: shadow/);
  assert.match(config,/ACCEPTANCE_RELAY_DB: \/state\/acceptance\.sqlite/);
  assert.doesNotMatch(config,/^\s*GITHUB_APP_PRIVATE_KEY:|^\s*GITHUB_PUBLISHER_PRIVATE_KEY:/m);
  assert.doesNotMatch(config,/^\s*network_mode: host/m);
  assert.doesNotMatch(config,/0\.0\.0\.0:.*8080/);
  assert.match(config,/^volumes:\n  acceptance-sqlite:/m);
  assert.match(sections['state-init'],/profiles: \[shadow, live\]/);
  assert.match(sections['state-init'],/chmod 0700 \/state/);
  assert.match(sections.ingress,/profiles: \[shadow, live\]/);
  assert.match(sections.publisher,/profiles: \[live\]/);
  assert.match(sections['webhook-recovery'],/profiles: \[live\]/);
  assert.match(sections.publisher,/ACCEPTANCE_PUBLISHER_MODE: live/);
  assert.match(sections['webhook-recovery'],/ACCEPTANCE_WEBHOOK_RECOVERY_MODE: enabled/);
  assert.doesNotMatch(sections.publisher,/ports:/);
  assert.doesNotMatch(sections['webhook-recovery'],/ports:/);
  assert.match(sections.ingress,/relay\.env/);
  assert.match(sections.publisher,/publisher\.env/);
  assert.match(sections['webhook-recovery'],/recovery\.env/);
}
verify(yaml);
assert.match(guide,/before closing the parent requirement/);
assert.match(guide,/no new.*Actions Run/i);
assert.match(guide,/TLS|HTTPS/);
assert.match(guide,/429/);
assert.match(guide,/backup/i);
assert.match(guide,/never.*?down -v/i);
assert.match(guide,/three-day|3-day/);
assert.match(guide,/separate/i);
assert.match(guide,/Waker\/Quota Recovery|Post-Run Waker/);
const mutations=[
  yaml.replace('ACCEPTANCE_RELAY_MODE: shadow','ACCEPTANCE_RELAY_MODE: live'),
  yaml.replace(/127\.0\.0\.1:[^\n]*:8080/,'0.0.0.0:19091:8080'),
  yaml.replace('acceptance-sqlite:/state',''),
  yaml.replace('publisher:\n    <<: *relay-base\n    profiles: [live]',
    'publisher:\n    <<: *relay-base\n    profiles: [shadow, live]'),
];
for(const wrong of mutations)assert.throws(()=>verify(wrong),assert.AssertionError,
  'deployment regression must fail closed');
console.log('Acceptance deployment: explicit shadow/live split, loopback TLS boundary, durable SQLite, secret separation, non-root runtime and negative fixtures passed');
