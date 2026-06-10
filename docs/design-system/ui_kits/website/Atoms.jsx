/* global React */
const { useState } = React;

// ============ Atoms ============
function Eyebrow({ children, light }) {
  return (
    <span className={"gfc-eyebrow" + (light ? " light" : "")}>
      <span className="gfc-eyebrow-rule" />{children}
    </span>
  );
}

function Button({ variant = "primary", size = "md", children, onClick, href }) {
  const cls = `gfc-btn gfc-btn-${variant} gfc-btn-${size}`;
  if (href) return <a className={cls} href={href} onClick={onClick}>{children}</a>;
  return <button className={cls} onClick={onClick}>{children}</button>;
}

function Section({ children, dark, narrow, className = "" }) {
  return (
    <section className={`gfc-section ${dark ? "on-navy" : ""} ${narrow ? "narrow" : ""} ${className}`}>
      <div className="gfc-container">{children}</div>
    </section>
  );
}

function CheckItem({ title, children }) {
  return (
    <div className="gfc-check-item">
      <span className="gfc-check">✓</span>
      <div>
        {title && <strong>{title}</strong>}
        <span>{children}</span>
      </div>
    </div>
  );
}

// Make available globally for sibling babel scripts
Object.assign(window, { Eyebrow, Button, Section, CheckItem });
