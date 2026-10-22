// Trusted restore/ingest only. Never supply this key seed to model executors.
import {hkdfSync} from 'node:crypto';
export function deriveStoreAesKey(privateKey){
  if(typeof privateKey!=='string'||privateKey.length<200)
    throw Error('trusted checkpoint key: Store key seed missing');
  return Buffer.from(hkdfSync('sha256',Buffer.from(privateKey),
    Buffer.from('BestNathan/nession'),Buffer.from('nession-agent-native-checkpoint-store-v1'),32));
}
