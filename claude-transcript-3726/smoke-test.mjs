// Static artifact smoke only; not a browser/Acceptance verifier.
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
import assert from "node:assert/strict";
const dir=dirname(fileURLToPath(import.meta.url));
const html=readFileSync(join(dir,"index.html"),"utf8");
const js=readFileSync(join(dir,"app.js"),"utf8");
const css=readFileSync(join(dir,"styles.css"),"utf8");
for(const name of ["data-np-device","data-np-size=\"1180\"","data-np-size=\"390\"","data-np-reset","append-fixture","switch-fixture"])assert(html.includes(name),name);
for(const name of ["r09","r10","r11","tool_use","tool_result","raw-panel","navigator.clipboard","JSON.parse","resetSelection","older","np:resize"])assert(js.includes(name),name);
assert(js.includes('rawId')&&js.includes('treeNode'));
assert(!js.includes("已识别")&&!js.includes("未识别"));
assert(css.includes("[data-mode=app]")&&css.includes(".raw-overlay"));
new Function(js); // syntax only; no DOM/runtime simulation
console.log("Claude Transcript #3726 static smoke passed (not browser proof).");
