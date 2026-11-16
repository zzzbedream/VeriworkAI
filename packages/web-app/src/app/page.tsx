import Link from 'next/link';
import { Hero } from '@/components/landing/Hero';
import { ForSponsors, HowItWorks, Safety, SiteFooter } from '@/components/landing/Sections';
import { WalletWeek } from '@/components/landing/WalletWeek';

export default function HomePage() {
  return (
    // The landing copy is English-only for now; the app pages follow the chosen language.
    <div lang="en">
      <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 pt-6 sm:px-6">
        <Link href="/" className="flex items-center gap-3 font-display text-2xl font-bold">
          {/* eslint-disable-next-line @next/next/no-img-element -- static SVG brand mark */}
          <img src="/brand/logo.svg" alt="" width={40} height={40} />
          VeriWork AI
        </Link>
        <nav aria-label="Main">
          <Link
            href="/demo"
            className="lift inline-flex min-h-11 items-center rounded-xl bg-verified px-5 font-semibold text-paper"
          >
            Try it
          </Link>
        </nav>
      </header>
      <main>
        <Hero />
        <HowItWorks />
        <WalletWeek />
        <ForSponsors />
        <Safety />
      </main>
      <SiteFooter repoUrl={process.env.NEXT_PUBLIC_REPO_URL} />
    </div>
  );
}
