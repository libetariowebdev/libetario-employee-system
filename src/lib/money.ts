import Decimal from 'decimal.js';
const D = Decimal.clone({ precision: 40 });
export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN';
const modes = { HALF_UP: Decimal.ROUND_HALF_UP, HALF_EVEN: Decimal.ROUND_HALF_EVEN, DOWN: Decimal.ROUND_DOWN };
export function decimal(value: string): Decimal {
  if (typeof value !== 'string' || !/^-?\d{1,18}(\.\d{1,8})?$/.test(value)) throw new Error('Use an exact decimal string');
  return new D(value);
}
export function roundMoney(value: string | Decimal, mode: RoundingMode = 'HALF_UP'): string {
  return (typeof value === 'string' ? decimal(value) : value).toDecimalPlaces(2, modes[mode]).toFixed(2);
}
export function sumMoney(values: string[], mode: RoundingMode = 'HALF_UP') { return roundMoney(values.reduce((a, b) => a.plus(decimal(b)), new D(0)), mode); }
export function hourlyAmount(rate: string, seconds: number, mode: RoundingMode = 'HALF_UP') {
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error('Duration must be nonnegative integer seconds');
  return roundMoney(decimal(rate).times(String(seconds)).dividedBy('3600'), mode);
}
export function formatPHP(value: string) {
  const [whole, cents] = roundMoney(value).split('.');
  return `₱${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}
