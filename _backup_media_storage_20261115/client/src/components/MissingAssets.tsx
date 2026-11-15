import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../api/client';

/**
 * Owner-facing warning when uploaded images referenced by the restaurant (logo, banners, dish photos) are
 * missing from the server storage. Read-only: nothing is replaced; the owner re-uploads or restores from backup.
 */
export function MissingAssets({ kinds }: { kinds?: ('branding' | 'category' | 'product')[] }) {
  const [missing, setMissing] = useState<{ kind: string; label: string; url: string }[]>([]);
  useEffect(() => {
    api.get('/api/staff/tenant/asset-check').then((r) => setMissing(r.missing ?? [])).catch(() => setMissing([]));
  }, []);
  const shown = kinds ? missing.filter((m) => kinds.includes(m.kind as any)) : missing;
  if (!shown.length) return null;
  const label = (m: { kind: string; label: string }) => (m.kind === 'branding' ? ({ logoUrl: 'Logo', heroUrl: 'Homepage banner', coverUrl: 'Cover image', faviconUrl: 'Browser icon' } as Record<string, string>)[m.label] ?? m.label : `${m.kind === 'product' ? 'Dish' : 'Category'} photo: ${m.label}`);
  return (
    <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="alert">
      <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" /> {shown.length} uploaded image{shown.length === 1 ? ' is' : 's are'} missing from the server</p>
      <p className="mt-1 text-xs">Your settings still point to these files, but the files themselves are no longer in the server's upload folder (this happens when a redeploy replaces it). Re-upload them below, or restore the upload folder from a backup.</p>
      <ul className="mt-2 list-disc ps-5 text-xs">{shown.slice(0, 12).map((m) => <li key={m.url}>{label(m)}</li>)}</ul>
      {shown.length > 12 && <p className="mt-1 text-xs">…and {shown.length - 12} more</p>}
    </div>
  );
}
