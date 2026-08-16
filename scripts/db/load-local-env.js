const fs = require('node:fs');
const path = require('node:path');

function loadLocalEnv(root) {
  if (process.env.COMMERCE_DISABLE_LOCAL_ENV_FILES === '1') return;
  if (typeof process.loadEnvFile !== 'function') {
    throw new Error('Node.js 22+ is required to load local environment files.');
  }
  for (const name of ['.env.local', '.env.release.local']) {
    const envPath = path.join(root, name);
    if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  }
  if (process.env.NODE_ENV === 'production') return;
  const candidate = process.env.COMMERCE_TEST_DATABASE_URL?.trim()
    || process.env.COMMERCE_LIVE_E2E_DATABASE_URL?.trim();
  if (!candidate) return;
  try {
    const parsed = new URL(candidate);
    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    ) return;
  } catch {
    return;
  }
  process.env.COMMERCE_DATABASE_URL ||= candidate;
  process.env.COMMERCE_ANALYTICS_DATABASE_URL ||= candidate;
  process.env.COMMERCE_CONTROL_MIGRATION_DATABASE_URL ||= candidate;
  process.env.COMMERCE_ANALYTICS_MIGRATION_DATABASE_URL ||= candidate;
  process.env.COMMERCE_ANALYTICS_INGEST_DATABASE_URL ||= candidate;
}

module.exports = { loadLocalEnv };
