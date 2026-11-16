import { defaultDeps } from '@/server/deps';
import { createQaVoteHandler } from '@/server/handlers/qa';

const handler = createQaVoteHandler(defaultDeps);

export async function POST(request: Request, context: { params: Promise<{ submissionId: string }> }): Promise<Response> {
  return handler(request, await context.params);
}
