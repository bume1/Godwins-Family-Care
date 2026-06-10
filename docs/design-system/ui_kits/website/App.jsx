/* global React, ReactDOM */
const { useRef } = React;

function App() {
  const formRef = useRef(null);
  const onContact = () => {
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <>
      <Header onContact={onContact} />
      <Hero onContact={onContact} />
      <ValueStrip />
      <ServiceTiers onContact={onContact} />
      <ContinuousCare onContact={onContact} />
      <Process />
      <Testimonials />
      <ServiceArea />
      <div ref={formRef}><ContactForm /></div>
      <Footer />
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
