/* global React */

function Header({ onContact }) {
  const [scrolled, setScrolled] = React.useState(false);
  React.useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, []);
  return (
    <header className={`gfc-header ${scrolled ? "scrolled" : ""}`}>
      <div className="gfc-container gfc-header-inner">
        <a href="#top" className="gfc-brand">
          <img src="../../assets/logo-full-color-transparent.png" alt="Godwins Family Care" />
        </a>
        <nav className="gfc-nav">
          <a href="#services">Services</a>
          <a href="#continuous">Continuous Care</a>
          <a href="#process">How it works</a>
          <a href="#about">About</a>
          <a href="#testimonials">Stories</a>
        </nav>
        <div className="gfc-header-cta">
          <a href="tel:4049136705" className="gfc-tel">(404) 913-6705</a>
          <Button variant="navy" size="sm" onClick={onContact}>Free consultation</Button>
        </div>
      </div>
    </header>
  );
}

function Hero({ onContact }) {
  return (
    <section className="gfc-hero on-navy" id="top">
      <div className="gfc-hero-grid gfc-container">
        <div className="gfc-hero-copy">
          <Eyebrow light>Physician &amp; FNP-Owned</Eyebrow>
          <h1 className="gfc-display">Compassionate care.<br/><span className="italic">Clinician-backed.</span><br/>Trusted evaluations.</h1>
          <p className="gfc-lead">Personal home care and independent medical exams for families across North Atlanta &amp; Cobb County. We notice what others miss — because we're trained to.</p>
          <div className="gfc-hero-actions">
            <Button variant="gold" size="lg" onClick={onContact}>Schedule free consultation</Button>
            <Button variant="ghost-light" size="lg" href="tel:4049136705">
              <span className="gfc-tel-icon">↳</span> (404) 913-6705
            </Button>
          </div>
          <div className="gfc-hero-trust">
            <span>Founded 2024</span>
            <span className="dot" />
            <span>Georgia PHCP licensed</span>
            <span className="dot" />
            <span>Same caregiver, every visit</span>
          </div>
        </div>
        <div className="gfc-hero-visual">
          <div className="gfc-photo gfc-photo-couple" />
          <div className="gfc-hero-card">
            <div className="gfc-hero-card-num">15<span>min</span></div>
            <div>
              <strong>Free introduction</strong>
              <p>No pressure, no commitment. Just a conversation about your loved one.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ValueStrip() {
  const items = [
    { t: "Clinical Oversight", b: "We catch mood, cognitive and health changes early — before emergencies." },
    { t: "Caregiver Continuity", b: "Same caregiver every visit. Critical for cognitive decline." },
    { t: "Around-the-Clock", b: "24/7 availability — nights, weekends and holidays." },
    { t: "Full Care Coordination", b: "Direct contact with your loved one's entire care team." },
  ];
  return (
    <section className="gfc-strip" id="about">
      <div className="gfc-container">
        <div className="gfc-strip-grid">
          {items.map((it, i) => (
            <div key={i} className="gfc-strip-item">
              <span className="gfc-strip-num">0{i+1}</span>
              <h4>{it.t}</h4>
              <p>{it.b}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

Object.assign(window, { Header, Hero, ValueStrip });
