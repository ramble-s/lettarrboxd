const fs = require('fs');
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
try {
  const ts = fs.readFileSync(`${process.env.DATA_DIR ?? '/data'}/.last-run`, 'utf8');
  const age = Date.now() - Date.parse(ts);
  if (age > MAX_AGE_MS) {
    console.error(`Last run was ${Math.round(age / 60000)}m ago (threshold: ${MAX_AGE_MS / 60000}m)`);
    process.exit(1);
  }
  process.exit(0);
} catch {
  process.exit(1);
}
