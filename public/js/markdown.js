import { escapeHtml } from "./text.js";

export function looksLikeMarkdown(text) {
  return /(^|\n)(#{1,4}\s|[-*]\s|\d+\.\s|```|>\s|---+\s*$|\|.+\|)|`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\[[^\]]+\]\([^)]+\)/.test(text);
}

export function renderMarkdown(text) {
  const blocks = [];
  const codeTokenPrefix = `@@AGENT_CONSOLE_CODE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_`;
  const inlineTokenPrefix = `@@AGENT_CONSOLE_INLINE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_`;
  let index = 0;
  const extracted = text.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const token = `${codeTokenPrefix}${blocks.length}@@`;
    blocks.push(`<pre><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}>${escapeHtml(code)}</code></pre>`);
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
      html.push(`<h${level}>${renderInlineMarkdown(heading[2], inlineTokenPrefix)}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      html.push("<hr>");
      index += 1;
      continue;
    }
    if (/^&gt;\s+/.test(line)) {
      const quote = [];
      while (index < lines.length && /^&gt;\s+/.test(lines[index])) {
        quote.push(lines[index].replace(/^&gt;\s+/, ""));
        index += 1;
      }
      html.push(`<blockquote>${quote.map((item) => `<p>${renderInlineMarkdown(item, inlineTokenPrefix)}</p>`).join("")}</blockquote>`);
      continue;
    }
    if (isTableStart(lines, index)) {
      const table = collectTable(lines, index, inlineTokenPrefix);
      html.push(table.html);
      index = table.nextIndex;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        const item = lines[index].replace(/^[-*]\s+/, "");
        const checkbox = /^\[( |x|X)\]\s+(.+)$/.exec(item);
        if (checkbox) {
          const checked = checkbox[1].toLowerCase() === "x" ? " checked" : "";
          items.push(`<li class="task-item"><input type="checkbox" disabled${checked}>${renderInlineMarkdown(checkbox[2], inlineTokenPrefix)}</li>`);
        } else {
          items.push(`<li>${renderInlineMarkdown(item, inlineTokenPrefix)}</li>`);
        }
        index += 1;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
        items.push(`<li>${renderInlineMarkdown(lines[index].replace(/^\d+\.\s+/, ""), inlineTokenPrefix)}</li>`);
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
      const codeToken = tokenRegex(codeTokenPrefix, true).exec(lines[index]);
      if (codeToken) {
        if (paragraph.length) {
          html.push(`<p>${renderInlineMarkdown(paragraph.join("<br>"), inlineTokenPrefix)}</p>`);
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
      html.push(`<p>${renderInlineMarkdown(paragraph.join("<br>"), inlineTokenPrefix)}</p>`);
    }
  }
  return html.join("").replace(tokenRegex(codeTokenPrefix), (_, i) => blocks[Number(i)] || "");
}

function isTableStart(lines, index) {
  return isTableRow(lines[index]) && isTableSeparator(lines[index + 1] || "");
}

function collectTable(lines, start, inlineTokenPrefix) {
  const headers = splitTableRow(lines[start]);
  let index = start + 2;
  const rows = [];
  while (index < lines.length && isTableRow(lines[index])) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }
  const head = `<thead><tr>${headers.map((cell) => `<th>${renderInlineMarkdown(cell, inlineTokenPrefix)}</th>`).join("")}</tr></thead>`;
  const body = `<tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${renderInlineMarkdown(row[cellIndex] || "", inlineTokenPrefix)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return { html: `<table>${head}${body}</table>`, nextIndex: index };
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line || "");
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line || "");
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function renderInlineMarkdown(text, inlineTokenPrefix) {
  const codeSpans = [];
  const protectedText = text.replace(/`([^`]+)`/g, (_, code) => {
    const token = `${inlineTokenPrefix}${codeSpans.length}@@`;
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
    .replace(tokenRegex(inlineTokenPrefix), (_, i) => codeSpans[Number(i)] || "");
}

function tokenRegex(prefix, exact = false) {
  return new RegExp(`${exact ? "^" : ""}${escapeRegExp(prefix)}(\\d+)@@${exact ? "$" : ""}`, exact ? "" : "g");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeHref(href) {
  const decoded = href.replaceAll("&amp;", "&");
  if (/^(https?:|mailto:|\/|#)/i.test(decoded)) {
    return decoded.replaceAll('"', "%22");
  }
  return "";
}
