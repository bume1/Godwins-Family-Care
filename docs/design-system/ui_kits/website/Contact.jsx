/* global React */

function ContactForm({ inline }) {
  const [submitted, setSubmitted] = React.useState(false);
  const onSubmit = (e) => { e.preventDefault(); setSubmitted(true); };
  return (
    <section className={`gfc-contact ${inline ? "inline" : ""}`} id="contact">
      <div className="gfc-container gfc-contact-grid">
        <div className="gfc-contact-copy">
          <Eyebrow>Get in Touch</Eyebrow>
          <h2>Let's talk about supporting your loved one.</h2>
          <p className="gfc-lead">A 15-minute conversation, no pressure. Tell us a little, and we'll follow up by phone within one business day.</p>
          <ul className="gfc-contact-list">
            <li><span className="lab">Call</span><a href="tel:4049136705">(404) 913-6705</a></li>
            <li><span className="lab">Email</span><a href="mailto:godwinsfamilycarellc@gmail.com">godwinsfamilycarellc@gmail.com</a></li>
            <li><span className="lab">Visit</span>4300 Paces Ferry Road SE, Suite 500 · Atlanta, GA 30339</li>
          </ul>
        </div>
        <form className="gfc-form" onSubmit={onSubmit}>
          {submitted ? (
            <div className="gfc-form-success">
              <span className="gfc-form-check">✓</span>
              <h3>Thank you.</h3>
              <p>We'll be in touch within one business day.</p>
            </div>
          ) : (
            <>
              <div className="gfc-form-row">
                <label>First name<input required defaultValue="" placeholder="Margaret" /></label>
                <label>Last name<input required placeholder="Johnson" /></label>
              </div>
              <label>Phone<input type="tel" required placeholder="(404) 555-0100" /></label>
              <label>Who needs care?
                <select defaultValue="parent">
                  <option value="parent">A parent</option>
                  <option value="spouse">My spouse</option>
                  <option value="self">Myself</option>
                  <option value="other">Someone else</option>
                </select>
              </label>
              <label>Tell us a little
                <textarea rows="3" placeholder="A few sentences is enough."></textarea>
              </label>
              <Button variant="navy" size="lg">Request consultation</Button>
              <p className="gfc-form-fine">By submitting, you agree to be contacted by our team. Your information stays private.</p>
            </>
          )}
        </form>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="gfc-footer on-navy">
      <div className="gfc-container gfc-footer-grid">
        <div>
          <img src="../../assets/logo-mark-white-transparent.png" alt="Godwins Family Care" className="gfc-footer-mark" />
          <p>Godwins Family Care LLC is a healthcare organization providing private home care, in-home medical care, and independent medical examinations in Atlanta, GA.</p>
        </div>
        <div>
          <h5>Services</h5>
          <ul>
            <li><a href="#services">Essential ADL Support</a></li>
            <li><a href="#services">Comprehensive Home Care</a></li>
            <li><a href="#services">Behavioral &amp; Cognitive</a></li>
            <li><a href="#continuous">Continuous Care Program</a></li>
            <li><a href="#">Independent Medical Exams</a></li>
          </ul>
        </div>
        <div>
          <h5>Company</h5>
          <ul>
            <li><a href="#about">About</a></li>
            <li><a href="#process">How it works</a></li>
            <li><a href="#testimonials">Stories</a></li>
            <li><a href="#">Referral partners</a></li>
            <li><a href="#">Careers</a></li>
          </ul>
        </div>
        <div>
          <h5>Contact</h5>
          <ul>
            <li><a href="tel:4049136705">(404) 913-6705</a></li>
            <li><a href="mailto:godwinsfamilycarellc@gmail.com">godwinsfamilycarellc@gmail.com</a></li>
            <li>4300 Paces Ferry Rd SE, #500</li>
            <li>Atlanta, GA 30339</li>
          </ul>
        </div>
      </div>
      <div className="gfc-footer-fine">
        <div className="gfc-container">
          <span>© 2026 Godwins Family Care LLC. Georgia PHCP licensed. Medicaid certification in progress.</span>
          <span><a href="#">Privacy</a> · <a href="#">Terms</a> · <a href="#">Accessibility</a></span>
        </div>
      </div>
    </footer>
  );
}

Object.assign(window, { ContactForm, Footer });
