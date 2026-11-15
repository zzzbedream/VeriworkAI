const DRAFT_STEPS = [
  { label: '1 · AI draft', body: '"Hola mundo" → "Hello world"', tone: 'plain' },
  { label: '2 · You fix it', body: 'Reviewed by peers · QA 2-of-3', tone: 'verified' },
  { label: '3 · Sunday', body: 'Collect your week in G$', tone: 'earn' },
] as const;

const toneClass: Record<(typeof DRAFT_STEPS)[number]['tone'], string> = {
  plain: 'border-rule',
  verified: 'border-verified',
  earn: 'border-earn bg-earn-soft',
};

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="mx-auto grid max-w-6xl gap-12 px-4 pt-10 pb-16 sm:px-6 md:grid-cols-[1.15fr_1fr] md:pt-20">
      <div>
        <p className="mb-5 inline-flex items-center gap-2 rounded-full bg-verified-soft px-3 py-1 text-sm font-semibold text-verified">
          <span aria-hidden className="size-2 rounded-full bg-verified" />
          GoodBuilders Season 5 · launching on Celo
        </p>
        <h1 id="hero-title" className="font-display text-5xl leading-[1.02] font-bold tracking-tight sm:text-7xl">
          Help train AI.
          <br />
          <span className="text-verified">Get paid in G$.</span>
        </h1>
        <p className="mt-6 max-w-xl text-lg text-ink-soft">
          AI teams need feedback from real people, not bots. VeriWork gives that work to GoodDollar-verified humans: you
          correct what the AI drafted, peers check it, and every Sunday you collect your earnings.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a href="#how-it-works" className="lift rounded-xl bg-ink px-6 py-3.5 font-semibold text-paper">
            See how it works
          </a>
          <a href="#sponsors" className="lift rounded-xl border-2 border-ink px-6 py-3 font-semibold">
            Fund a campaign
          </a>
        </div>
        <p className="mt-4 text-sm text-ink-soft">Two free tasks before you verify. No gas talk, no jargon.</p>
      </div>
      <ol aria-label="One piece of work, step by step" className="relative flex flex-col gap-5 self-center">
        {DRAFT_STEPS.map((step, i) => (
          <li
            key={step.label}
            className={`card border-2 p-5 ${toneClass[step.tone]}`}
            style={{ transform: `rotate(${[-2, 1.5, -1][i]}deg)` }}
          >
            <p className="text-sm font-semibold text-ink-soft">{step.label}</p>
            <p className="mt-1 text-lg font-semibold">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
