// CJS consumer smoke test.
// Run after `pnpm build`: node examples/cjs-smoke.cjs
const lib = require('../dist/index.cjs');
if (typeof lib.VERSION !== 'string') {
  console.error('VERSION export missing from CJS bundle');
  process.exit(1);
}
console.log('CJS OK, version', lib.VERSION);
