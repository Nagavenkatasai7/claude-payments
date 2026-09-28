// State for the site header's "Log in" disclosure (src/components/site/LoginMenu.tsx).
// Pure: the component holds it in useReducer. It follows the WAI-ARIA disclosure pattern
// (a button with aria-expanded that shows a list of links), not the menu pattern, so there
// is no arrow-key roving focus to promise. Escape closes and sends focus back to the button;
// focus or a pointer-down outside closes without moving focus.
export type LoginMenuState = { open: boolean; focusTrigger: boolean };
export type LoginMenuEvent =
  | { type: 'toggle' }
  | { type: 'escape' }
  | { type: 'focusOutside' }
  | { type: 'pointerOutside' }
  | { type: 'focusHandled' };

export const LOGIN_MENU_CLOSED: LoginMenuState = { open: false, focusTrigger: false };

export function loginMenuReducer(state: LoginMenuState, ev: LoginMenuEvent): LoginMenuState {
  switch (ev.type) {
    case 'toggle':
      return { open: !state.open, focusTrigger: false };
    case 'escape':
      return state.open ? { open: false, focusTrigger: true } : state;
    case 'focusOutside':
    case 'pointerOutside':
      return state.open ? { open: false, focusTrigger: false } : state;
    case 'focusHandled':
      return state.focusTrigger ? { ...state, focusTrigger: false } : state;
  }
}
