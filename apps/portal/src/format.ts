/** Small presentation helpers. Amounts arrive as exact decimal strings and stay strings. */

export function shortAddress(address: string, head = 6, tail = 4): string {
  return address.length > head + tail + 1 ? address.slice(0, head) + '…' + address.slice(-tail) : address;
}

/** Trim trailing zeros for display only: "480.000000" -> "480.00". */
export function money(amount: string): string {
  const [whole, fraction = ''] = amount.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  const shown = trimmed.length < 2 ? trimmed.padEnd(2, '0') : trimmed;
  const negative = whole!.startsWith('-');
  const digits = negative ? whole!.slice(1) : whole!;
  const grouped = digits.replace(/[0-9](?=(?:[0-9]{3})+$)/g, (d) => d + ',');
  return (negative ? '-' : '') + grouped + '.' + shown;
}

export function age(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return seconds + 's';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ' + String(minutes % 60).padStart(2, '0') + 'm';
  return Math.floor(hours / 24) + 'd';
}

export function timestamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

export const STATE: Record<string, { label: string; color: string }> = {
  requested: { label: 'Awaiting approval', color: 'var(--warn)' },
  approved: { label: 'Approved', color: 'var(--info)' },
  signed: { label: 'Signed', color: 'var(--info)' },
  broadcast: { label: 'Sending', color: 'var(--info)' },
  completed: { label: 'Completed', color: 'var(--ok)' },
  rejected: { label: 'Rejected', color: 'var(--t3)' },
  failed: { label: 'Failed', color: 'var(--err)' },
};

/** Base units (6 decimals for both USDT and TRX) as a display amount. */
export function fromUnits(units: string): string {
  if (!/^-?[0-9]+$/.test(units)) return units;
  const negative = units.startsWith('-');
  const digits = (negative ? units.slice(1) : units).padStart(7, '0');
  return money((negative ? '-' : '') + digits.slice(0, -6) + '.' + digits.slice(-6));
}

/** Where a transaction can be looked at by anyone, on the network the console runs against. */
export function explorerUrl(network: string, txHash: string): string {
  const host = network === 'mainnet' ? 'tronscan.org' : network + '.tronscan.org';
  return 'https://' + host + '/#/transaction/' + encodeURIComponent(txHash);
}
