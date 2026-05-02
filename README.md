# Sarv Office Plugins

A collection of plugins for [Sarv Office](https://sarv.com) editors — documents, spreadsheets, and presentations.

**Plugin page:** [sarv.github.io/sarv-editors-plugins](https://sarv.github.io/sarv-editors-plugins/)  
**Repository:** [github.com/Sarv/sarv-editors-plugins](https://github.com/Sarv/sarv-editors-plugins)

---

## Development

### Local dev server

Serve all plugins locally so changes reflect instantly — no push to GitHub needed.

```bash
node dev-server.js
```

In **Sarv Office → Plugin Manager**, set the index URL to:

```
http://localhost:30300/plugins-index.json
```

Close and reopen any plugin panel to pick up HTML/JS/CSS changes.

---

### Enabling / disabling plugins

Each plugin controls its own availability via an optional `"enabled"` field in its `config.json`. No other file needs to change when you add or configure a plugin.

| Value | Effect |
|---|---|
| absent or `true` | Enabled for all editors listed in `EditorsSupport` (default) |
| `false` | Disabled — removed from the plugins index entirely |
| `["word", "cell"]` | Enabled only for those editors — overrides `EditorsSupport` |

**Examples:**

```json
// Enable for all editors (default — no field needed)
{ "name": "My Plugin", ... }

// Restrict to document and spreadsheet editors only
{ "name": "My Plugin", "enabled": ["word", "cell"], ... }

// Disable entirely
{ "name": "My Plugin", "enabled": false, ... }
```

The dev server re-reads each plugin's `config.json` on every request, so changes take effect without restarting the server.

---

## Plugins

| Plugin | Description |
|--------|-------------|
| **AI** | Use the AI chatbot to perform tasks which involve understanding or generating natural language or code. |
| **Apertium** | Quickly translate words and sentences using Apertium. |
| **Autocomplete** | Use an input assistant while typing in the editors. |
| **Bergamot Translator** | Offline machine translation powered by Bergamot — privacy-friendly, works without internet. |
| **Chess** | Play chess with other collaborators right in the editors. |
| **CVbuilder** | A resume generation plugin, aiming to help users swiftly create resumes. |
| **Date Picker** | Insert formatted dates into cells. |
| **DeepL** | Translate the selected text into other languages using DeepL. |
| **Doc2md** | Convert your formatted documents to Markdown or HTML. |
| **draw.io** | Create, edit, and insert professional-looking diagrams into your documents. |
| **EasyBib** | Generate citations and create bibliographies in your documents. |
| **Glavred** | Make your text more informative and clear (suitable for texts in Russian). |
| **Grammalecte** | Quickly correct grammar and style mistakes in French texts. |
| **Highlight Code** | Highlight syntax of code by selecting the language, style, and background color. |
| **HTML** | Get your document content as HTML, modify it, and paste it back into the document. |
| **Icons** | Insert icons into your documents by category or search. |
| **ID Photo Converter** | Convert captured photos into ID photo format using image algorithms and neural network models. |
| **QR Code Generator** | Effortlessly generate QR codes in Presentation, Text, and Spreadsheet editors. |
| **Jitsi** | Make audio and video calls right in the editors using Jitsi. |
| **LanguageTool** | Improve spelling, grammar, and style in your texts. |
| **LizardTypst** | Insert Typst mathematical formulas as SVG. |
| **Mathpix** | Perform OCR on mathematical formulas and text using the Mathpix service. |
| **Mendeley** | Create bibliographies and insert citations using the Mendeley service. |
| **News** | Search through millions of articles from over 80,000 news sources and blogs. |
| **OCR** | Recognize text from pictures and screenshots and insert it into your documents. |
| **OData Import** | Import data from OData feeds into your spreadsheet — enter a service URL, select tables, and paste data into cells. |
| **OnlyDraw** | Add images, create memes, customize drawings, and insert documents. |
| **Photo Editor** | Edit images, screenshots, and photos right in your documents: crop, resize, apply effects. |
| **Pixabay** | Find and insert free images in your documents via Pixabay. |
| **Pomodoro** | Improve focus and productivity with 25-minute work cycles and 5-minute breaks. |
| **Rainbow** | Exchange instant messages and make calls using Rainbow. |
| **Speech** | Convert the selected text into speech. |
| **Speech Input** | Type with your voice by converting spoken words into text. |
| **Telegram** | Chat with co-authors in real time using an integrated Telegram client. |
| **TerMef** | Terminology and lexicon management tool. |
| **Text Cleaner** | Remove line breaks, extra spaces, and clutter while keeping bold and italic formatting. |
| **Text Highlighter** | Search for text and apply highlighting, color, and formatting styles in the document. |
| **Thesaurus** | Search for synonyms and antonyms of a word and replace it with the selected one. |
| **Translator** | Translate the selected text into other languages with Google Translate. |
| **Typograf** | Prepare your texts for publishing by correcting typography. |
| **Video Embedder** | Embed videos from Bilibili, QQ, Ixigua, Youku, and IQIYI into your documents. |
| **WordPress** | Publish articles directly from the document editor to your WordPress website. |
| **Word Counter** | Count words, characters (with/without spaces), and paragraphs in the selected text. |
| **YouTube** | Easily embed YouTube videos into your documents. |
| **ZhiPu Copilot** | Generate articles, interpret spreadsheet data, and create presentation outlines using ChatGLM AI. |
| **Zoom** | Schedule and hold video meetings right in the editors using Zoom. |
| **Zotero** | Create bibliographies in the required style using the Zotero service. |