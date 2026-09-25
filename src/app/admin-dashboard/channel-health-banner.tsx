import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { ChannelBannerModel } from '@/lib/channel-health';

// R2a: the partner-visible WhatsApp channel banner (the partner page header and,
// for partner staff, the dashboard layout). Renders nothing when the channel is
// healthy. Fixed text + kinds/counts/Meta codes only — never a token or phone.
export function ChannelHealthBanner({ model, showLink = false }: { model: ChannelBannerModel | null; showLink?: boolean }) {
  if (!model) return null;
  return (
    <Alert role="status" variant={model.variant} className="mb-4" data-testid="channel-health-banner">
      <AlertTitle>{model.title}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {model.lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
        {showLink && (
          <Link href={model.href} className="underline">
            Open the partner settings
          </Link>
        )}
      </AlertDescription>
    </Alert>
  );
}
