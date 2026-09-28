import { describe, it, expect } from 'vitest';
import { loginMenuReducer, type LoginMenuState } from '@/lib/ui/login-menu';

const closed: LoginMenuState = { open: false, focusTrigger: false };
const open: LoginMenuState = { open: true, focusTrigger: false };

describe('loginMenuReducer (disclosure pattern for the site header Log in menu)', () => {
  it('toggle opens a closed menu and closes an open one, never moving focus', () => {
    expect(loginMenuReducer(closed, { type: 'toggle' })).toEqual(open);
    expect(loginMenuReducer(open, { type: 'toggle' })).toEqual(closed);
  });
  it('Escape closes an open menu and returns focus to the trigger', () => {
    expect(loginMenuReducer(open, { type: 'escape' })).toEqual({ open: false, focusTrigger: true });
  });
  it('Escape on a closed menu is a no-op (focus is not stolen)', () => {
    expect(loginMenuReducer(closed, { type: 'escape' })).toBe(closed);
  });
  it('focus or a pointer-down outside closes without moving focus', () => {
    expect(loginMenuReducer(open, { type: 'focusOutside' })).toEqual(closed);
    expect(loginMenuReducer(open, { type: 'pointerOutside' })).toEqual(closed);
  });
  it('outside events on a closed menu return the same state (no re-render)', () => {
    expect(loginMenuReducer(closed, { type: 'focusOutside' })).toBe(closed);
    expect(loginMenuReducer(closed, { type: 'pointerOutside' })).toBe(closed);
  });
  it('focusHandled clears the one-shot focus request', () => {
    expect(loginMenuReducer({ open: false, focusTrigger: true }, { type: 'focusHandled' })).toEqual(closed);
    expect(loginMenuReducer(closed, { type: 'focusHandled' })).toBe(closed);
  });
});
