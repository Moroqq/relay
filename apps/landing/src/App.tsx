import { AsciiField } from './AsciiField.tsx';
import { Header, Hero } from './Hero.tsx';
import { Assets, Cta, Footer, Infrastructure, Integration, PaymentFlow, Trace } from './Sections.tsx';

export function App() {
  return (
    <div className="page">
      <div className="top">
        <AsciiField />
        <Header />
        <Hero />
      </div>
      <main>
        <PaymentFlow />
        <Trace />
        <Assets />
        <Infrastructure />
        <Integration />
        <Cta />
      </main>
      <Footer />
    </div>
  );
}
