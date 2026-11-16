export type ButtonVariant = 'primary' | 'secondary' | 'verified' | 'alert' | 'quiet';

const BASE =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary: 'lift bg-ink text-paper hover:bg-ink/90',
  secondary: 'border-2 border-ink bg-transparent hover:bg-paper-raised',
  verified: 'lift bg-verified text-paper hover:bg-verified/90',
  alert: 'bg-alert text-paper hover:bg-alert/90',
  quiet: 'text-ink underline-offset-4 hover:underline',
};

/** Tap targets are at least 44 px; focus rings come from the global `:focus-visible` style. */
export function buttonClass(variant: ButtonVariant, extra = ''): string {
  return [BASE, VARIANTS[variant], extra].filter((part) => part !== '').join(' ');
}

/** Index-card surface used for every panel of the app pages. */
export const CARD = 'card p-5 sm:p-6';

/** Small status pill (badges, step labels). */
export const PILL = 'inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold';

/** Text inputs and text areas. */
export const FIELD = 'w-full rounded-xl border border-ink/30 bg-paper px-3 py-2 text-ink';

/** One radio / checkbox choice with a 44 px tap target. */
export const CHOICE =
  'flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-rule bg-paper px-3 py-2 has-[:checked]:border-verified has-[:checked]:bg-verified-soft';

/** A short status line under an action (polite live region content). */
export const NOTICE = 'rounded-xl border-l-4 p-3 text-ink';
