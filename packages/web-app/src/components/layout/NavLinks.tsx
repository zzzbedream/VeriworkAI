'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Props = {
  readonly label: string;
  readonly links: readonly { readonly href: string; readonly label: string }[];
};

/** Main navigation; the current page is marked with `aria-current`. */
export function NavLinks({ label, links }: Props) {
  const pathname = usePathname();
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-1">
        {links.map((link) => {
          const isCurrent = pathname === link.href;
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={isCurrent ? 'page' : undefined}
                className={`inline-flex min-h-11 items-center rounded-xl px-3 font-semibold underline-offset-4 hover:underline ${
                  isCurrent ? 'bg-ink text-paper' : 'text-ink'
                }`}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
