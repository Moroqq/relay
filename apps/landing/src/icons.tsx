import type { ReactNode } from 'react';

/** 20px line icons, drawn in currentColor, as in the design file. */
function Icon({ paths, children }: { paths: string[]; children?: ReactNode }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths.map((d) => <path key={d} d={d} />)}
      {children}
    </svg>
  );
}

export const StatIcons = {
  settled: () => (
    <Icon paths={['M12 3v18', 'M15.5 8.5a3.5 3.5 0 0 0-3.5-2.5c-2 0-3.5 1-3.5 2.8 0 1.7 1.4 2.4 3.5 2.9 2.3.5 3.7 1.2 3.7 3 0 1.9-1.7 2.9-3.7 2.9a3.9 3.9 0 0 1-3.8-2.6']}>
      <circle cx="12" cy="12" r="9.2" />
    </Icon>
  ),
  cost: () => <Icon paths={['M2.5 7.5h19v10a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5v-10Z', 'M2.5 10.5h19', 'M5.5 15.5h4']} />,
  kept: () => <Icon paths={['M3 17l5.5-6 4 3.5L21 6', 'M21 6h-4.5', 'M21 6v4.5']} />,
  finality: () => (
    <Icon paths={['M12 7.5V12l3 2']}>
      <circle cx="12" cy="12" r="9" />
    </Icon>
  ),
};

export const PartnerIcons: Record<string, () => ReactNode> = {
  'Forum A': () => <Icon paths={['M4 5h16v11H9l-5 3V5Z', 'M8 9h8', 'M8 12h5']} />,
  'Marketplace B': () => <Icon paths={['M4 8l8-4 8 4-8 4-8-4Z', 'M4 8v8l8 4 8-4V8']} />,
  'Gaming Corp': () => <Icon paths={['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z', 'M12 8.5l3.5 2v3L12 15.5 8.5 13.5v-3L12 8.5Z']} />,
  'Digital Store': () => <Icon paths={['M4 4h16v16H4z', 'M9 12h6', 'M12 9v6']} />,
  'Community Hub': () => <Icon paths={['M4 5h16v9l-8 6-8-6V5Z', 'M9 9h6']} />,
};
