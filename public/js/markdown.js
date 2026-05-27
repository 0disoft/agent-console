import { escapeHtml } from "./text.js";

export function looksLikeMarkdown(text) {
  return /(^|\n)(#{1,4}\s|[-*]\s|\d+\.\s|```)|`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\[[^\]]+\]\([^)]+\)/.test(text);
}

export function renderMarkdown(text) {
  const blocks = [];
  let index = 0;
  const extracted = text.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const token = `@@CODE_${blocks.length}@@`;
    blocks.push(`<pre><code${lang ? ` data-lang="${lang}"` : ""}>${escapeHtml(code)}</code></pre>`);
    return token;
  });
  const escaped = escapeHtml(extracted);
  const lines = escaped.split(/\r?\n/);
  const html = [];
  while (index < lines.length) {
    const line = lines[index];
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(4, heading[1].length + 2);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        items.push(`<li>${renderInlineMarkdown(lines[index].replace(/^[-*]\s+/, ""))}</li>`);
        index += 1;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
        items.push(`<li>${renderInlineMarkdown(lines[index].replace(/^\d+\.\s+/, ""))}</li>`);
        index += 1;
      }
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,4})\s+|^[-*]\s+|^\d+\.\s+/.test(lines[index])) {
      const codeToken = /^@@CODE_(\d+)@@$/.exec(lines[index]);
      if (codeToken) {
        if (paragraph.length) {
          html.push(`<p>${renderInlineMarkdown(paragraph.join("<br>"))}</p>`);
          paragraph.length = 0;
        }
        html.push(blocks[Number(codeToken[1])] || "");
        index += 1;
        continue;
      }
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length) {
      html.push(`<p>${renderInlineMarkdown(paragraph.join("<br>"))}</p>`);
    }
  }
  return html.join("").replace(/@@CODE_(\d+)@@/g, (_, i) => blocks[Number(i)] || "");
}

function renderInlineMarkdown(text) {
  const codeSpans = [];
  const protectedText = text.replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@INLINE_CODE_${codeSpans.length}@@`;
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });
  return protectedText
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      const safe = safeHref(href);
      return safe ? `<a href="${safe}" target="_blank" rel="noreferrer">${label}</a>` : label;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/@@INLINE_CODE_(\d+)@@/g, (_, i) => codeSpans[Number(i)] || "");
}

function safeHref(href) {
  const decoded = href.replaceAll("&amp;", "&");
  if (/^(https?:|mailto:|\/|#)/i.test(decoded)) {
    return decoded.replaceAll('"', "%22");
  }
  return "";
}
