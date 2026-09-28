// Class merging for DS components. Plain twMerge does not know the custom ds-* utilities and can
// misread `text-ds-ink` as a font size, silently dropping `text-[15px]`. Registering the ds names in
// the theme groups (tailwind-merge 3.x `extend.theme`, DefaultThemeGroupIds 'color'/'radius'/'shadow')
// puts each utility in its proper class group. Keep in sync with the @theme block in tailwind.css
// (tests/ds-cn.test.ts checks every --color-ds-* token).
import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const DS_COLORS = [
  'ds-primary', 'ds-primary-hover', 'ds-accent', 'ds-on-primary', 'ds-ink', 'ds-ink-muted', 'ds-ink-subtle',
  'ds-ink-faint', 'ds-nav-bg', 'ds-ground', 'ds-surface', 'ds-tint', 'ds-border', 'ds-border-strong',
  'ds-border-input', 'ds-cta-whatsapp', 'ds-cta-whatsapp-hover', 'ds-on-whatsapp', 'ds-icon-bg', 'ds-icon-ink',
  'ds-icon-ring', 'ds-success-bg', 'ds-success-border', 'ds-success-ink', 'ds-danger-bg', 'ds-danger-border',
  'ds-danger-ink', 'ds-warning-ink', 'ds-focus-ring',
];

// `ds-primary` is both a colour and a shadow name, and Tailwind compiles `shadow-ds-primary` to the
// SHADOW (box-shadow: var(--ds-shadow-primary)). In tailwind-merge the last class group registering a
// literal wins, and the colour-fed `shadow-color` group comes after `shadow`, so the ds shadows get
// their own group, appended last, that conflicts both ways with `shadow`.
const DS_SHADOWS = ['ds-cta', 'ds-primary', 'ds-pop'];

const twMergeDs = extendTailwindMerge<'ds-shadow'>({
  extend: {
    theme: {
      color: DS_COLORS,
      radius: ['ds-card', 'ds-inner', 'ds-focus'],
    },
    classGroups: { 'ds-shadow': [{ shadow: DS_SHADOWS }] },
    conflictingClassGroups: { 'ds-shadow': ['shadow'], shadow: ['ds-shadow'] },
  },
});

export function dsCn(...inputs: ClassValue[]): string {
  return twMergeDs(clsx(inputs));
}
