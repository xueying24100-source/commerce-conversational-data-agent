import { runCommerceAgentWorker } from '../lib/domains/commerce/agent/worker';

const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => shutdown.abort(new Error(`Received ${signal}.`)));
}

runCommerceAgentWorker(shutdown.signal).catch((error) => {
  console.error('[commerce-worker] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
