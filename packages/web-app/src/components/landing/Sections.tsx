const STEPS = [
  { n: '01', title: 'An AI drafts', body: 'Every item starts as an AI draft from an agent that posted a G$ bond.' },
  { n: '02', title: 'A verified human fixes it', body: 'You correct translations, labels or answers. Two free tasks before you verify.' },
  { n: '03', title: 'Peers review', body: 'A reviewer scores it and three QA reviewers reach a 2-of-3 consensus.' },
  { n: '04', title: 'Collect weekly', body: 'Accepted work settles on Celo every week. One transaction, all your earnings.' },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <h2 id="how-title" className="font-display text-4xl font-bold">
        How it works
      </h2>
      <ol className="mt-8 grid gap-5 md:grid-cols-4">
        {STEPS.map((s) => (
          <li key={s.n} className="card lift p-6">
            <p className="font-display text-3xl font-bold text-verified">{s.n}</p>
            <h3 className="mt-3 text-lg font-bold">{s.title}</h3>
            <p className="mt-2 text-ink-soft">{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ForSponsors() {
  return (
    <section id="sponsors" aria-labelledby="sponsors-title" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <div className="card grid gap-8 p-8 md:grid-cols-2 md:p-12">
        <div>
          <h2 id="sponsors-title" className="font-display text-4xl font-bold">
            For AI teams and sponsors
          </h2>
          <p className="mt-4 text-ink-soft">
            Fund a labeling or RLHF campaign in G$ and get data checked by people who are each verified as one real
            human. Pay only for work that passed review and a three-person QA consensus.
          </p>
        </div>
        <ul className="grid gap-3 self-center">
          <li className="rounded-xl bg-verified-soft p-4 font-semibold">One verified human per seat, checked on-chain</li>
          <li className="rounded-xl bg-earn-soft p-4 font-semibold">20% of every fee goes to the GoodDollar UBI pool</li>
          <li className="rounded-xl border border-rule p-4 font-semibold">Export the accepted dataset when it is done</li>
        </ul>
      </div>
    </section>
  );
}

const SAFETY = [
  'Identity is checked at every payout, not just at sign-up.',
  'A rolling 24-hour circuit breaker limits how much can ever leave the contracts.',
  'An automated guardian can pause instantly; only a 2-of-2 Safe can resume.',
  'Open source, with fuzz, invariant and Celo-mainnet-fork tests.',
] as const;

export function Safety() {
  return (
    <section aria-labelledby="safety-title" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <h2 id="safety-title" className="font-display text-4xl font-bold">
        Built to be safe
      </h2>
      <ul className="mt-8 grid gap-4 md:grid-cols-2">
        {SAFETY.map((line) => (
          <li key={line} className="flex gap-3 text-lg">
            <span aria-hidden className="mt-1 font-bold text-verified">
              ✓
            </span>
            {line}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SiteFooter({ repoUrl }: { repoUrl: string | undefined }) {
  return (
    <footer className="mx-auto max-w-6xl border-t border-rule px-4 py-10 text-sm text-ink-soft sm:px-6">
      <p>
        VeriWork AI · built on Celo for GoodBuilders Season 5 · by Lucas Cifuentes (CEO) and Christian Perez de Arce (CTO)
      </p>
      {repoUrl ? (
        <p className="mt-2">
          <a className="font-semibold text-ink underline underline-offset-4" href={repoUrl}>
            Source code (MIT)
          </a>
        </p>
      ) : null}
    </footer>
  );
}
