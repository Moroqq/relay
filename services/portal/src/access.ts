/**
 * Checking an application from the website's form.
 *
 * Everything is trimmed, bounded and required where the operator needs it to
 * decide. A filled-in honeypot field — invisible to people, irresistible to
 * form-filling bots — gets a polite success and is thrown away.
 */

import type { NewAccessRequest } from '@relay/db';

export const VOLUMES = ['under_10k', '10k_100k', '100k_1m', 'over_1m'] as const;

export type AccessCheck =
  | { readonly kind: 'ok'; readonly value: Omit<NewAccessRequest, 'ip' | 'userAgent'> }
  | { readonly kind: 'bot' }
  | { readonly kind: 'invalid'; readonly field: string; readonly message: string };

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function checkAccessRequest(body: Record<string, unknown> | null | undefined): AccessCheck {
  const b = body ?? {};
  if (text(b['fax']) !== '') return { kind: 'bot' };

  const company = text(b['company']);
  const website = text(b['website']);
  const contactName = text(b['contact_name']);
  const email = text(b['email']);
  const telegram = text(b['telegram']).replace(/^@/, '');
  const monthlyVolume = text(b['monthly_volume']);
  const useCase = text(b['use_case']);

  const bad = (field: string, message: string): AccessCheck => ({ kind: 'invalid', field, message });
  if (company.length < 2 || company.length > 120) return bad('company', 'Enter your company or project name');
  if (website.length > 200 || (website !== '' && !/^(https?:\/\/)?[^\s/$.?#]+\.[^\s]+$/i.test(website))) {
    return bad('website', 'Enter a web address, like example.com');
  }
  if (contactName.length < 2 || contactName.length > 120) return bad('contact_name', 'Enter your name');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('email', 'Enter a valid email address');
  if (telegram.length > 64 || (telegram !== '' && !/^[A-Za-z0-9_]{3,64}$/.test(telegram))) return bad('telegram', 'Enter a Telegram username');
  if (!(VOLUMES as readonly string[]).includes(monthlyVolume)) return bad('monthly_volume', 'Choose your expected monthly volume');
  if (useCase.length < 10 || useCase.length > 2000) return bad('use_case', 'Tell us in a sentence or two what you will use Relay for');

  return {
    kind: 'ok',
    value: {
      company,
      website: website === '' ? null : website,
      contactName,
      email,
      telegram: telegram === '' ? null : telegram,
      monthlyVolume,
      useCase,
    },
  };
}
