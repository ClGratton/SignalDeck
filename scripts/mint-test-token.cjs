// Dev-only helper: mints a valid session token from AUTH_SECRET so the owner's
// agent can verify privileged pages in a browser WITHOUT typing the real
// password. Prints the token only — never the secret. Delete-safe.
const fs = require('fs');
const crypto = require('crypto');
const env = fs.readFileSync('.env.local', 'utf8');
const m = env.match(/^AUTH_SECRET=(.+)$/m);
if (!m) {
  console.error('AUTH_SECRET not found');
  process.exit(1);
}
let epoch = 1;
try {
  epoch = JSON.parse(fs.readFileSync('data/auth-state.json', 'utf8')).epoch ?? 1;
} catch {}
const payload = `g.${epoch}.${Date.now()}`;
const sig = crypto.createHmac('sha256', m[1].trim()).update(payload).digest('base64url');
console.log(`${payload}.${sig}`);
