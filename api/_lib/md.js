// Minimal markdown → HTML for the 6 wholesale nurture templates.
// Not a general-purpose renderer — just the subset the templates
// actually use:
//
//   - Paragraphs (blank-line separated)
//   - Headings  (# h1  through ### h3)
//   - **bold**  and  *italic*
//   - [text](url)  links
//   - Unordered lists:  - item   (one bullet per line, contiguous)
//
// Everything else is treated as text and HTML-escaped. No code
// blocks, no tables, no block quotes.
//
// Output is safe HTML: all raw text is escaped before any markdown
// is interpreted, so a merge field that contains < or & cannot break
// out into markup.

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Fill {{merge_field}} placeholders in a raw template string using the
// provided map. Unknown fields collapse to empty string (not an error).
function mergeFields(template, fields) {
  return String(template).replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, k) => {
    const v = fields && fields[k];
    return v == null ? '' : String(v);
  });
}

function inlineMd(text) {
  // Order matters: links first (they contain [](), which would otherwise
  // get mangled), then bold, then italic.
  let s = escapeHtml(text);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    // Hard scheme allowlist: http(s) absolute or site-relative only.
    // Anything else (javascript:, data:, vbscript:, file:, mailto:, …)
    // leaves the original escaped text in place rather than rendering
    // a dangerous anchor. Merge fields are substituted BEFORE this
    // runs, so a hostile value in e.g. first_name cannot smuggle a
    // javascript: href via a crafted [click](...)  payload.
    if (!/^(https?:\/\/|\/[^/])/i.test(href)) return match;
    return `<a href="${href}">${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return s;
}

function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Blank → paragraph boundary.
    if (!line.trim()) { i++; continue; }

    // Heading.
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inlineMd(h[2].trim())}</h${lvl}>`);
      i++;
      continue;
    }

    // Unordered list — gather contiguous "- " lines.
    if (/^\s*-\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        items.push(inlineMd(lines[i].replace(/^\s*-\s+/, '').trim()));
        i++;
      }
      out.push('<ul>' + items.map(x => `<li>${x}</li>`).join('') + '</ul>');
      continue;
    }

    // Paragraph — gather until next blank or special line.
    const buf = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) break;
      if (/^(#{1,3})\s+/.test(l)) break;
      if (/^\s*-\s+/.test(l)) break;
      buf.push(l.trim());
      i++;
    }
    out.push(`<p>${inlineMd(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

module.exports = { renderMarkdown, mergeFields, escapeHtml };
