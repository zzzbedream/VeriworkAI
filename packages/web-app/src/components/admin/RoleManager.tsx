'use client';

import { useMutation } from '@tanstack/react-query';
import { shortAddress } from '@veriwork/shared/format';
import { useId, useState, type FormEvent } from 'react';
import { isAddress, type Address } from 'viem';
import type { Dictionary } from '@/i18n/dictionaries';
import { useI18n } from '@/i18n/I18nProvider';
import { interpolate } from '@/i18n/interpolate';
import { changeAdminRole, fetchAdminRoles } from '@/lib/api/account-client';
import type { AdminGrantableRole } from '@/lib/api/admin-schemas';
import { apiErrorCode } from '@/lib/api/http';
import { buttonClass, CARD, CHOICE, FIELD } from '../ui/styles';

type Outcome =
  | { readonly kind: 'roles'; readonly address: string; readonly known: boolean; readonly roles: readonly string[] }
  | { readonly kind: 'changed'; readonly address: string; readonly role: AdminGrantableRole; readonly granted: boolean; readonly changed: boolean }
  | { readonly kind: 'error'; readonly message: string };

const ROLES: readonly AdminGrantableRole[] = ['REVIEWER', 'QA'];

function roleName(role: string, t: Dictionary): string {
  if (role === 'REVIEWER') return t.admin.roles.reviewer;
  return role === 'QA' ? t.admin.roles.qa : role;
}

function outcomeText(outcome: Outcome, t: Dictionary): string {
  if (outcome.kind === 'error') return outcome.message;
  const address = shortAddress(outcome.address);
  if (outcome.kind === 'roles') {
    if (!outcome.known) return interpolate(t.admin.roles.unknown, { address });
    const roles = outcome.roles.map((role) => roleName(role, t)).join(', ');
    return interpolate(t.admin.roles.current, { address, roles: roles === '' ? t.admin.roles.none : roles });
  }
  if (!outcome.changed) return interpolate(t.admin.roles.unchanged, { address });
  const template = outcome.granted ? t.admin.roles.granted : t.admin.roles.revoked;
  return interpolate(template, { role: roleName(outcome.role, t), address });
}

function errorMessage(error: unknown, t: Dictionary): string {
  const code = apiErrorCode(error);
  if (code === 'NOT_ELIGIBLE') return t.admin.roles.notInRecords;
  if (code === 'RATE_LIMITED') return t.errors.rateLimited;
  return t.admin.roles.failed;
}

/** Grant or revoke REVIEWER / QA by wallet address (bootstrap of the review pipeline). */
export function RoleManager() {
  const { t } = useI18n();
  const addressId = useId();
  const roleGroup = useId();
  const [address, setAddress] = useState('');
  const [role, setRole] = useState<AdminGrantableRole>('REVIEWER');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const valid = isAddress(address.trim(), { strict: false });
  const lookup = useMutation({ mutationFn: (wallet: string) => fetchAdminRoles(wallet) });
  const change = useMutation({ mutationFn: changeAdminRole });
  const busy = lookup.isPending || change.isPending;

  function onLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    lookup.mutate(address.trim(), {
      onSuccess: (data) => setOutcome({ kind: 'roles', address: data.address, known: data.known, roles: data.roles }),
      onError: (error) => setOutcome({ kind: 'error', message: errorMessage(error, t) }),
    });
  }

  function onChange(granted: boolean) {
    if (!valid) return;
    change.mutate(
      { address: address.trim() as Address, role, granted },
      {
        onSuccess: (data) => setOutcome({ kind: 'changed', address: data.address, role, granted, changed: data.changed }),
        onError: (error) =>
          setOutcome({
            kind: 'error',
            message: apiErrorCode(error) === 'NOT_FOUND' ? interpolate(t.admin.roles.unknown, { address: address.trim() }) : errorMessage(error, t),
          }),
      },
    );
  }

  return (
    <section className={CARD} aria-labelledby="roles-title">
      <h2 id="roles-title" className="font-display text-2xl font-bold">
        {t.admin.roles.title}
      </h2>
      <p className="mt-1 text-ink-soft">{t.admin.roles.intro}</p>
      <form onSubmit={onLookup} className="mt-4 grid gap-4" noValidate>
        <div className="grid gap-1">
          <label htmlFor={addressId} className="font-semibold">
            {t.admin.roles.address}
          </label>
          <input
            id={addressId}
            className={`${FIELD} font-mono`}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="0x…"
            aria-invalid={address !== '' && !valid}
          />
          {address !== '' && !valid ? <p className="text-sm font-semibold text-alert">{t.admin.roles.invalidAddress}</p> : null}
        </div>
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="mb-2 font-semibold">{t.admin.roles.role}</legend>
          {ROLES.map((option) => (
            <label key={option} className={CHOICE}>
              <input
                type="radio"
                name={roleGroup}
                checked={role === option}
                onChange={() => setRole(option)}
                className="size-5 accent-verified"
              />
              <span>{roleName(option, t)}</span>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass('verified')} disabled={!valid || busy} onClick={() => onChange(true)}>
            {t.admin.roles.grant}
          </button>
          <button type="button" className={buttonClass('alert')} disabled={!valid || busy} onClick={() => onChange(false)}>
            {t.admin.roles.revoke}
          </button>
          <button type="submit" className={buttonClass('secondary')} disabled={!valid || busy}>
            {t.admin.roles.lookup}
          </button>
        </div>
      </form>
      <div aria-live="polite" className="mt-3">
        {outcome !== null ? (
          <p role={outcome.kind === 'error' ? 'alert' : undefined} className={outcome.kind === 'error' ? 'font-semibold text-alert' : 'font-semibold'}>
            {outcomeText(outcome, t)}
          </p>
        ) : null}
      </div>
    </section>
  );
}
