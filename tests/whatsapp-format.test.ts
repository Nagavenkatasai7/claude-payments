import { describe, it, expect } from 'vitest';
import { toWhatsAppFormatting } from '@/lib/whatsapp-format';

// WhatsApp formatting is *bold*, _italic_, ~strike~, ```mono``` — not
// CommonMark. The bot's model writes CommonMark, so the WhatsApp channel
// converts its reply before sanitizeReply runs.

describe('toWhatsAppFormatting', () => {
  it('converts the live quote reply (CommonMark bold + "- " list) to WhatsApp form', () => {
    const md =
      "Here's your quote for **$100.00 USD** to India 🇮🇳:\n\n- **Fee:** $1.99\n- **Exchange rate:** 1 USD = 96.25 INR\n- **Mom gets:** ₹9,625.00";
    expect(toWhatsAppFormatting(md)).toBe(
      "Here's your quote for *$100.00 USD* to India 🇮🇳:\n\n• *Fee:* $1.99\n• *Exchange rate:* 1 USD = 96.25 INR\n• *Mom gets:* ₹9,625.00",
    );
  });

  it('**x** → *x*, ***x*** → *x*, several on one line', () => {
    expect(toWhatsAppFormatting('**Fee:** $1.99 and **ETA:** 1 day')).toBe('*Fee:* $1.99 and *ETA:* 1 day');
    expect(toWhatsAppFormatting('***Important***')).toBe('*Important*');
  });

  it('__x__ → _x_ only at word boundaries; snake_case and __init__-style words are untouched', () => {
    expect(toWhatsAppFormatting('__note__ this')).toBe('_note_ this');
    expect(toWhatsAppFormatting('tx__id__x and my_var')).toBe('tx__id__x and my_var');
  });

  it('~~x~~ → ~x~; a single ~ ("about") is untouched', () => {
    expect(toWhatsAppFormatting('~~old~~ new, about ~₹9,625')).toBe('~old~ new, about ~₹9,625');
  });

  it('line-start "- " / "* " / "+ " list markers become "• " (indent kept); numbered lists stay', () => {
    expect(toWhatsAppFormatting('- one\n* two\n+ three\n  - nested\n1. first')).toBe(
      '• one\n• two\n• three\n  • nested\n1. first',
    );
  });

  it('a hyphen or minus that is not a list marker is untouched', () => {
    expect(toWhatsAppFormatting('Fee - $1.99\n-5 degrees\nwell-known')).toBe('Fee - $1.99\n-5 degrees\nwell-known');
  });

  it('### Heading → *Heading*; a heading that already carries bold is not double-wrapped', () => {
    expect(toWhatsAppFormatting('### Your quote\nbody')).toBe('*Your quote*\nbody');
    expect(toWhatsAppFormatting('# Title #')).toBe('*Title*');
    expect(toWhatsAppFormatting('## **Quote**')).toBe('*Quote*');
    expect(toWhatsAppFormatting('#hashtag and no space')).toBe('#hashtag and no space');
  });

  it('horizontal rules are dropped', () => {
    expect(toWhatsAppFormatting('a\n---\nb\n***\nc')).toBe('a\n\nb\n\nc');
  });

  it('[t](url) → "t url" so sanitizeReply alone decides the URL', () => {
    expect(toWhatsAppFormatting('Pay [here](https://x.example/p) now')).toBe('Pay here https://x.example/p now');
    expect(toWhatsAppFormatting('![logo](https://x.example/l.png)')).toBe('logo https://x.example/l.png');
  });

  it('masked accounts (****last4) are never mangled', () => {
    expect(toWhatsAppFormatting('To: account ****6789')).toBe('To: account ****6789');
    expect(toWhatsAppFormatting('****6789 and ****4321')).toBe('****6789 and ****4321');
    expect(toWhatsAppFormatting('**To:** account ****6789')).toBe('*To:* account ****6789');
    expect(toWhatsAppFormatting('- **To:** account ****6789')).toBe('• *To:* account ****6789');
    expect(toWhatsAppFormatting('****6789')).toBe('****6789');
  });

  it('already-WhatsApp text is unchanged (no double conversion; idempotent)', () => {
    const wa = '*Fee:* $1.99\n• _note_ ~old~\n```mono```';
    expect(toWhatsAppFormatting(wa)).toBe(wa);
    const md = '- **Fee:** $1.99\n### Head\n~~x~~ __y__';
    const once = toWhatsAppFormatting(md);
    expect(toWhatsAppFormatting(once)).toBe(once);
  });

  it('nothing inside ``` fences or `inline code` changes', () => {
    const fenced = 'See:\n```\n- **raw**\n### not a heading\n```\n- **x**';
    expect(toWhatsAppFormatting(fenced)).toBe('See:\n```\n- **raw**\n### not a heading\n```\n• *x*');
    expect(toWhatsAppFormatting('Type `**TX-1**` then **go**')).toBe('Type `**TX-1**` then *go*');
  });

  it('amounts, emoji and plain text are untouched', () => {
    for (const t of ['$1.99', '₹9,625', '1 USD = 96.25 INR', 'Thanks ❤️ 👍🏽', 'Family 👨‍👩‍👧', 'Rs.500 fee', '5 * 3 = 15', 'a*b*c', '']) {
      expect(toWhatsAppFormatting(t), t).toBe(t);
    }
  });

  it('private-use sentinel characters in the input cannot corrupt the output', () => {
    expect(toWhatsAppFormatting('x0 **y** `z`')).toBe('x0 *y* `z`');
  });
});
