// The public development/preview server uses the same non-AI static package.
const path = require('node:path');
if (!process.argv[2]) process.argv[2] = process.env.PORT || '5174';
require(path.join(__dirname, '../generated/web-lite/serve.cjs'));
