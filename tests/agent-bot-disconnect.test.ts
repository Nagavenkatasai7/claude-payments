import { describe, it, expect, vi } from 'vitest';
import {
  DISCONNECT_APPS_FAILED_REPLY,
  disconnectAllAgentApps,
  disconnectAppsReply,
  isDisconnectAppsCommand,
} from '@/lib/agent-auth/bot-disconnect';
import type { AgentPortal } from '@/lib/agent-auth/portal-apps';

// Stage C2: the bot command "disconnect apps" ends every AI-app connection of the customer
// (the chat side of the portal's Connected AI apps page).

describe('isDisconnectAppsCommand (whole message, exact words)', () => {
  it.each(['disconnect apps', 'Disconnect Apps', '  disconnect   apps  ', 'disconnect ai apps', 'DISCONNECT AI APPS', 'disconnect all apps', 'disconnect apps.'])(
    '%j is the command',
    (t) => expect(isDisconnectAppsCommand(t)).toBe(true),
  );
  it.each(['disconnect', 'apps', 'please disconnect apps now', 'disconnect my bank', 'how do I disconnect apps?', '', 'stop'])(
    '%j is not',
    (t) => expect(isDisconnectAppsCommand(t)).toBe(false),
  );
});

function portal(grants: string[], revoke: (id: string) => boolean = () => true) {
  const disconnect = vi.fn(async (_p: string, _phone: string, id: unknown) => revoke(String(id)));
  const list = vi.fn(async () => grants.map((id) => ({ id, clientName: 'Claude', createdAt: new Date(), lastUsedAt: null })));
  return { p: { list, disconnect, visible: async () => true } as unknown as AgentPortal, list, disconnect };
}

describe('disconnectAllAgentApps', () => {
  it("revokes every live grant of the customer, in the customer's own tenant", async () => {
    const { p, list, disconnect } = portal(['agg_a', 'agg_b']);
    expect(await disconnectAllAgentApps(p, 'default', '14155550101')).toBe(2);
    expect(list).toHaveBeenCalledWith('default', '14155550101');
    expect(disconnect.mock.calls).toEqual([
      ['default', '14155550101', 'agg_a'],
      ['default', '14155550101', 'agg_b'],
    ]);
  });
  it('counts only the grants it actually revoked', async () => {
    const { p } = portal(['agg_a', 'agg_b'], (id) => id === 'agg_b');
    expect(await disconnectAllAgentApps(p, 'default', '14155550101')).toBe(1);
  });
  it('no grants → 0, nothing revoked', async () => {
    const { p, disconnect } = portal([]);
    expect(await disconnectAllAgentApps(p, 'default', '14155550101')).toBe(0);
    expect(disconnect).not.toHaveBeenCalled();
  });
});

describe('disconnectAppsReply', () => {
  it('none', () => expect(disconnectAppsReply(0)).toBe('No AI apps are connected to your SmartRemit account.'));
  it('one', () => expect(disconnectAppsReply(1)).toBe('Done. 1 AI app is disconnected. It can no longer use your SmartRemit account.'));
  it('many', () => expect(disconnectAppsReply(3)).toBe('Done. 3 AI apps are disconnected. They can no longer use your SmartRemit account.'));
  it('the failure reply sends the customer to the portal', () => expect(DISCONNECT_APPS_FAILED_REPLY).toMatch(/Connected AI apps/));
});
