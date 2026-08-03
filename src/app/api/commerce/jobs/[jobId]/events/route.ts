import { type NextRequest } from 'next/server';
import { z } from 'zod';

import { resolveCommerceIdentity } from '@/lib/domains/commerce/agent/auth';
import { commerceApiError } from '@/lib/domains/commerce/agent/api';
import { getCommerceAsyncAgentService } from '@/lib/domains/commerce/agent/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const jobIdSchema = z.string().regex(/^job_[A-Za-z0-9-]{16,80}$/u);
const encoder = new TextEncoder();

function afterEventId(request: NextRequest): number {
  const value = request.headers.get('last-event-id') || request.nextUrl.searchParams.get('after') || '0';
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const identity = resolveCommerceIdentity(request);
    const { jobId: rawJobId } = await context.params;
    const jobId = jobIdSchema.parse(rawJobId);
    await getCommerceAsyncAgentService().getJob(identity, jobId);
    let cursor = afterEventId(request);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const deadline = Date.now() + 25_000;
        try {
          while (!request.signal.aborted && Date.now() < deadline) {
            const events = await getCommerceAsyncAgentService().getEvents(identity, jobId, cursor);
            for (const event of events) {
              cursor = event.id;
              controller.enqueue(encoder.encode(
                `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`,
              ));
              if (['completed', 'failed', 'dead_lettered'].includes(event.type)) {
                controller.close();
                return;
              }
            }
            controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    return commerceApiError(error);
  }
}
