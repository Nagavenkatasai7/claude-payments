/**
 * Convert the model's CommonMark to WhatsApp's own formatting (*bold*,
 * _italic_, ~strike~, ```mono```, "• " bullets). WhatsApp does not render
 * CommonMark, so "**Fee:**" otherwise reaches the customer with literal
 * asterisks.
 *
 * WhatsApp channel only (the web chat gets the reply unchanged). Runs BEFORE
 * sanitizeReply, which stays the single URL/host policy over the final text:
 * a markdown link becomes "text url", and sanitizeReply then decides the url.
 *
 * Fenced blocks and `inline code` are left exactly as written. Masked account
 * numbers (****6789) are never touched: every emphasis delimiter must have a
 * non-* character just inside it. Pure; idempotent.
 */

const OPEN = '';
const CLOSE = '';
const SENTINELS = /[]/gu;
const CODE = /```[\s\S]*?```|`[^`\n]+`/g;
const PLACEHOLDER = /(\d+)/g;

function convertProse(text: string): string {
  return (
    text
      // Horizontal rules (---, ***, ___) carry no meaning in a chat bubble.
      .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
      // [text](url) / ![alt](url) → "text url"; sanitizeReply judges the url.
      .replace(/!?\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 $2')
      // List markers at line start → "• " (indentation kept).
      .replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ')
      // ***x*** and **x** → *x* (a delimiter never touches another *).
      .replace(/(?<!\*)\*\*\*(?![\s*])([^\n]*?[^\s*])\*\*\*(?!\*)/g, '*$1*')
      .replace(/(?<!\*)\*\*(?![\s*])([^\n]*?[^\s*])\*\*(?!\*)/g, '*$1*')
      // __x__ → _x_ only at word boundaries (snake__case stays).
      .replace(/(?<![\p{L}\p{N}_])__(?![\s_])([^\n]*?[^\s_])__(?![\p{L}\p{N}_])/gu, '_$1_')
      // ~~x~~ → ~x~ (a single ~ meaning "about" stays).
      .replace(/(?<!~)~~(?![\s~])([^\n]*?[^\s~])~~(?!~)/g, '~$1~')
      // # Heading → *Heading*, unless it already carries bold.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gm, (_m, inner: string) =>
        inner.includes('*') ? inner : `*${inner}*`,
      )
  );
}

export function toWhatsAppFormatting(text: string): string {
  const input = text.replace(SENTINELS, '');
  const code: string[] = [];
  const masked = input.replace(CODE, (m) => `${OPEN}${code.push(m) - 1}${CLOSE}`);
  return convertProse(masked).replace(PLACEHOLDER, (_m, i: string) => code[Number(i)]);
}
