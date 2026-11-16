import { defaultDeps } from '@/server/deps';
import { createSubmitTaskHandler } from '@/server/handlers/tasks';

const handler = createSubmitTaskHandler(defaultDeps);

export async function POST(request: Request, context: { params: Promise<{ itemId: string }> }): Promise<Response> {
  return handler(request, await context.params);
}
