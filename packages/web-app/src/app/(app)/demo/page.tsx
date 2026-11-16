import { CELO_CHAIN_ID } from '@veriwork/shared/chain';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ClaimCard } from '@/components/claim/ClaimCard';
import { AddCeloPanel } from '@/components/demo/AddCeloPanel';
import { ContractList } from '@/components/demo/ContractList';
import { DemoStep } from '@/components/demo/DemoStep';
import { IdentityStep } from '@/components/demo/IdentityStep';
import { SignInPanel } from '@/components/session/SignInPanel';
import { buttonClass } from '@/components/ui/styles';
import { getDictionary } from '@/i18n/dictionaries';
import { interpolate } from '@/i18n/interpolate';
import { getRequestLocale } from '@/i18n/server';
import { getPublicConfig } from '@/lib/config/public-env';
import { getDemoLiveStatus } from '@/server/demo/live-status';
import { defaultDeps } from '@/server/deps';

export async function generateMetadata(): Promise<Metadata> {
  const t = getDictionary(await getRequestLocale());
  return { title: t.meta.demoTitle, description: t.meta.demoDescription };
}

function StepLink({ href, label }: { readonly href: string; readonly label: string }) {
  return (
    <Link href={href} className={buttonClass('verified')}>
      {label}
    </Link>
  );
}

function Waiting({ text }: { readonly text: string }) {
  return <p className="text-sm font-semibold text-ink-soft">{text}</p>;
}

/**
 * Judge guide. A step is marked live only when it works end to end on this deployment: tasks,
 * reviews and QA once a funded batch is published, the deposit when VeriWorkCore is on Celo
 * mainnet, and collecting once a week was settled on-chain.
 */
export default async function DemoPage() {
  const t = getDictionary(await getRequestLocale());
  const config = getPublicConfig();
  const status = await getDemoLiveStatus(defaultDeps.db);
  const depositLive = config.contracts.core !== null && config.chainId === CELO_CHAIN_ID;
  const badge = (isLive: boolean) => ({ isLive, badge: isLive ? t.common.live : t.common.coming }) as const;
  const step = (n: number) => interpolate(t.demo.stepLabel, { n });
  return (
    <div className="mx-auto grid max-w-4xl gap-10 px-4 py-10 sm:px-6">
      <header>
        <h1 className="font-display text-4xl leading-tight font-bold sm:text-5xl">{t.demo.title}</h1>
        <p className="mt-3 max-w-3xl text-lg text-ink-soft">{t.demo.intro}</p>
      </header>

      <ol aria-label={t.demo.stepsLabel} className="grid gap-5">
        <DemoStep number={1} stepLabel={step(1)} title={t.demo.addCelo.title} body={t.demo.addCelo.body} {...badge(true)}>
          <AddCeloPanel />
        </DemoStep>
        <DemoStep number={2} stepLabel={step(2)} title={t.demo.connect.title} body={t.demo.connect.body} {...badge(true)}>
          <SignInPanel />
        </DemoStep>
        <DemoStep number={3} stepLabel={step(3)} title={t.demo.trial.title} body={t.demo.trial.body} {...badge(status.openBatch)}>
          {status.openBatch ? <StepLink href="/work" label={t.demo.trial.link} /> : <Waiting text={t.demo.trial.waiting} />}
        </DemoStep>
        <DemoStep number={4} stepLabel={step(4)} title={t.demo.verify.title} body={t.demo.verify.body} {...badge(true)}>
          <IdentityStep />
        </DemoStep>
        <DemoStep number={5} stepLabel={step(5)} title={t.demo.claim.title} body={t.demo.claim.body} {...badge(true)}>
          <ClaimCard />
        </DemoStep>
        <DemoStep number={6} stepLabel={step(6)} title={t.demo.deposit.title} body={t.demo.deposit.body} {...badge(depositLive)}>
          {depositLive ? <StepLink href="/week" label={t.demo.deposit.link} /> : undefined}
        </DemoStep>
        <DemoStep number={7} stepLabel={step(7)} title={t.demo.review.title} body={t.demo.review.body} {...badge(status.openBatch)}>
          {status.openBatch ? (
            <div className="flex flex-wrap gap-3">
              <StepLink href="/review" label={t.demo.review.reviewLink} />
              <StepLink href="/qa" label={t.demo.review.qaLink} />
            </div>
          ) : (
            <Waiting text={t.demo.review.waiting} />
          )}
        </DemoStep>
        <DemoStep number={8} stepLabel={step(8)} title={t.demo.collect.title} body={t.demo.collect.body} {...badge(status.settledWeek)}>
          {status.settledWeek ? <StepLink href="/week" label={t.demo.collect.link} /> : <Waiting text={t.demo.collect.waiting} />}
        </DemoStep>
      </ol>

      <section aria-labelledby="timing-title" className="card border-2 border-earn p-5 sm:p-6">
        <h2 id="timing-title" className="font-display text-2xl font-bold">
          {t.demo.timingTitle}
        </h2>
        <ul className="mt-4 grid gap-3">
          {[t.demo.timing.settlement, t.demo.timing.collectDelay, t.demo.timing.dailyReset, t.demo.timing.verificationWindow].map(
            (line) => (
              <li key={line} className="flex gap-3">
                <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-earn" />
                {line}
              </li>
            ),
          )}
        </ul>
      </section>

      <section aria-labelledby="video-title">
        <h2 id="video-title" className="font-display text-2xl font-bold">
          {t.demo.videoTitle}
        </h2>
        {config.demoVideoUrl !== null ? (
          <a
            className="mt-2 inline-block font-semibold text-verified underline underline-offset-4"
            href={config.demoVideoUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t.demo.videoLink} <span className="sr-only">{t.common.newTab}</span>
          </a>
        ) : (
          <p className="mt-2 text-ink-soft">{t.demo.videoPending}</p>
        )}
      </section>

      <section aria-labelledby="contracts-title">
        <h2 id="contracts-title" className="font-display text-2xl font-bold">
          {t.demo.contractsTitle}
        </h2>
        <p className="mt-1 mb-4 text-ink-soft">{t.demo.contractsIntro}</p>
        <ContractList
          t={t}
          chainId={config.chainId}
          core={config.contracts.core}
          agentRegistry={config.contracts.agentRegistry}
        />
      </section>
    </div>
  );
}
