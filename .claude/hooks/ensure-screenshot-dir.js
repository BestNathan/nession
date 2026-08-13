#!/usr/bin/env node
// ensure-screenshot-dir.js — PostToolUse hook
//
// mcp__playwright__browser_take_screenshot 的 filename 传裸文件名时，Playwright
// MCP 会把它解析为相对于 cwd（仓库根目录）的路径，截图落到工作区。PreToolUse
// 的 updatedInput 对 MCP 工具不支持（会被静默忽略），所以这里在截图完成后，
// 把裸文件名的截图从根目录移动到 .playwright-mcp/screenshots/。
//
// 不改动的情况：
//   - 没传 filename（用 Playwright 默认名，落在 --output-dir 下）
//   - filename 含 "/"（绝对路径 / 子目录 / 已带正确前缀）

const fs = require('fs');
const path = require('path');

const PREFIX = '.playwright-mcp/screenshots/';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  const filename = data && data.tool_input && data.tool_input.filename;
  if (typeof filename !== 'string' || filename === '' || filename.includes('/')) {
    return;
  }

  const cwd = (data && data.cwd) || process.cwd();
  const src = path.join(cwd, filename);
  const destDir = path.join(cwd, PREFIX);
  const dest = path.join(destDir, filename);

  try {
    if (!fs.existsSync(src)) {
      return;
    }
    fs.mkdirSync(destDir, { recursive: true });
    let finalDest = dest;
    if (fs.existsSync(finalDest)) {
      // 重名 → 加时间戳，不覆盖
      finalDest = path.join(
        destDir,
        filename.replace(/\.(png|jpe?g|webp)$/i, '') + '-' + Date.now() + path.extname(filename),
      );
    }
    fs.renameSync(src, finalDest);
  } catch {
    // 静默失败，交给 pre-commit 的 move-screenshots.sh 兜底
  }
});
