import { z } from 'zod';
import { Prisma } from './generated/prisma/client';

const UniqueMetaSchema = z.object({
  target: z.union([z.string(), z.array(z.string())]).optional(),
  driverAdapterError: z
    .object({
      cause: z
        .object({
          constraint: z
            .object({ index: z.string().optional(), fields: z.array(z.string()).optional() })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * Name of the violated unique constraint/index (or its fields joined with `,`) when `error` is a
 * unique-constraint violation (P2002), otherwise `null`.
 */
export function uniqueViolation(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
    return null;
  const meta = UniqueMetaSchema.safeParse(error.meta ?? {});
  if (!meta.success) return '';
  const constraint = meta.data.driverAdapterError?.cause?.constraint;
  const target = meta.data.target;
  return (
    constraint?.index ??
    constraint?.fields?.join(',') ??
    (Array.isArray(target) ? target.join(',') : (target ?? ''))
  );
}
