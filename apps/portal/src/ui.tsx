import type { ReactNode } from 'react';

/** The title block every section starts with. */
export function PageHead({ title, sub, children }: { title: string; sub: string; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, padding: '22px 24px 16px', flexWrap: 'wrap' }}>
      <div>
        <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.015em' }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3 }}>{sub}</div>
      </div>
      {children && <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>{children}</div>}
    </div>
  );
}

/** A section heading inside a page. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ padding: '6px 24px 28px' }}>
      <div className="eyebrow" style={{ padding: '10px 0 8px', borderBottom: '1px solid var(--line)' }}>{title}</div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div style={{ padding: '20px 0', fontSize: 12.5, color: 'var(--t3)' }}>{children}</div>;
}

/** A secret shown exactly once, with a way to copy it. */
export function OnceSecret({ value, note }: { value: string; note: string }) {
  return (
    <div>
      <div className="mono" style={{ padding: '10px 12px', fontSize: 12, lineHeight: 1.5, wordBreak: 'break-all', background: 'var(--raised)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', userSelect: 'all' }}>
        {value}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--warn)', marginTop: 8, lineHeight: 1.5 }}>{note}</div>
    </div>
  );
}

export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
