import { useEffect, useRef, useState, type DragEvent } from 'react';
import { CloudUpload, ImagePlus, Link2, RefreshCw, Trash2, UploadCloud } from 'lucide-react';
import { api, assetUrl } from '../api/client';
import { Button, Input, useFeedback } from './ui';
import { cn } from '../lib/util';

/*
 * One image control for the whole admin (branding, dishes, categories). Three ways to add an image:
 *   1. Upload to Cloudinary   2. Upload to cloud storage (S3-compatible)   3. Use an existing https image URL
 * Uploads go through the server (credentials never reach the browser). The record changes only after the image
 * was stored and verified; on failure the current image stays as it is. Replacing or removing never destroys the
 * previous image (it is kept and can be restored from storage).
 */

type Purpose = 'branding' | 'product' | 'category' | 'other';
type Tab = 'cloudinary' | 's3' | 'url';
const ACCEPT = 'image/png,image/jpeg,image/webp,image/x-icon';
const MAX_MB = 5;

let statusPromise: Promise<any> | null = null;
/** Upload choices available on this server (cached for the page). */
export function storageChoices() {
  return (statusPromise ??= api.get('/api/staff/assets/storage').catch((e) => {
    statusPromise = null;
    throw e;
  }));
}

const PROVIDER_LABEL: Record<string, string> = { cloudinary: 'Cloudinary', s3: 'Cloud storage', local: 'Server folder', external: 'Linked image' };

/** Where the current image lives, for the small source line under the preview. */
function useSource(url?: string | null) {
  const [info, setInfo] = useState<any>(null);
  const id = url && /^\/media\/([a-f0-9]{24})$/.exec(url)?.[1];
  useEffect(() => {
    setInfo(null);
    if (id) api.get(`/api/staff/assets/${id}`).then(setInfo).catch(() => setInfo(null));
  }, [id]);
  return { info, reload: () => id && api.get(`/api/staff/assets/${id}`).then(setInfo).catch(() => undefined), legacy: !!url?.startsWith('/uploads/') };
}

export function ImageField({ label, url, purpose, onAttach, onRemove, hint, compact }: {
  label: string;
  url?: string | null;
  purpose: Purpose;
  /** Point the record at the new asset (resolves when saved). */
  onAttach: (assetId: string) => Promise<void>;
  onRemove?: () => Promise<void>;
  hint?: string;
  compact?: boolean;
}) {
  const fb = useFeedback();
  const [open, setOpen] = useState(!url && !compact);
  const [broken, setBroken] = useState(false);
  const src = useSource(url);
  useEffect(() => setBroken(false), [url]);

  const remove = async () => {
    if (!onRemove || !window.confirm(`Remove the ${label.toLowerCase()}? The image stays in storage and can be added back later.`)) return;
    try {
      await onRemove();
      fb.ok(`${label} removed`);
    } catch (e) {
      fb.fail(e);
    }
  };
  const importTo = async (provider: 'cloudinary' | 's3') => {
    try {
      await api.post(`/api/staff/assets/${src.info._id}/import`, { provider });
      await src.reload();
      fb.ok('A permanent copy is now stored; the image no longer depends on the original website');
    } catch (e) {
      fb.fail(e);
    }
  };

  return (
    <div className="min-w-0">
      <span className="label">{label}</span>
      {url ? (
        <div className="rounded-xl border border-stone-200 p-2">
          <div className="relative flex aspect-square max-h-48 w-full items-center justify-center overflow-hidden rounded-lg bg-stone-50">
            {broken ? (
              <p className="p-3 text-center text-xs text-red-700" role="alert">This image cannot be displayed. Replace it, or restore the file.</p>
            ) : (
              <img src={assetUrl(url)} alt="" className="h-full w-full object-cover" onError={() => setBroken(true)} />
            )}
          </div>
          <p className="mt-1.5 truncate text-[11px] text-stone-500" title={src.info?.key ?? url}>
            {src.legacy ? 'Server folder (old upload — migrate to permanent storage)' : src.info ? `${PROVIDER_LABEL[src.info.provider] ?? src.info.provider}${src.info.provider === 'external' ? ` · ${safeHost(src.info.key)}` : ''}` : url}
          </p>
          {src.info?.provider === 'external' && (
            <ImportActions onImport={importTo} />
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}><RefreshCw className="h-3.5 w-3.5" /> Replace</Button>
            {onRemove && <Button size="sm" variant="ghost" onClick={remove} aria-label={`Remove ${label}`}><Trash2 className="h-3.5 w-3.5" /> Remove</Button>}
          </div>
        </div>
      ) : (
        !open && <Button size="sm" variant="outline" onClick={() => setOpen(true)}><ImagePlus className="h-4 w-4" /> Add image</Button>
      )}
      {open && <AddImage purpose={purpose} label={label} onDone={async (id) => { await onAttach(id); setOpen(false); }} onCancel={url || compact ? () => setOpen(false) : undefined} />}
      {hint && <p className="mt-1 text-xs text-stone-500">{hint}</p>}
    </div>
  );
}

function ImportActions({ onImport }: { onImport: (p: 'cloudinary' | 's3') => void }) {
  const [s, setS] = useState<any>(null);
  useEffect(() => void storageChoices().then(setS).catch(() => undefined), []);
  if (!s?.cloudinary.configured && !s?.s3.configured) return <p className="mt-1 text-[11px] text-amber-700">Depends on the original website. Configure cloud storage to keep a permanent copy.</p>;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-amber-800">
      Depends on the original website.
      {s.cloudinary.configured && <button type="button" className="font-medium underline" onClick={() => onImport('cloudinary')}>Copy to Cloudinary</button>}
      {s.s3.configured && <button type="button" className="font-medium underline" onClick={() => onImport('s3')}>Copy to cloud storage</button>}
    </div>
  );
}

const safeHost = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/** The three-option "add image" panel. */
export function AddImage({ purpose, label, onDone, onCancel }: { purpose: Purpose; label: string; onDone: (assetId: string) => Promise<void>; onCancel?: () => void }) {
  const [status, setStatus] = useState<any>(null);
  const [statusError, setStatusError] = useState('');
  const [tab, setTab] = useState<Tab | null>(null);
  useEffect(() => {
    storageChoices()
      .then((s) => {
        setStatus(s);
        setTab(s.cloudinary.configured && (s.defaultProvider === 'cloudinary' || !s.s3.configured) ? 'cloudinary' : s.s3.configured ? 's3' : 'url');
      })
      .catch((e) => setStatusError(e.message));
  }, []);
  if (statusError) return <p className="mt-2 text-sm text-red-700">{statusError}</p>;
  if (!status || !tab) return <p className="mt-2 text-xs text-stone-500">Loading storage options…</p>;
  const tabs: { k: Tab; label: string; icon: any; ok: boolean; why?: string }[] = [
    { k: 'cloudinary', label: 'Upload to Cloudinary', icon: CloudUpload, ok: status.cloudinary.configured, why: 'Cloudinary is not configured yet (platform admin → Storage).' },
    { k: 's3', label: 'Upload to Cloud Storage', icon: UploadCloud, ok: status.s3.configured, why: 'S3-compatible cloud storage is not configured yet (platform admin → Storage).' },
    { k: 'url', label: 'Use an Existing Image URL', icon: Link2, ok: true },
  ];
  const current = tabs.find((t) => t.k === tab)!;
  return (
    <div className="mt-2 rounded-xl border border-stone-200 bg-white p-3">
      <div className="mb-3 grid gap-1 sm:grid-cols-3" role="tablist" aria-label={`${label}: image source`}>
        {tabs.map((t) => (
          <button key={t.k} type="button" role="tab" aria-selected={tab === t.k} onClick={() => setTab(t.k)} className={cn('flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-start text-xs font-medium transition', tab === t.k ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200', !t.ok && 'opacity-60')}>
            <t.icon className="h-3.5 w-3.5 shrink-0" /> {t.label}
          </button>
        ))}
      </div>
      {!current.ok ? (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" role="status">{current.why} Nothing will be uploaded until it is set up.</p>
      ) : tab === 'url' ? (
        <UrlForm purpose={purpose} label={label} onDone={onDone} />
      ) : (
        <FileForm provider={tab} purpose={purpose} label={label} onDone={onDone} />
      )}
      {onCancel && <div className="mt-2 text-end"><Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button></div>}
    </div>
  );
}

function FileForm({ provider, purpose, label, onDone }: { provider: 'cloudinary' | 's3'; purpose: Purpose; label: string; onDone: (id: string) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);
  const pick = (f?: File | null) => {
    setError('');
    if (!f) return;
    if (!ACCEPT.split(',').includes(f.type)) return setError('Choose a PNG, JPEG, WEBP or ICO image');
    if (f.size > MAX_MB * 1024 * 1024) return setError(`The image is larger than ${MAX_MB} MB`);
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    pick(e.dataTransfer.files?.[0]);
  };
  const send = async () => {
    if (!file) return;
    setError('');
    setProgress(0);
    try {
      const a = await api.uploadWithProgress('/api/staff/assets', file, { provider, purpose, label }, setProgress);
      await onDone(a._id);
      setFile(null);
    } catch (e: any) {
      setError(e?.message ?? 'Upload failed');
    } finally {
      setProgress(null);
    }
  };
  return (
    <div>
      <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop} onClick={() => input.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        className={cn('flex min-h-[112px] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-3 text-center text-xs text-stone-500 transition', drag ? 'border-brand bg-brand/5' : 'border-stone-300 hover:border-brand')}>
        {preview ? <img src={preview} alt="" className="max-h-28 rounded object-contain" /> : <><UploadCloud className="h-6 w-6" /> Drop an image here or click to choose · PNG, JPEG, WEBP, ICO · up to {MAX_MB} MB</>}
        <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
      </div>
      {progress != null && (
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-stone-100" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-brand transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-700" role="alert">{error}. Your current image was not changed.</p>}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-stone-500">Storage: {PROVIDER_LABEL[provider]}</span>
        <Button size="sm" onClick={send} disabled={!file} loading={progress != null}>{progress != null ? `Uploading ${Math.round(progress * 100)}%` : 'Upload and use'}</Button>
      </div>
    </div>
  );
}

function UrlForm({ purpose, label, onDone }: { purpose: Purpose; label: string; onDone: (id: string) => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'broken' | 'invalid'>('idle');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setError('');
    if (!url.trim()) return setState('idle');
    try {
      const u = new URL(url.trim());
      setState(u.protocol === 'https:' ? 'loading' : 'invalid');
    } catch {
      setState('invalid');
    }
  }, [url]);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const a = await api.post('/api/staff/assets/external', { url: url.trim(), purpose, label });
      await onDone(a._id);
      setUrl('');
    } catch (e: any) {
      setError(e?.message ?? 'Could not save the image address');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/image.jpg" inputMode="url" aria-label="Image address" />
      {state === 'invalid' && <p className="text-xs text-red-700">Enter a full https:// image address.</p>}
      {(state === 'loading' || state === 'ok' || state === 'broken') && (
        <div className="flex h-28 items-center justify-center overflow-hidden rounded-lg bg-stone-50">
          {state === 'broken' ? <p className="p-2 text-center text-xs text-red-700" role="alert">This address cannot be displayed as an image. Check the link.</p> : (
            <img src={url.trim()} alt="Preview" referrerPolicy="no-referrer" className="max-h-28 object-contain" onLoad={() => setState('ok')} onError={() => setState('broken')} />
          )}
        </div>
      )}
      <p className="text-[11px] text-stone-500">The image stays on its original website. If that website removes or changes it, it will disappear here too; copy it to permanent storage afterwards to keep it.</p>
      {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
      <div className="text-end"><Button size="sm" onClick={save} disabled={state !== 'ok'} loading={busy}>Use this image</Button></div>
    </div>
  );
}
