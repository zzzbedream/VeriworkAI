const DAYS = [
  { day: 'Mon', title: 'Weekly deposit', detail: '150 G$, you get it back Sunday', tone: 'verified' },
  { day: 'Tue', title: 'Claim + 1 task', detail: 'Your daily G$ and one short task', tone: 'plain' },
  { day: 'Wed', title: 'Claim + 1 task', detail: 'Build your streak', tone: 'plain' },
  { day: 'Thu', title: 'Claim + 1 task', detail: 'Unlock reviewer roles with good work', tone: 'plain' },
  { day: 'Fri', title: 'Five-day bonus', detail: '+400 G$ for a full streak', tone: 'earn' },
  { day: 'Sat', title: 'Peers close QA', detail: 'Every task checked by 3 people', tone: 'plain' },
  { day: 'Sun', title: 'Collect your week', detail: 'Earnings + deposit, one tap', tone: 'earn' },
] as const;

const toneClass: Record<(typeof DAYS)[number]['tone'], string> = {
  plain: '',
  verified: 'border-verified border-2',
  earn: 'border-earn border-2 bg-earn-soft',
};

export function WalletWeek() {
  return (
    <section aria-labelledby="week-title" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <h2 id="week-title" className="font-display text-4xl font-bold">
        Your week with VeriWork
      </h2>
      <p className="mt-3 max-w-2xl text-ink-soft">
        Days follow GoodDollar&apos;s daily reset at 12:00 UTC, so your task fits right next to your UBI claim.
      </p>
      <ol className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
        {DAYS.map((d) => (
          <li key={d.day} className={`card p-4 ${toneClass[d.tone]}`}>
            <p className="font-display text-2xl font-bold">{d.day}</p>
            <p className="mt-2 font-semibold">{d.title}</p>
            <p className="mt-1 text-sm text-ink-soft">{d.detail}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
