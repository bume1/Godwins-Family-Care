/* global React */

function Process() {
  const steps = [
    { t: "Free Consultation",        b: "We talk through your loved one's needs — no pressure, no commitment." },
    { t: "In-Home Assessment",        b: "We evaluate abilities, routines, and safety concerns at home." },
    { t: "Personalized Care Plan",    b: "A clinical care plan that coordinates with their medical team." },
    { t: "Thoughtful Caregiver Match",b: "Matched by personality and clinical need — same caregiver every time." },
    { t: "Ongoing Clinical Oversight",b: "Regular updates, proactive communication, direct provider coordination." },
  ];
  return (
    <section className="gfc-section" id="process">
      <div className="gfc-container">
        <div className="gfc-section-head">
          <Eyebrow>How It Works</Eyebrow>
          <h2>Five steps from first call to ongoing care.</h2>
        </div>
        <ol className="gfc-process">
          {steps.map((s, i) => (
            <li key={i} className="gfc-process-step">
              <span className="gfc-process-num">0{i+1}</span>
              <h3>{s.t}</h3>
              <p>{s.b}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Testimonials() {
  const quotes = [
    { q: "It helps having the same caregiver week to week. I can better manage my routine.", a: "Florence", r: "GFCLLC client" },
    { q: "My mother doesn't like to be alone and we were traveling. Godwins Family Care stepped in — they were amazing.", a: "Summer", r: "Family member of GFCLLC client" },
    { q: "They knew exactly how to handle my dad's behavioral outbursts.", a: "Family member", r: "GFCLLC client" },
  ];
  return (
    <section className="gfc-section on-navy gfc-testimonials" id="testimonials">
      <div className="gfc-container">
        <div className="gfc-section-head">
          <Eyebrow light>What Families Say</Eyebrow>
          <h2>The difference families notice.</h2>
        </div>
        <div className="gfc-quote-grid">
          {quotes.map((q, i) => (
            <figure key={i} className="gfc-quote">
              <span className="gfc-quote-mark">"</span>
              <blockquote>{q.q}</blockquote>
              <figcaption>
                <strong>{q.a}</strong>
                <span>{q.r}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

function ServiceArea() {
  const cities = ["Acworth", "Kennesaw", "Woodstock", "Marietta", "Roswell", "Smyrna", "Powder Springs", "Canton", "Vinings"];
  return (
    <section className="gfc-section gfc-area">
      <div className="gfc-container">
        <div className="gfc-area-grid">
          <div>
            <Eyebrow>Service Area</Eyebrow>
            <h2>North Atlanta &amp; Cobb County.</h2>
            <p>Locally owned and based in Atlanta. Adjacent areas considered case-by-case — call to ask.</p>
          </div>
          <ul className="gfc-area-list">
            {cities.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      </div>
    </section>
  );
}

Object.assign(window, { Process, Testimonials, ServiceArea });
