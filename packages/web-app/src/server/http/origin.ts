import { ApiFailure } from './errors';

/**
 * Mutations must come from the app itself: the `Origin` header (always sent by browsers on POST)
 * has to equal the configured app origin. A missing header is refused too.
 */
export function assertSameOrigin(request: Request, appOrigin: string): void {
  const origin = request.headers.get('origin');
  if (origin === null || origin !== appOrigin) {
    throw new ApiFailure('BAD_ORIGIN', 'This request must come from the VeriWork app.');
  }
}
