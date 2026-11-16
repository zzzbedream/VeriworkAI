import { defaultDeps } from '@/server/deps';
import { createNextReviewHandler } from '@/server/handlers/review';

export const GET = createNextReviewHandler(defaultDeps);
