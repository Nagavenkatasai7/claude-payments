import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { getDb } from '@/db/client';
import { activeKillSwitches } from '@/lib/flags';
import { killSwitchBannerLines } from '@/lib/flag-switch';

// Release safety part A: the red banner on every /admin-dashboard page while a
// kill switch is on. Renders nothing when every switch is off or the read fails
// (activeKillSwitches never throws). Fixed text + scope labels only.

export async function KillSwitchBanner() {
  const lines = killSwitchBannerLines(await activeKillSwitches(getDb()));
  if (lines.length === 0) return null;
  return (
    <div className="px-4 pt-3 min-[1025px]:px-6">
      <Alert role="alert" variant="destructive" className="border-destructive" data-testid="kill-switch-banner">
        <AlertTitle>A kill switch is on</AlertTitle>
        <AlertDescription>
          <ul className="list-disc pl-4">
            {lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          <Link href="/admin-dashboard/switches" className="underline underline-offset-2">Open Switches</Link>
        </AlertDescription>
      </Alert>
    </div>
  );
}
