import { ASSETS, FLOW, INFRA, LINKS, SNIPPET, TRACE } from './content.ts';

export function PaymentFlow() {
  return (
    <section className="section-flow" id="product">
      <div className="wrap">
        <div className="eyebrow">PAYMENT FLOW</div>
        <h2 className="h2">What you saw moving is the actual path of a payment.</h2>
        <div className="chain" style={{ marginTop: 56 }}>
          <ol className="chain-inner" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {FLOW.map((f, i) => (
              <li className="cn" key={i}>
                <div className="flow-node">
                  <div className="step">{f.step}</div>
                  <div className="label">{f.label}</div>
                  <div className="meta">{f.meta}</div>
                </div>
                {i < FLOW.length - 1 && <div className="conn" />}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

export function Trace() {
  return (
    <section className="section">
      <div className="wrap split">
        <div className="text-42">
          <div className="eyebrow">PAYMENT TRACE</div>
          <h2 className="h2">See exactly where a payment stopped.</h2>
          <p className="lead" style={{ maxWidth: 440 }}>
            Every payment carries a full trace from the first API request to the final callback. When something breaks, your support team knows which side owns the problem in seconds.
          </p>
        </div>
        <div className="panel trace">
          {TRACE.map((t) => (
            <div className="trace-row" key={t.step}>
              <span className={`dot ${t.ok ? 'bg-ok' : 'bg-err'}`} />
              <span className="step">{t.step}</span>
              <span className="value">{t.value}</span>
              <span className={`mark ${t.ok ? 'tone-ok' : 'tone-err'}`}>{t.ok ? '✓' : '✕'}</span>
              <span className="time">{t.time}</span>
            </div>
          ))}
          <div className="trace-note">Blocked at callback delivery. TRON, amount and confirmations are correct — the receiving endpoint returned HTTP 502.</div>
        </div>
      </div>
    </section>
  );
}

export function Assets() {
  return (
    <section className="section">
      <div className="wrap">
        <div className="eyebrow">SUPPORTED ASSETS</div>
        <div className="assets">
          {ASSETS.map((a) => (
            <div className="asset" key={a.name}>
              <div className="name">{a.name}</div>
              <div className="sub">{a.sub}</div>
              <div className="note">{a.note}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Infrastructure() {
  return (
    <section className="section section-infra" id="infrastructure">
      <div className="wrap">
        <div className="eyebrow">INFRASTRUCTURE</div>
        <h2 className="h2">Every component reports its own state.</h2>
        <div className="chain">
          <div className="chain-inner">
            {INFRA.map((n, i) => (
              <div className="cn" key={n.label}>
                <div className="infra-node">
                  <div className="step">{n.label}</div>
                  <div className={`state tone-${n.tone}`}><span className={`dot bg-${n.tone}`} />{n.status}</div>
                  <div className="metric">{n.metric}</div>
                </div>
                {i < INFRA.length - 1 && <div className="conn" />}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function Integration() {
  return (
    <section className="section" id="developers">
      <div className="wrap split">
        <div className="text-40">
          <div className="eyebrow">INTEGRATION</div>
          <h2 className="h2">One request creates a payment.</h2>
          <p className="lead" style={{ maxWidth: 400 }}>
            Relay assigns an address, watches TRON for the inbound transfer, counts confirmations and calls your endpoint with the result.
          </p>
        </div>
        <div className="panel code">
          <div className="code-head">
            <span className="verb">POST</span><span>/v1/payments</span><span className="result">201 · 84 ms</span>
          </div>
          <pre>{SNIPPET}</pre>
        </div>
      </div>
    </section>
  );
}

export function Cta() {
  return (
    <section className="cta" id="api">
      <div className="wrap">
        <img className="mark" src="/assets/relay-mark.webp" alt="" width={96} height={64} loading="lazy" />
        <h2 className="h2">Connect your platform to Relay.</h2>
        <a className="btn" href={LINKS.apply}>Start integration</a>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="footer" id="company">
      <div className="wrap">
        <img className="lockup" src="/assets/relay-lockup.webp" alt="Relay — Payment Infrastructure" width={78} height={26} loading="lazy" />
        <div className="ok" id="status"><span className="dot" />All systems operational</div>
      </div>
    </footer>
  );
}
