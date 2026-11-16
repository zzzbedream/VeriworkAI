import { defaultDeps } from '@/server/deps';
import { createSubmitReviewHandler } from '@/server/handlers/review';

const handler = createSubmitReviewHandler(defaultDeps);

export async function POST(request: Request, context: { params: Promise<{ submissionId: string }> }): Promise<Response> {
  return handler(request, await context.params);
}
