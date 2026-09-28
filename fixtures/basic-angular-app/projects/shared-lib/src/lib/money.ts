/**
 * Formats an amount of money for display.
 * @param amount - The amount, in the currency's major unit.
 * @returns The formatted amount.
 */
export function formatMoney(amount: number): string {
  return `$ ${amount.toFixed(2)}`;
}
