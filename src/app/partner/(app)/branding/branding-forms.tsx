'use client';

import { useActionState, useState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input } from '@/components/ds';
import { SUPPORT_CONTACT_MAX } from '@/lib/partner-branding';
import type { ActionResult } from '../../action-result';
import { saveLogoAction, saveSupportContactAction, saveThemeAction, type ThemeActionResult } from './actions';

// The three Branding forms (UI redesign M3-17). Plain <form action>s: nothing here is trusted. The
// server actions re-gate, take the tenant from the session and validate every value (colour format
// + contrast, logo type + magic bytes + size, the support-contact rules). Client-side attributes
// (pattern, accept, maxLength) are conveniences only. Errors are the server's fixed copy.

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';

function Status({ state }: { state: { ok: boolean; error?: string } | null }) {
  return (
    <div aria-live="polite">
      {state?.ok === true ? (
        <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
          {t('partner.branding.saved')}
        </p>
      ) : null}
      {state && state.ok === false && state.error ? (
        <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

function SaveButton({ pending, label }: { pending: boolean; label?: string }) {
  return (
    <Button type="submit" size="md" disabled={pending}>
      {pending ? t('partner.branding.saving') : (label ?? t('partner.branding.save'))}
    </Button>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A colour: the native picker and a text box, kept in step. Only the text box is submitted. */
function ColorField({ name, label, initial, error }: { name: 'primaryColor' | 'accentColor'; label: string; initial: string; error?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <Field name={name} label={label} hint={t('partner.branding.colorHint')} error={error}>
      {(ids) => (
        <div className="flex items-center gap-3">
          <input
            type="color"
            aria-label={label}
            value={HEX.test(value) ? value.toLowerCase() : initial}
            onChange={(e) => setValue(e.target.value)}
            className={`h-[46px] w-14 shrink-0 cursor-pointer rounded-ds-inner border border-ds-border-input bg-ds-surface p-1 ${FOCUS}`}
          />
          <Input
            id={ids.id}
            name={name}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-describedby={ids.describedBy}
            invalid={ids.invalid}
            required
            maxLength={7}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </div>
      )}
    </Field>
  );
}

async function submitTheme(_prev: ThemeActionResult | null, formData: FormData): Promise<ThemeActionResult | null> {
  return saveThemeAction(formData);
}

export function ThemeForm({ primary, accent }: { primary: string; accent: string }) {
  const [state, formAction, pending] = useActionState(submitTheme, null);
  const fieldError = (f: 'primaryColor' | 'accentColor') => (state && state.ok === false && state.field === f ? state.error : undefined);
  // A field error shows under its field; anything else (saved, not found, failed) shows here.
  const formStatus = state && state.ok === false && state.field ? null : state;
  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="branding-theme-form">
      <div className="grid gap-4 sm:grid-cols-2">
        <ColorField name="primaryColor" label={t('partner.branding.primaryLabel')} initial={primary} error={fieldError('primaryColor')} />
        <ColorField name="accentColor" label={t('partner.branding.accentLabel')} initial={accent} error={fieldError('accentColor')} />
      </div>
      <div>
        <SaveButton pending={pending} />
      </div>
      <Status state={formStatus} />
    </form>
  );
}

async function submitLogo(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return saveLogoAction(formData);
}

export function LogoForm() {
  const [state, formAction, pending] = useActionState(submitLogo, null);
  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="branding-logo-form">
      <Field name="logo" label={t('partner.branding.logoLabel')}>
        {(ids) => (
          <input
            id={ids.id}
            name="logo"
            type="file"
            required
            accept="image/png,image/jpeg,image/webp"
            aria-describedby={ids.describedBy}
            className={`block w-full min-w-0 rounded-ds-inner border border-ds-border-input bg-ds-surface px-3 py-2.5 text-[14px] text-ds-ink file:mr-3 file:rounded-full file:border-0 file:bg-ds-tint file:px-3 file:py-1.5 file:font-semibold file:text-ds-ink ${FOCUS}`}
          />
        )}
      </Field>
      <div>
        <SaveButton pending={pending} label={t('partner.branding.logoUpload')} />
      </div>
      <Status state={state} />
    </form>
  );
}

async function submitContact(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return saveSupportContactAction(formData);
}

export function ContactForm({ current }: { current: string }) {
  const [state, formAction, pending] = useActionState(submitContact, null);
  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="branding-contact-form">
      <Field name="supportContact" label={t('partner.branding.contactLabel')} hint={t('partner.branding.contactHint')}>
        {(ids) => (
          <Input
            id={ids.id}
            name="supportContact"
            defaultValue={current}
            aria-describedby={ids.describedBy}
            required
            maxLength={SUPPORT_CONTACT_MAX}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </Field>
      <div>
        <SaveButton pending={pending} />
      </div>
      <Status state={state} />
    </form>
  );
}
