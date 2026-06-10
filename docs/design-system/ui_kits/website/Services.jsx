/* global React */

function ServiceTiers({ onContact }) {
  const tiers = [
    {
      tier: "Tier 01 · Essential",
      name: "Essential ADL Support",
      desc: "Bathing, dressing, grooming, toileting, mobility, and personal hygiene assistance.",
      price: "$26–$31",
      min: "2-hour minimum visits",
      featured: false,
    },
    {
      tier: "Tier 02 · Comprehensive",
      name: "Comprehensive Home Care",
      desc: "Everything in Essential, plus meal prep, medication reminders, transportation, light housekeeping and companionship.",
      price: "$30–$36",
      min: "3-hour minimum visits",
      featured: false,
    },
    {
      tier: "Tier 03 · Specialty",
      name: "Behavioral & Cognitive Wellness",
      desc: "Specialized dementia and Alzheimer's care, behavioral observation, crisis de-escalation, safety planning and full coordination.",
      price: "$36–$42",
      min: "4-hour minimum visits",
      featured: true,
    },
  ];
  return (
    <section className="gfc-section" id="services">
      <div className="gfc-container">
        <div className="gfc-section-head">
          <Eyebrow>Our Services</Eyebrow>
          <h2>Three levels of care, one standard of attention.</h2>
          <p className="gfc-lead">Every tier includes the same caregiver every visit, clinical oversight by our physician and FNP, and direct coordination with your loved one's medical team.</p>
        </div>
        <div className="gfc-tier-grid">
          {tiers.map((t, i) => (
            <article key={i} className={`gfc-tier-card ${t.featured ? "featured" : ""}`}>
              {t.featured && <span className="gfc-tier-pin">Our Specialty</span>}
              <span className="gfc-rule" />
              <span className="gfc-tier-label">{t.tier}</span>
              <h3>{t.name}</h3>
              <p>{t.desc}</p>
              <div className="gfc-tier-meta">
                <span><strong>{t.min.split(" ")[0]}</strong> {t.min.split(" ").slice(1).join(" ")}</span>
                <span className="gfc-tier-price">{t.price}<em>/hr</em></span>
              </div>
              <Button variant={t.featured ? "gold" : "outline"} onClick={onContact}>
                {t.featured ? "Discuss this tier" : "Learn more"}
              </Button>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ContinuousCare({ onContact }) {
  return (
    <section className="gfc-ccm on-navy" id="continuous">
      <div className="gfc-container gfc-ccm-grid">
        <div>
          <Eyebrow light>Continuous Care Program</Eyebrow>
          <h2>Most families don't know something is wrong<br/><span className="italic">until it's a crisis.</span></h2>
          <p className="gfc-lead">A hybrid monitoring service combining in-home camera activity monitoring with scheduled video check-ins — for families who need more than a weekly visit.</p>
          <div className="gfc-ccm-feats">
            <CheckItem title="Activity monitoring">Cameras track daily patterns. Unusual changes trigger an immediate check-in.</CheckItem>
            <CheckItem title="Scheduled video visits">A real person checking in — not an automated system.</CheckItem>
            <CheckItem title="Family alerts">Updates via the care app. You hear from us directly.</CheckItem>
          </div>
        </div>
        <aside className="gfc-ccm-card">
          <div className="gfc-ccm-card-head">
            <span className="gfc-eyebrow light">Base Program</span>
            <span className="gfc-ccm-pill">Most popular</span>
          </div>
          <div className="gfc-ccm-price">
            <span className="big">$299</span>
            <span className="per">/month flat</span>
          </div>
          <p className="gfc-ccm-sub">No hourly minimums. Clinician-reviewed escalation included.</p>
          <ul className="gfc-ccm-list">
            <li>In-home activity monitoring</li>
            <li>Family alert notifications</li>
            <li>Monthly care summary report</li>
            <li>Provider coordination</li>
          </ul>
          <div className="gfc-ccm-addon">
            <strong>+ Scheduled Video Check-Ins</strong>
            <span>$45 per 3 visits</span>
          </div>
          <Button variant="gold" onClick={onContact}>Start your program</Button>
        </aside>
      </div>
    </section>
  );
}

Object.assign(window, { ServiceTiers, ContinuousCare });
