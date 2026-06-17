'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { MAX_LOGO_LEN } from '@/lib/logo';

// Direct logo UPLOAD: the chosen image is read in the browser as a base64 data
// URI and carried in the existing `logoUrl` field (the CSP already allows
// `img-src data:`, so it renders on the pay page with no storage infra). Used in
// both the create wizard (controlled via onChange) and the edit form (uncontrolled
// — the hidden input named `logoUrl` is submitted in the server-action FormData).
const MAX_FILE_BYTES = 256 * 1024;

export function LogoUpload({
  name,
  defaultValue,
  onChange,
}: {
  name?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(defaultValue ?? '');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function commit(next: string) {
    setValue(next);
    onChange?.(next);
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file (PNG, JPG, SVG, …).');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError('Image is too large — keep it under 256 KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result || result.length > MAX_LOGO_LEN) {
        setError('Could not read that image — try a smaller file.');
        return;
      }
      setError('');
      commit(result);
    };
    reader.onerror = () => setError('Could not read that image.');
    reader.readAsDataURL(file);
  }

  function clear() {
    setError('');
    commit('');
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div className="space-y-2">
      {name && <input type="hidden" name={name} value={value} />}
      <div className="flex flex-wrap items-center gap-3">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={value}
            alt="Logo preview"
            className="h-10 max-w-[160px] rounded border border-border bg-white object-contain p-1"
          />
        ) : (
          <span className="text-xs text-muted-foreground">No logo yet</span>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          onChange={onFile}
          className="block text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-secondary/80"
        />
        {value && (
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            Remove
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">
        Upload a PNG, JPG, or SVG (max 256 KB) — shown on the partner&apos;s pay page.
      </p>
    </div>
  );
}
