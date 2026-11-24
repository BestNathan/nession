import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Playwright must exercise the actual Vite-compiled artifact, not source
// files. The Pages build is credential-free and offline here; deterministic
// public data is injected by pagesStandalone.ts at request time.
export default function pagesGlobalSetup(){
  const pages=fileURLToPath(new URL('../pages',import.meta.url));
  execFileSync('npm',['run','build'],{
    cwd:pages,
    stdio:'inherit',
    env:{...process.env,PAGES_OFFLINE:'1',SOURCE_MAIN_SHA:'a'.repeat(40)},
  });
}
