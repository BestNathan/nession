import assert from "node:assert/strict";
import {parseText, validateEnvelope, directiveText, referenceText} from "./content-parser.mjs";
const examples = [
  {v:1, op:"render", component:"agent.list", input:{status:"online"}},
  {v:1, op:"reference", component:"agent.list", ref:"cmp_82", context:{selectedAgentId:"beijing"}}
];
let assertions=0;
const check=(condition,label)=>{assert.ok(condition,label);assertions++};
for (const directive of examples) {
  const src="Before\n\n"+directiveText(directive)+"\n\nAfter";
  const parsed=parseText(src);
  check(parsed.length===3,"mixed text/component/text");
  check(parsed[0].kind==="text"&&parsed[2].kind==="text","prose retained");
  check(parsed[1].kind==="component"&&parsed[1].value.op===directive.op,"directive parsed");
  const head=src.slice(0,src.indexOf('"ref"')>0?src.indexOf('"ref"'):src.indexOf('"status"'));
  check(parseText(head,false).some(x=>x.kind==="pending"),"partial fence is pending");
}
const code=String.fromCharCode(96).repeat(3);
check(parseText(code+"json\n"+directiveText(examples[0])+"\n"+code)[0].kind==="text","literal nested code example not executed");
check(parseText(directiveText({v:1,op:"render",component:"agent.list",input:{}}).replace('"v": 1','"v": 2'))[0].kind==="error","v2 rejected");
check(parseText(directiveText(examples[0]).replace('"input"', '"bad"'))[0].kind==="error","extra fields rejected");
check(parseText(code+"nession-ui\n{not json}\n"+code)[0].kind==="error","malformed json rejected");
check(parseText(code+"nession-ui\n{}")[0].kind==="error","unclosed settled rejected");
check(parseText(code+"nession-ui\n{}",false)[0].kind==="pending","unclosed streaming pending");
check(validateEnvelope({v:1,op:"reference",component:"agent.list"})!==null,"reference requires ref");
check(referenceText({component:"agent.list",ref:"cmp_82"},{selectedAgentId:"beijing"}).includes('"selectedAgentId"'),"reference round trip");
check(parseText("ordinary assistant text")[0].kind==="text","text unchanged");
console.log("PASS: " + assertions + " text-protocol parser smoke assertions (mock prototype only)");
