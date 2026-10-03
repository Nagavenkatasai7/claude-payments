import { describe, it, expect } from 'vitest';
import { shellChannelBanner } from '@/lib/partner-shell-health';
import type { ChannelHealthSummary } from '@/lib/channel-health';

// Lost-features p3 B12: the WhatsApp health strip on every /partner page. Pure: a level and whether
// the viewer gets the "Fix it" link. No free text: the shell renders fixed copy, never the English
// item messages (which can name config fields or codes).
const sum = (level: ChannelHealthSummary['level']): ChannelHealthSummary => ({
  level,
  items: level === 'ok' ? [] : [{ kind: 'dead_send', level: level === 'error' ? 'error' : 'warn', message: 'raw message code 131047', count: 3 }],
});

describe('shellChannelBanner', () => {
  it('nothing when the channel is ok', () => {
    for (const role of ['admin', 'agent', 'support', 'finance'] as const) expect(shellChannelBanner(sum('ok'), role)).toBeNull();
  });

  it('warn and error map to their level; only admins get the link', () => {
    expect(shellChannelBanner(sum('error'), 'admin')).toEqual({ level: 'error', link: true });
    expect(shellChannelBanner(sum('warn'), 'admin')).toEqual({ level: 'warn', link: true });
    for (const role of ['agent', 'support', 'finance'] as const) {
      expect(shellChannelBanner(sum('error'), role)).toEqual({ level: 'error', link: false });
    }
  });

  it('carries no message text, count or code', () => {
    const json = JSON.stringify(shellChannelBanner(sum('error'), 'admin'));
    expect(json).not.toMatch(/raw message|131047|dead_send/);
  });
});
