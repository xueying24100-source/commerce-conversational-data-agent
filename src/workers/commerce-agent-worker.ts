import { runCommerceAgentWorker } from '../lib/domains/commerce/agent/worker';
import { closeCommerceDatabases } from '../lib/domains/commerce/agent/database';

const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => shutdown.abort(new Error(`Received ${signal}.`)));
}

async function main() {
  try {
    await runCommerceAgentWorker(shutdown.signal);
  } finally {
    await closeCommerceDatabases();
  }
}

main().catch((error) => {
  console.error('[commerce-worker] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
