import { formatGDollar } from '@veriwork/shared';

export type MessageLocale = 'en' | 'es';

export function messageLocale(locale: string): MessageLocale {
  return locale.toLowerCase().startsWith('es') ? 'es' : 'en';
}

function utc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function ubiResetMessage(locale: MessageLocale, appUrl: string): string {
  return locale === 'es'
    ? `Tu UBI de GoodDollar de hoy ya está disponible. Recíbelo y completa tu tarea del día: ${appUrl}`
    : `Today's GoodDollar UBI is ready. Claim it and finish today's task: ${appUrl}`;
}

export function goodIdExpiryMessage(
  locale: MessageLocale,
  expiresAt: Date,
  appUrl: string,
): string {
  return locale === 'es'
    ? `Tu verificación GoodID vence el ${utc(expiresAt)}. Renuévala para seguir cobrando: ${appUrl}/verify`
    : `Your GoodID verification expires on ${utc(expiresAt)}. Renew it to keep getting paid: ${appUrl}/verify`;
}

export function fridayBonusMessage(locale: MessageLocale, appUrl: string): string {
  return locale === 'es'
    ? `¡Último día! Reclama tu UBI y completa una tarea hoy para ganar el bono de 400 G$ de la semana: ${appUrl}`
    : `Last day! Claim your UBI and finish one task today to earn this week's 400 G$ bonus: ${appUrl}`;
}

export function claimReadyMessage(
  locale: MessageLocale,
  amountWei: bigint,
  appUrl: string,
): string {
  const amount = formatGDollar(amountWei);
  return locale === 'es'
    ? `Tus ganancias de la semana (${amount}) ya se pueden cobrar: ${appUrl}`
    : `This week's earnings (${amount}) are ready to claim: ${appUrl}`;
}
