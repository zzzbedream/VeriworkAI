import type { Metadata, Viewport } from 'next';
import { Fraunces, Manrope } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', display: 'swap' });
const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });

const siteUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'VeriWork AI — verified humans make AI better',
  description:
    'Paid AI-training micro-work for GoodDollar-verified humans. Correct AI drafts, get reviewed by peers, collect your G$ every week on Celo.',
  icons: { icon: '/brand/logo.svg', apple: '/brand/logo-1x1.png' },
  openGraph: {
    title: 'VeriWork AI',
    description: 'Verified humans make AI better. Paid weekly in G$ on Celo.',
    images: [{ url: '/brand/banner-3x1.png', width: 1500, height: 500 }],
    type: 'website',
  },
  twitter: { card: 'summary_large_image', images: ['/brand/banner-3x1.png'] },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f1e8' },
    { media: '(prefers-color-scheme: dark)', color: '#14130f' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${manrope.variable}`}>
      <body className="min-h-dvh text-ink">{children}</body>
    </html>
  );
}
