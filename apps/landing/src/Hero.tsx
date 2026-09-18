import { useState } from 'react';

import { ACTIVITY, DEFAULT_AMOUNT, LINKS, NAV, PARTNERS, PRESETS, PRICING } from './content.ts';
import { PartnerIcons, StatIcons } from './icons.tsx';
import { RelayField } from './RelayField.tsx';

const usd = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function Header() {
  return (
    <header className="header">
      <a href="/" aria-label="Relay home"><img className="mark" src="/assets/relay-mark.webp" alt="Relay" width={45} height={30} /></a>
      <nav aria-label="Main">
        {NAV.map((item) => <a key={item.href} href={item.href}>{item.label}</a>)}
      </nav>
      <div className="right">
        <a className="login" href={LINKS.login}>Log in</a>
        <a className="btn btn-sm" href={LINKS.apply}>Get API access</a>
      </div>
    </header>
  );
}

/** What a payment of the chosen size costs through Relay, and what cards would have taken. */
function Calculator() {
  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  const relayFee = amount * PRICING.relayRate + PRICING.relayFlat;
  const cardFee = amount * PRICING.cardRate + PRICING.cardFlat;
  const stats = [
    { icon: StatIcons.settled, value: usd(amount - relayFee), label: 'Settled to your balance' },
    { icon: StatIcons.cost, value: usd(relayFee), label: 'Total cost, network fee included' },
    { icon: StatIcons.kept, value: '+' + usd(cardFee - relayFee), label: 'Kept vs. card processing' },
    { icon: StatIcons.finality, value: '~3 sec', label: 'Finality, at any amount' },
  ];

  return (
    <>
      <div className="calc">
        <span className="calc-label" id="calc-label">On a payment of USDT</span>
        <div className="pills" role="group" aria-labelledby="calc-label">
          {PRESETS.map((v) => (
            <button key={v} type="button" className="pill" aria-pressed={v === amount} onClick={() => setAmount(v)}>
              {v >= 1000 ? v / 1000 + 'k' : v}
            </button>
          ))}
        </div>
      </div>
      <div className="stats" aria-live="polite">
        {stats.map((s) => (
          <div className="stat" key={s.label}>
            <div className="icon">{s.icon()}</div>
            <div className="value">{s.value}</div>
            <div className="label">{s.label}</div>
          </div>
        ))}
      </div>
    </>
  );
}

export function Hero() {
  return (
    <section className="hero">
      <RelayField />

      <div className="hero-content">
        <div className="status">
          <span className="dot" />
          <b>TRON MAINNET</b>
          <span>Operational</span>
        </div>

        <div className="intro">
          <div className="eyebrow">PAYMENT INFRASTRUCTURE</div>
          <h1>Built to move<br />value on TRON</h1>
          <p>
            {/* The spaces before each break keep the words apart where narrow screens hide the breaks. */}
            Relay is a payment infrastructure for internet businesses. <br />
            We handle crypto payments, confirmations, and notifications <br />
            so you can focus on your product.
          </p>
          <div className="actions">
            <a className="btn" href={LINKS.apply}>Get API access</a>
            <a className="doc-link" href="#developers">Read documentation <span>→</span></a>
          </div>
        </div>

        <Calculator />

        <div className="trusted">Trusted by internet businesses worldwide</div>
        <div className="partners">
          {PARTNERS.map((name) => (
            <div className="partner" key={name}>
              {PartnerIcons[name]?.()}
              <span>{name}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="live">
        <div className="title">LIVE ACTIVITY</div>
        <ul>
          {ACTIVITY.map((a) => (
            <li key={a.label}>
              <span className={`dot bg-${a.tone}`} />
              <span className="label">{a.label}</span>
              <span className="value">{a.value}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="scroll-hint" aria-hidden="true">
        <div className="label">SCROLL TO EXPLORE</div>
        <div className="chev"><div>⌄</div><div>⌄</div></div>
      </div>
    </section>
  );
}
