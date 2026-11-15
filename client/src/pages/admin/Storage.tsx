import { useEffect, useState } from 'react';
import { CheckCircle2, HardDrive, ShieldAlert } from 'lucide-react';
import { api } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { Button, Card, ErrorState, Field, Input, Loading, PageHeader, Select, Toggle, useFeedback } from '../../components/ui';

/**
 * Platform storage settings: where uploaded images are kept permanently (outside the app deployment).
 * Secrets can be entered (stored encrypted on the server) but are never shown again or sent back to the browser.
 */
export default function Storage() {
  const fb = useFeedback();
  const { data, loading, error, reload } = useApi<any>('/api/platform/storage');
  const [def, setDef] = useState('');
  const [cld, setCld] = useState({ cloudName: '', apiKey: '', apiSecret: '', folder: 'tablesaas' });
  const [s3, setS3] = useState({ endpoint: '', region: '', bucket: '', accessKeyId: '', secretAccessKey: '', publicBaseUrl: '', forcePathStyle: true, privateBucket: false });
  const [busy, setBusy] = useState('');
  useEffect(() => {
    if (!data) return;
    setDef(data.config.defaultProvider ?? '');
    if (data.config.cloudinary) setCld({ ...data.config.cloudinary, apiSecret: '' });
    if (data.config.s3) setS3({ ...data.config.s3, secretAccessKey: '' });
  }, [data]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const st = data.status;
  const env = data.fromEnvironment;

  const run = async (key: string, fn: () => Promise<any>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      fb.ok(ok);
      reload();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy('');
    }
  };
  const saveCld = () => run('cld', () => api.put('/api/platform/storage', { cloudinary: { cloudName: cld.cloudName, apiKey: cld.apiKey, folder: cld.folder, ...(cld.apiSecret ? { apiSecret: cld.apiSecret } : {}) } }), 'Cloudinary settings saved');
  const saveS3 = () => run('s3', () => { const { secretAccessKey, ...rest } = s3; return api.put('/api/platform/storage', { s3: { ...rest, ...(secretAccessKey ? { secretAccessKey } : {}) } }); }, 'Cloud storage settings saved');
  const test = (provider: string) => run(`test-${provider}`, () => api.post('/api/platform/storage/test', { provider }), 'Connection works');

  return (
    <>
      <PageHeader icon={HardDrive} accent="brand" title="Storage" subtitle="Where logos, banners and dish photos are kept — permanently, independent of deployments" />
      <div className="grid gap-6 xl:grid-cols-2 [&>*]:min-w-0">
        <Card title="Status">
          <ul className="space-y-2 text-sm">
            <li className="flex items-center gap-2">{st.cloudinary.configured ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <ShieldAlert className="h-4 w-4 text-stone-400" />} Cloudinary: {st.cloudinary.configured ? `ready (${st.cloudinary.source === 'env' ? 'server environment' : 'saved here'})` : 'not configured'}</li>
            <li className="flex items-center gap-2">{st.s3.configured ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <ShieldAlert className="h-4 w-4 text-stone-400" />} Cloud storage (S3-compatible): {st.s3.configured ? `ready · ${st.s3.bucket} @ ${st.s3.endpointHost}` : 'not configured'}</li>
            <li className="flex items-center gap-2">{st.local.usable ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <ShieldAlert className="h-4 w-4 text-amber-600" />} Server folder: {st.local.usable ? (st.local.persistent ? 'persistent folder confirmed' : 'development only') : `not used — ${st.local.reason}`}</li>
          </ul>
          {!st.defaultProvider && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900" role="alert">No permanent storage is available, so image uploads are refused (they would be lost at the next deployment). Configure Cloudinary or cloud storage below. Linking existing https images still works.</p>}
          <Field label="New uploads go to" className="mt-4">
            <Select value={def} disabled={env.defaultProvider} onChange={(e) => setDef(e.target.value)}>
              <option value="">Automatic (Cloudinary, then cloud storage)</option>
              <option value="cloudinary" disabled={!st.cloudinary.configured}>Cloudinary</option>
              <option value="s3" disabled={!st.s3.configured}>Cloud storage (S3-compatible)</option>
              <option value="local" disabled={!st.local.usable}>Server folder</option>
            </Select>
          </Field>
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-xs text-stone-500">Changing this does not move existing images; each keeps working where it is. Use the migration command to copy them.</p>
            <Button size="sm" onClick={() => run('def', () => api.put('/api/platform/storage', { defaultProvider: def }), 'Default storage saved')} loading={busy === 'def'} disabled={env.defaultProvider}>Save</Button>
          </div>
        </Card>

        <Card title="Cloudinary">
          {env.cloudinary ? <p className="text-sm text-stone-600">Configured in the server environment (CLOUDINARY_*). Change it there.</p> : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Cloud name"><Input value={cld.cloudName} onChange={(e) => setCld({ ...cld, cloudName: e.target.value })} autoComplete="off" /></Field>
              <Field label="API key"><Input value={cld.apiKey} onChange={(e) => setCld({ ...cld, apiKey: e.target.value })} autoComplete="off" /></Field>
              <Field label="API secret" hint={data.config.cloudinary?.hasSecret ? 'Saved — leave empty to keep it' : 'Stored encrypted; never shown again'}><Input type="password" value={cld.apiSecret} onChange={(e) => setCld({ ...cld, apiSecret: e.target.value })} autoComplete="new-password" /></Field>
              <Field label="Folder"><Input value={cld.folder} onChange={(e) => setCld({ ...cld, folder: e.target.value })} /></Field>
            </div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="outline" onClick={() => test('cloudinary')} loading={busy === 'test-cloudinary'} disabled={!st.cloudinary.configured}>Test connection</Button>
            {!env.cloudinary && <Button onClick={saveCld} loading={busy === 'cld'} disabled={!cld.cloudName || !cld.apiKey}>Save</Button>}
          </div>
        </Card>

        <Card title="Cloud storage (S3-compatible)" className="xl:col-span-2">
          {env.s3 ? <p className="text-sm text-stone-600">Configured in the server environment (S3_*). Change it there.</p> : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Endpoint" hint="AWS: https://s3.<region>.amazonaws.com · R2: https://<account>.r2.cloudflarestorage.com · B2: https://s3.<region>.backblazeb2.com" className="sm:col-span-3"><Input value={s3.endpoint} onChange={(e) => setS3({ ...s3, endpoint: e.target.value })} placeholder="https://…" /></Field>
                <Field label="Region" hint='"auto" for Cloudflare R2'><Input value={s3.region} onChange={(e) => setS3({ ...s3, region: e.target.value })} /></Field>
                <Field label="Bucket"><Input value={s3.bucket} onChange={(e) => setS3({ ...s3, bucket: e.target.value })} /></Field>
                <Field label="Public / CDN base URL" hint="Optional. Empty + private bucket = short-lived signed links"><Input value={s3.publicBaseUrl} onChange={(e) => setS3({ ...s3, publicBaseUrl: e.target.value })} placeholder="https://images.example.com" /></Field>
                <Field label="Access key ID"><Input value={s3.accessKeyId} onChange={(e) => setS3({ ...s3, accessKeyId: e.target.value })} autoComplete="off" /></Field>
                <Field label="Secret access key" hint={data.config.s3?.hasSecret ? 'Saved — leave empty to keep it' : 'Stored encrypted; never shown again'}><Input type="password" value={s3.secretAccessKey} onChange={(e) => setS3({ ...s3, secretAccessKey: e.target.value })} autoComplete="new-password" /></Field>
              </div>
              <div className="mt-3 flex flex-wrap gap-6">
                <Toggle checked={s3.forcePathStyle} onChange={(forcePathStyle) => setS3({ ...s3, forcePathStyle })} label="Path-style addressing (R2, B2, MinIO)" />
                <Toggle checked={s3.privateBucket} onChange={(privateBucket) => setS3({ ...s3, privateBucket })} label="Private bucket (serve through signed links)" />
              </div>
            </>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="outline" onClick={() => test('s3')} loading={busy === 'test-s3'} disabled={!st.s3.configured}>Test connection</Button>
            {!env.s3 && <Button onClick={saveS3} loading={busy === 's3'} disabled={!s3.endpoint || !s3.bucket || !s3.accessKeyId}>Save</Button>}
          </div>
          <p className="mt-3 text-xs text-stone-500">Recommended protection on the bucket: enable object versioning, give the access key upload/read permissions only (no delete), and no lifecycle expiry rules. See docs/STORAGE_AND_BACKUP.md.</p>
        </Card>

        <Card title="Move existing images" className="xl:col-span-2">
          <p className="text-sm text-stone-600">Copy old uploads (server folder) or images on another provider into permanent storage. Each copy is downloaded back and checksum-verified before any record changes; originals are never deleted; missing files are reported.</p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-stone-900 p-3 text-xs text-stone-100">{`npm --prefix server run assets:migrate -- --to cloudinary --dry-run
npm --prefix server run assets:migrate -- --to cloudinary --report migration-report.json
# switch provider for images already in permanent storage (addresses stay the same):
npm --prefix server run assets:migrate -- --to s3 --assets`}</pre>
        </Card>
      </div>
    </>
  );
}
