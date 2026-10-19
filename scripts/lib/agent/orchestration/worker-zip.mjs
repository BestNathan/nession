// #2010. Strict GitHub Worker ZIP reader; no shell, filesystem extraction,
// traversal, ZIP64, symlinks, additional entries, zip bombs or file ambiguity.
// The legacy result-artifact.mjs single-member contract stays unchanged.
import {inflateRawSync} from 'node:zlib';

const CLAIM=['development-worker-claim.json'];
const RESULT=['ciphertext.json','proof.json','result.json'];
function fail(s){throw Error('trusted Agent Worker ZIP: '+s);}
function crc32(bytes){
  let crc=0xffffffff;
  for(const b of bytes){
    crc^=b;
    for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);
  }
  return (crc^0xffffffff)>>>0;
}
export function readWorkerZipMember(zip,wanted){
  const expected=wanted===CLAIM[0]?CLAIM:RESULT;
  if(!expected.includes(wanted))fail('unapproved Worker ZIP member');
  const claim=expected===CLAIM,maxZip=claim?256*1024:32*1024*1024;
  const maxJson=claim?64*1024:wanted==='ciphertext.json'?24*1024*1024:64*1024;
  if(!Buffer.isBuffer(zip)||zip.length<52||zip.length>maxZip)
    fail('unsafe Worker ZIP byte budget');
  const end=zip.length-22;
  if(zip.readUInt32LE(end)!==0x06054b50||
      zip.readUInt16LE(end+4)!==0||zip.readUInt16LE(end+6)!==0||
      zip.readUInt16LE(end+8)!==expected.length||
      zip.readUInt16LE(end+10)!==expected.length||
      zip.readUInt16LE(end+20)!==0)
    fail('noncanonical ZIP end-of-central-directory');
  const centralSize=zip.readUInt32LE(end+12),central=zip.readUInt32LE(end+16);
  if(centralSize<46*expected.length||central+centralSize!==end||
      central<=0||central>maxZip)fail('unsafe ZIP central bounds');
  const items=[],names=new Set();
  let cursor=central;
  for(let i=0;i<expected.length;i++){
    if(cursor+46> end||zip.readUInt32LE(cursor)!==0x02014b50)
      fail('invalid ZIP central record');
    const flags=zip.readUInt16LE(cursor+8),method=zip.readUInt16LE(cursor+10);
    const crc=zip.readUInt32LE(cursor+16),
      compressed=zip.readUInt32LE(cursor+20),length=zip.readUInt32LE(cursor+24);
    const nameLen=zip.readUInt16LE(cursor+28),
      extra=zip.readUInt16LE(cursor+30),comment=zip.readUInt16LE(cursor+32);
    const disk=zip.readUInt16LE(cursor+34);
    const offset=zip.readUInt32LE(cursor+42);
    const unixType=(zip.readUInt32LE(cursor+38)>>>16)&0o170000;
    const stop=cursor+46+nameLen+extra+comment;
    if(stop>end||nameLen<1||nameLen>100||
        (flags&~(0x0800|0x0008))!==0||![0,8].includes(method)||
        compressed>maxZip||length>24*1024*1024||
        [compressed,length,offset].includes(0xffffffff)||disk!==0||
        ![0,0o100000].includes(unixType)||offset>=central)
      fail('unsupported/unsafe ZIP entry');
    const name=zip.subarray(cursor+46,cursor+46+nameLen).toString('utf8');
    if(!expected.includes(name)||names.has(name)||nameLen!==Buffer.byteLength(name))
      fail('unexpected or duplicate Worker ZIP member');
    names.add(name);
    items.push({name,flags,method,crc,compressed,length,offset});
    cursor=stop;
  }
  if(cursor!==end||expected.some(x=>!names.has(x)))
    fail('missing/extra ZIP entries');
  let next=0,result;
  for(const e of items.sort((a,b)=>a.offset-b.offset)){
    const p=e.offset;
    if(p!==next||p+30>central||zip.readUInt32LE(p)!==0x04034b50||
        zip.readUInt16LE(p+6)!==e.flags||zip.readUInt16LE(p+8)!==e.method)
      fail('ZIP local order/header mismatch');
    const len=zip.readUInt16LE(p+26),extra=zip.readUInt16LE(p+28);
    if(len!==Buffer.byteLength(e.name)||p+30+len+extra>central||
        zip.subarray(p+30,p+30+len).toString('utf8')!==e.name)
      fail('unsafe local member identity');
    const start=p+30+len+extra,stop=start+e.compressed;
    if(stop>central)fail('compressed Worker bytes overlap directory');
    const hasDescriptor=Boolean(e.flags&8);
    if(!hasDescriptor&&(zip.readUInt32LE(p+14)!==e.crc||
        zip.readUInt32LE(p+18)!==e.compressed||
        zip.readUInt32LE(p+22)!==e.length))
      fail('ZIP local data digest mismatch');
    if(hasDescriptor){
      if(stop+12>central)fail('truncated ZIP data descriptor');
      const signed=stop+16<=central&&zip.readUInt32LE(stop)===0x08074b50;
      const at=stop+(signed?4:0);
      if(zip.readUInt32LE(at)!==e.crc||
          zip.readUInt32LE(at+4)!==e.compressed||
          zip.readUInt32LE(at+8)!==e.length)
        fail('ZIP descriptor mismatch');
      next=at+12;
    }else next=stop;
    if(next>central)fail('unsafe ZIP member boundary');
    if(e.name===wanted){
      if(e.length>maxJson)fail('requested Worker member exceeds budget');
      let content;
      try{content=e.method===0?zip.subarray(start,stop):
        inflateRawSync(zip.subarray(start,stop),{maxOutputLength:maxJson+1});}
      catch{fail('invalid/compression-bomb Worker member');}
      if(content.length!==e.length||crc32(content)!==e.crc)
        fail('Worker ZIP member length/CRC mismatch');
      result=content;
    }
  }
  if(next!==central||!result)fail('Worker ZIP has trailing or missing bytes');
  return result;
}
