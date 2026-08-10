'use client';

// A compact, dependency-free Markdown renderer for the assistant's replies.
// Supports the GitHub-flavored subset the model is told to use: headings, bold/
// italic/inline code, fenced code, links, blockquotes, ordered/unordered lists,
// horizontal rules, and tables. It builds React elements directly (never
// dangerouslySetInnerHTML), and link hrefs are restricted to http(s)/relative,
// so model output can't inject markup or scripts.

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import styles from './markdown.module.css';

function legacyCopy(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

function CopyCodeButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const copy = async () => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        ok = legacyCopy(text);
      }
    } catch {
      ok = legacyCopy(text);
    }
    if (!ok) return;
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 1_800);
  };

  return (
    <button
      type="button"
      className={styles.copyCode}
      onClick={copy}
      aria-label={copied ? 'Copied code' : 'Copy code'}
      title={copied ? 'Copied' : 'Copy code'}
      data-copied={copied || undefined}
    >
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
    </button>
  );
}

// ── Inline (bold, italic, code, links) ───────────────────────────────────────

const safeHref = (href: string): string | null => {
  const h = href.trim();
  if (/^https?:\/\//i.test(h) || h.startsWith('/') || h.startsWith('#')) return h;
  return null;
};

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Matches: `code`, **bold**, *italic*/_italic_, [label](href)
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith('`')) {
      out.push(<code key={k} className={styles.code}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('**')) {
      out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)!;
      const href = safeHref(mm[2]);
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer">
            {mm[1]}
          </a>
        ) : (
          mm[1]
        ),
      );
    } else {
      out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ── Block parser ─────────────────────────────────────────────────────────────

const splitRow = (line: string): string[] =>
  line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      const code = body.join('\n');
      blocks.push(
        <div key={key++} className={styles.codeBlock}>
          <CopyCodeButton text={code} />
          <pre className={styles.pre}>
            <code>{code}</code>
          </pre>
        </div>,
      );
      continue;
    }

    // Table: header row of pipes followed by a separator row
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i++]));
      }
      blocks.push(
        <div key={key++} className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {header.map((h, hi) => (
                  <th key={hi}>{inline(h, `th-${key}-${hi}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td key={ci}>{inline(r[ci] ?? '', `td-${key}-${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const Tag = (`h${Math.min(level + 2, 6)}`) as 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(
        <Tag key={key++} className={styles.heading}>
          {inline(h[2], `h-${key}`)}
        </Tag>,
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push(<hr key={key++} className={styles.hr} />);
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(
        <blockquote key={key++} className={styles.quote}>
          {inline(body.join(' '), `q-${key}`)}
        </blockquote>,
      );
      continue;
    }

    // Lists (ordered / unordered)
    const ulMatch = /^[-*+]\s+/.test(line);
    const olMatch = /^\d+\.\s+/.test(line);
    if (ulMatch || olMatch) {
      const items: ReactNode[] = [];
      const isOl = olMatch;
      while (i < lines.length && (isOl ? /^\d+\.\s+/ : /^[-*+]\s+/).test(lines[i])) {
        const content = lines[i].replace(isOl ? /^\d+\.\s+/ : /^[-*+]\s+/, '');
        items.push(<li key={items.length}>{inline(content, `li-${key}-${items.length}`)}</li>);
        i++;
      }
      blocks.push(
        isOl ? (
          <ol key={key++} className={styles.list}>
            {items}
          </ol>
        ) : (
          <ul key={key++} className={styles.list}>
            {items}
          </ul>
        ),
      );
      continue;
    }

    // Paragraph (gather consecutive non-blank, non-structural lines)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^[-*+]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim())
    ) {
      para.push(lines[i++]);
    }
    blocks.push(
      <p key={key++} className={styles.p}>
        {para.map((l, li) => (
          <Fragment key={li}>
            {li > 0 ? <br /> : null}
            {inline(l, `p-${key}-${li}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className={styles.md}>{blocks}</div>;
}
