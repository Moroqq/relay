import { GlyphField } from './GlyphField.tsx';
import { Header, Hero } from './Hero.tsx';
import { Assets, Cta, Footer, Infrastructure, Integration, PaymentFlow, Trace } from './Sections.tsx';

export function App() {
  return (
    <div className="page">
      <div className="top">
        <Header />
        <Hero />
      </div>
      <GlyphField below=".top" />
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
