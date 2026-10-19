#!/usr/bin/env node
// #2010 immutable Artifact parser tests: legitimate multi-member ZIP and
// rejects traversal, duplicates, extra entries, forged CRC and zip bombs.
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {readWorkerZipMember} from './worker-zip.mjs';

function crc32(bytes){
  let crc=0xffffffff;
  for(const b of bytes){
    crc^=b;
    for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);
  }
  return(crc^0xffffffff)>>>0;
}
function pack(spec){
  const locals=[],centers=[];
  let offset=0;
  for(const {name,body,deflate=false,mode=0} of spec){
    const nameBuf=Buffer.from(name),value=Buffer.from(body),
      compressed=deflate?deflateRawSync(value):value;
    const crc=crc32(value),method=deflate?8:0;
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);
    local.writeUInt16LE(method,8);local.writeUInt32LE(crc,14);
    local.writeUInt32LE(compressed.length,18);
    local.writeUInt32LE(value.length,22);
    local.writeUInt16LE(nameBuf.length,26);
    locals.push(local,nameBuf,compressed);
    const central=Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50,0);
    central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);
    central.writeUInt16LE(method,10);central.writeUInt32LE(crc,16);
    central.writeUInt32LE(compressed.length,20);
    central.writeUInt32LE(value.length,24);
    central.writeUInt16LE(nameBuf.length,28);
    central.writeUInt32LE(mode<<16,38);
    central.writeUInt32LE(offset,42);
    centers.push(central,nameBuf);
    offset+=30+nameBuf.length+compressed.length;
  }
  const centralData=Buffer.concat(centers);
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(spec.length,8);end.writeUInt16LE(spec.length,10);
  end.writeUInt32LE(centralData.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,centralData,end]);
}
const claim=pack([{name:'development-worker-claim.json',body:'{"claim":1}\n'}]);
assert.equal(readWorkerZipMember(claim,'development-worker-claim.json').toString(),
  '{"claim":1}\n');
const sample=[
  {name:'proof.json',body:'{"proof":2}\n'},
  {name:'result.json',body:'{"result":3}\n',deflate:true},
  {name:'ciphertext.json',body:'{"ciphertext":1}\n',deflate:true},
];
const result=pack(sample);
for(const {name,body} of sample)
  assert.equal(readWorkerZipMember(result,name).toString(),body);
assert.throws(()=>readWorkerZipMember(result,'development-worker-claim.json'),/ZIP/);
assert.throws(()=>readWorkerZipMember(claim,'unknown.json'),/unapproved/);
assert.throws(()=>readWorkerZipMember(pack([...sample,
  {name:'evil.json',body:'{}'}]),'result.json'),/ZIP/);
assert.throws(()=>readWorkerZipMember(pack([...sample.slice(0,2),sample[0]]),
  'proof.json'),/duplicate/);
assert.throws(()=>readWorkerZipMember(pack([
  {...sample[0],name:'../proof.json'},...sample.slice(1)]),
  'result.json'),/unexpected/);
assert.throws(()=>readWorkerZipMember(pack([
  {...sample[0],mode:0o120000},...sample.slice(1)]),
  'result.json'),/unsupported/);
assert.throws(()=>readWorkerZipMember(pack([
  {name:'development-worker-claim.json',body:'x'.repeat(128*1024),deflate:true}]),
  'development-worker-claim.json'),/budget/);
const corrupt=Buffer.from(result);
const position=result.indexOf(Buffer.from('{"proof":2}\n'));
assert.ok(position>=0);corrupt[position]^=1;
assert.throws(()=>readWorkerZipMember(corrupt,'proof.json'),/CRC/);
assert.throws(()=>readWorkerZipMember(result.subarray(0,result.length-1),
  'proof.json'),/ZIP/);
console.log('Worker ZIP: valid single+multi JSON, deflate, CRC, symlink, duplicate, traversal and zip-bomb negatives passed');
