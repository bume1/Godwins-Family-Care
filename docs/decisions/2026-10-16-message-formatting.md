# Richer message formatting that survives saving and copying

Owner, 2026-10-16: "fix the messaging format in the app, it needs to be richer... it shows oddly when saved, the formatting goes or when copied it leaves. Make sure messaging and text formatting when typing is streamlined with bold, italicized, etc."

## What was wrong (reproduced in Chromium before changing anything)

- **Shift+Enter line breaks vanished on save.** The editor is a pre-wrap box, so the browser stores Shift+Enter as a bare newline; `domToMarkup` turned every newline into a space. "Second paragraph / soft line" saved as one line. The clinical note editor had the same loss.
- **Every paste was stripped to plain text, on purpose** ("formatting from Word or a web page is not carried over"). Copying a formatted message, or anything from Docs or Word, lost all formatting.
- **A Google Docs bullet lost its bullet even as text**: Docs wraps each `<li>` in a `<p>`, and the opening block reset the line's type.
- **Editing a sent message showed raw marks** (`**bold**`, `_italic_`) in a plain box.

## Must not undo

- **What is stored is still only the shapes in `public/note-format.js`, never HTML.** A paste is parsed inert (`DOMParser`), reduced by `domToMarkup`, and re-rendered by the escaping renderer before it is inserted. Raw pasted HTML is never put in the editor. A script or image in a paste does nothing (checked in the browser).
- **Formatting comes from tags AND inline styles**, because Docs marks bold as `font-weight:700` and wraps the whole paste in `<b style="font-weight:normal">`. Word list paragraphs become bullets and Word's own bullet character is dropped.
- **Strikethrough (`~~`) exists only where a caller asks** (`domToMarkup(…, { strike: true })`, messaging). The clinical editor does not ask: OpenEMR's plain-text copy cannot show a line through words, so struck-out text would read there as still meant. A literal `~` is escaped, so old text and typed tildes never become a format.
- **`newlines: true` is for an editor's own box only.** In HTML from elsewhere a newline is only spacing.
- **Links** are rendered for messages only (`renderHtml(…, { linkify: true })`): http(s) only, escaped, opens in a new tab, trailing punctuation left out. Nothing is stored as a link; the address stays text.

## The composer now

Toolbar: Bold, Italic, Underline, Strikethrough, bullets, numbers, Heading, Clear, each lit when active. Shortcuts: Ctrl/Cmd+B/I/U, Ctrl+Shift+X strike, Ctrl+Shift+8/7 lists, Shift+Enter a new line. Typing "- " or "1. " at the start of a line starts a list. The super admin's Edit uses the same rich box.

## Verified

- 6 new tests in `test/note_format.test.js` and 1 in `test/care_team_messaging.test.js`. One older composer guard was repointed: it pinned "a paste is text only", which this change reverses on the owner's instruction. 13 of 13 deliberate breaks caught. Strikethrough had been guarded three times over, so any single break changed nothing; the redundant guard was removed so each remaining one is tested.
- Full suite 2541, 0 failing (1 skipped, already skipped before). `verify_messaging.js` 95/95. clinical, portal and admin-hub pages compile.
- Driven in headless Chromium: typing with shortcuts and toolbar, auto-list, pastes from Docs, Word and a copied message, send, and the saved message shown back with bold, italic, underline, strikethrough, lists, the Shift+Enter line and a clickable link; the edit box opens rich and saves markup. No page errors.

## Not done

- No coloured text, font sizes or tables: the stored format stays small on purpose.
- The clinical note editor got the Shift+Enter fix only. It still pastes as plain text.
- The signed-note PDF does not draw strikethrough, but no clinical path produces it.
