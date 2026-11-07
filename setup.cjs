const fs = require('node:fs');
const path = require('node:path');
process.chdir(__dirname);
const file = path.join(__dirname, 'package.json');
const pkg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { name: 'linkedin-bot', version: '1.0.0' };
pkg.type = 'module';
pkg.private = true;
pkg.description = 'Local, reply-only LinkedIn assessment assistant';
pkg.engines = { node: '>=22' };
pkg.scripts = { ...pkg.scripts,
  start: 'npm run build --silent && node dist/src/index.js',
  login: 'npm run build --silent && node dist/src/index.js login',
  check: 'npm run build --silent && node dist/src/index.js check',
  'ai-check': 'npm run build --silent && node dist/src/index.js ai-check',
  build: 'tsc',
  typecheck: 'tsc --noEmit',
  test: 'npm run build --silent && node --test dist/tests/core.test.js',
  'test:browser': 'npm run build --silent && node --test dist/tests/browser.test.js'
};
pkg.dependencies = { playwright: '^1.56.1', dotenv: '^17.2.3', ...pkg.dependencies };
pkg.devDependencies = { typescript: '^5.9.3', tsx: '^4.20.6', '@types/node': '^24.10.0', ...pkg.devDependencies };
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
if (!fs.existsSync('.env')) fs.copyFileSync('.env.example', '.env');
console.log('Project scripts configured; existing dependency versions preserved.');
console.log('Next: npm install, edit .env, then npm run login.');
