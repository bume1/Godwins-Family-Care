// The formatted text editor and reader, shared (2026-11-15).
//
// One copy of the six-shape editor clinical notes have had since PR #133, so
// announcements can offer the same bold, italic, underline, bulleted list,
// numbered list and heading rather than a third hand-rolled copy. What it
// STORES is markup, never HTML: every change walks the editor's DOM back
// through domToMarkup, so a paste or an odd browser element cannot reach a
// record. Rendering escapes before it formats, in note-format.js.
//
// Loaded as <script type="text/babel" src>. Babel runs it before the page's
// own script, in document order, so it must load AFTER /note-format.js and
// BEFORE any page script or component that reads window.GFC_FORMATTED.
//
// Needs window.GFC_NOTE_FORMAT (/note-format.js) and React.
(function () {
const { useRef, useEffect } = React;
const NF = window.GFC_NOTE_FORMAT;

// The styles live with the component, not in each page, so the six shapes
// cannot look like a list on one screen and a paragraph on another. Tailwind's
// reset strips list markers and heading sizes, which is why they are restated.
// Injected once; a page may still override any of it afterwards.
const STYLE_ID = 'gfc-formatted-field-css';
function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
    .fmt { font-size:13px; line-height:1.5; color:#1f2937; }
    .fmt ul { list-style:disc; padding-left:1.25rem; margin:2px 0; }
    .fmt ol { list-style:decimal; padding-left:1.4rem; margin:2px 0; }
    .fmt h3 { font-size:14px; font-weight:700; color:#033D50; margin:4px 0 2px; }
    .fmt strong { font-weight:700; } .fmt em { font-style:italic; } .fmt u { text-decoration:underline; }
    .fmt-editor { min-height:3.2em; outline:none; white-space:pre-wrap; }
    .fmt-editor:empty::before { content:attr(data-placeholder); color:#a8a29e; }
    .fmt-tool { border:1px solid #e5ddcb; background:#fff; border-radius:6px; min-width:28px; height:26px; padding:0 6px; font-size:12px; color:#033D50; }
    .fmt-tool:hover { background:#FAF7F2; }
    .carried { background:#FDF6E7; border:1px dashed #C9A44A; }
  `;
  document.head.appendChild(el);
}
injectStyles();

const FMT_TOOLS = [
  { cmd: 'bold', label: <b>B</b>, title: 'Bold (Ctrl/⌘+B)' },
  { cmd: 'italic', label: <i>I</i>, title: 'Italic (Ctrl/⌘+I)' },
  { cmd: 'underline', label: <u>U</u>, title: 'Underline (Ctrl/⌘+U)' },
  { cmd: 'insertUnorderedList', label: <i className="ti ti-list" />, title: 'Bulleted list' },
  { cmd: 'insertOrderedList', label: <i className="ti ti-list-numbers" />, title: 'Numbered list' },
  { cmd: 'heading', label: <i className="ti ti-heading" />, title: 'Section heading' }
];

// Read-only formatted text. renderHtml ESCAPES every character before it
// applies a shape, so nothing a person typed can become live markup — this is
// the only place raw HTML is handed to React, and that is why it is one copy.
const FormattedView = ({ markup, className }) => (
  <div className={`fmt ${className || ''}`} dangerouslySetInnerHTML={{ __html: NF.renderHtml(markup || '') }} />
);

// A text field with a formatting toolbar.
//
// This file is GENERAL PURPOSE: the same toolbar serves a clinical note, a
// staff announcement and a client announcement, and nothing clinical belongs
// in it. `requiredNote` therefore defaults to the neutral "· required"; the
// clinical workspace supplies its own "· required to sign" in one place, and
// a screen where signing means nothing is not handed clinical vocabulary by
// accident (owner, 2026-11-15: "not all announcements are clinical").
const FormattedField = ({ label, value, onChange, readOnly, placeholder, minRows, carried, onConfirmCarried, required, requiredNote }) => {
  const ref = useRef(null);
  const emitted = useRef(null);
  // Load the value when it changes from OUTSIDE — a load, a carry-forward,
  // the other clinician's version. Never on this editor's own keystrokes, or
  // the caret would jump to the start on every letter.
  useEffect(() => {
    const el = ref.current;
    if (!el || value === emitted.current) return;
    el.innerHTML = NF.renderHtml(value || '');
    emitted.current = value;
  }, [value]);
  const emit = () => {
    if (!ref.current) return;
    // newlines: Shift+Enter in this pre-wrap box is a real line break, not a space.
    const markup = NF.domToMarkup(ref.current, { newlines: true });
    if (markup === emitted.current) return;
    emitted.current = markup;
    onChange && onChange(markup);
  };
  const run = (cmd) => {
    if (readOnly || !ref.current) return;
    ref.current.focus();
    if (cmd === 'heading') {
      const inHeading = /^h\d$/i.test(String(document.queryCommandValue('formatBlock') || ''));
      document.execCommand('formatBlock', false, inHeading ? 'div' : 'h3');
    } else {
      document.execCommand(cmd, false, null);
    }
    emit();
  };
  // A paste arrives as TEXT: formatting from Word or a web page is not
  // carried over, and the writer applies what they mean with the toolbar.
  const onPaste = (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
    emit();
  };
  return (
    <div>
      {label && <span className="lblu fmt-label block mb-1">{label}{required && <span className="text-amber-700"> {requiredNote || '· required'}</span>}</span>}
      <div className={`rounded-lg ${carried ? 'carried' : 'border border-[#e5ddcb]'} bg-white`}>
        {!readOnly && (
          <div className="flex flex-wrap gap-1 px-2 pt-2" role="toolbar" aria-label={`Format ${label || 'text'}`}>
            {FMT_TOOLS.map(t => (
              <button type="button" key={t.cmd} className="fmt-tool" title={t.title} aria-label={t.title}
                onMouseDown={e => { e.preventDefault(); run(t.cmd); }}>{t.label}</button>
            ))}
          </div>
        )}
        <div ref={ref} className="fmt fmt-editor px-3 py-2" role="textbox" aria-multiline="true" aria-label={label || 'Note text'}
          contentEditable={!readOnly} suppressContentEditableWarning data-placeholder={placeholder || ''}
          style={{ minHeight: `${(minRows || 2) * 1.5}em` }}
          onInput={emit} onBlur={emit} onPaste={onPaste} />
      </div>
      {carried && (
        <button type="button" className="prefill-badge mt-1 flex items-center gap-1" onClick={onConfirmCarried}>
          <i className="ti ti-alert-circle" /> CARRIED FORWARD — EDIT IT, OR TAP TO CONFIRM IT STILL APPLIES
        </button>
      )}
    </div>
  );
};

window.GFC_FORMATTED = { FormattedField, FormattedView, FMT_TOOLS, injectStyles };
})();
