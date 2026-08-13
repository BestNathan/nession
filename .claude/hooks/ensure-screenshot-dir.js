#!/usr/bin/env node
// ensure-screenshot-dir.js — PreToolUse hook
//
// mcp__playwright__browser_take_screenshot 的 filename 传裸文件名时，Playwright
// MCP 会把它解析为相对于 cwd（仓库根目录）的路径，导致截图落到工作区并泄漏进
// commit。这里拦截调用，把裸文件名自动补上 .playwright-mcp/screenshots/ 前缀。
//
// 不改动的情况：
//   - 没传 filename（用 Playwright 默认名）
//   - filename 含 "/"（绝对路径 / 子目录 / 已带正确前缀）

const PREFIX = '.playwright-mcp/screenshots/';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return emitAllow();
  }

  const filename = data && data.tool_input && data.tool_input.filename;
  if (typeof filename !== 'string' || filename === '' || filename.includes('/')) {
    return emitAllow();
  }

  const updatedInput = { ...data.tool_input, filename: PREFIX + filename };
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
  }));
});

function emitAllow() {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  }));
}
