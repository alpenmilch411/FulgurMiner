// Worker-thread bootstrap for powWorker.ts.
//
// Spawned as a native-ESM .mjs (Node loads it with no loader setup), it registers
// tsx programmatically and THEN imports the TypeScript worker. This is far more
// robust across Node versions than spawning the .ts worker with
// `execArgv: ['--import', 'tsx']`: that flag doesn't reliably activate tsx's
// .js->.ts resolver inside worker threads on some Node versions, which left the
// worker unable to resolve `../crypto/pow.js` (ERR_MODULE_NOT_FOUND) and crashed
// every grind/verify worker (0 H/s). Registering via the API here sidesteps that.
import { register } from 'tsx/esm/api';

register();
await import('./powWorker.ts');
