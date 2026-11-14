import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Archive, ImagePlus, Pencil, Plus, Star, Trash2, X, ArchiveRestore } from 'lucide-react';
import { api, assetUrl, qs } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { useAuth } from '../../store/auth';
import { Badge, Button, Card, Empty, ErrorState, Field, Input, Loading, Modal, PageHeader, Select, Tabs, Textarea, Toggle, useFeedback } from '../../components/ui';
import { cn, formatMoney, toLocalInputValue, toMajor, toMinor } from '../../lib/util';
import { UtensilsCrossed as HeaderIcon } from 'lucide-react';

type Lang = 'en' | 'ur' | 'ar';
const LANGS: { k: Lang; label: string }[] = [{ k: 'en', label: 'English' }, { k: 'ur', label: 'اردو' }, { k: 'ar', label: 'العربية' }];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function MenuPage() {
  const fb = useFeedback();
  const { tenant } = useAuth();
  const dec = tenant?.settings?.currencyDecimals ?? 2;
  const money = (n: number) => formatMoney(n, tenant?.settings?.currency, dec);
  const cats = useApi<{ items: any[] }>('/api/staff/menu/categories');
  const stations = useApi<{ items: any[] }>('/api/staff/menu/stations?limit=100');
  const [selected, setSelected] = useState<string>('');
  const [archived, setArchived] = useState(false);
  const products = useApi<{ items: any[] }>(`/api/staff/menu/products${qs({ categoryId: selected, archived: archived ? 'true' : 'false', limit: 200 })}`);
  const [editCat, setEditCat] = useState<any | null>(null);
  const [editProd, setEditProd] = useState<any | null>(null);
  const [stationModal, setStationModal] = useState(false);

  const tree = useMemo(() => {
    const all = cats.data?.items ?? [];
    const top = all.filter((c) => !c.parentId);
    return top.map((c) => ({ ...c, children: all.filter((s) => s.parentId === c._id) }));
  }, [cats.data]);

  const move = async (id: string, dir: -1 | 1) => {
    const ids = (cats.data?.items ?? []).map((c) => c._id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try {
      await api.post('/api/staff/menu/categories/reorder', { ids });
      cats.reload();
    } catch (e) {
      fb.fail(e);
    }
  };

  const delCat = async (c: any) => {
    if (!(await fb.confirm({ title: `Delete “${c.name.en}”?`, body: 'Only empty categories can be deleted.', danger: true, confirmLabel: 'Delete' }))) return;
    try {
      await api.del(`/api/staff/menu/categories/${c._id}`);
      if (selected === c._id) setSelected('');
      cats.reload();
      fb.ok('Category deleted');
    } catch (e) {
      fb.fail(e);
    }
  };

  const quick = async (p: any, patch: Record<string, unknown>, msg: string) => {
    try {
      await api.patch(`/api/staff/menu/products/${p._id}`, patch);
      products.reload();
      fb.ok(msg);
    } catch (e) {
      fb.fail(e);
    }
  };

  if (cats.loading && !cats.data) return <Loading />;
  if (cats.error) return <ErrorState message={cats.error} onRetry={cats.reload} />;

  return (
    <>
      <PageHeader icon={HeaderIcon} accent="emerald"
        title="Menu"
        subtitle="Categories, dishes, prices and availability — changes go live immediately"
        actions={
          <>
            <Button variant="outline" onClick={() => setStationModal(true)}>Kitchen stations</Button>
            <Button variant="outline" onClick={() => setEditCat({ name: { en: '' }, isActive: true, schedule: { days: [] } })}><Plus className="h-4 w-4" /> Category</Button>
            <Button onClick={() => setEditProd(blankProduct(selected || tree[0]?._id))} disabled={!tree.length}><Plus className="h-4 w-4" /> Dish</Button>
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[280px_1fr] [&>*]:min-w-0">
        <Card pad={false} className="h-fit">
          <ul className="p-2">
            <li>
              <button onClick={() => setSelected('')} className={cn('w-full rounded-lg px-3 py-2 text-start text-sm', !selected ? 'bg-stone-900 text-white' : 'hover:bg-stone-100')}>All dishes</button>
            </li>
            {tree.map((c) => (
              <li key={c._id}>
                <CatRow c={c} selected={selected} onSelect={setSelected} onEdit={setEditCat} onDelete={delCat} onMove={move} />
                {c.children.map((s: any) => (
                  <div key={s._id} className="ps-4"><CatRow c={s} selected={selected} onSelect={setSelected} onEdit={setEditCat} onDelete={delCat} onMove={move} /></div>
                ))}
              </li>
            ))}
          </ul>
          {!tree.length && <Empty title="No categories" hint="Create your first category, e.g. Starters." />}
        </Card>

        <div>
          <div className="mb-4">
            <Tabs value={archived ? 'archived' : 'live'} onChange={(v) => setArchived(v === 'archived')} items={[{ value: 'live', label: 'Live menu' }, { value: 'archived', label: 'Archived' }]} />
          </div>
          {products.loading && !products.data ? <Loading /> : products.error ? <ErrorState message={products.error} onRetry={products.reload} /> : products.data!.items.length === 0 ? (
            <Card><Empty title={archived ? 'No archived dishes' : 'No dishes here yet'} hint={archived ? undefined : 'Add a dish with photos, prices and options.'} action={!archived && tree.length > 0 ? <Button onClick={() => setEditProd(blankProduct(selected || tree[0]?._id))}><Plus className="h-4 w-4" /> Add dish</Button> : undefined} /></Card>
          ) : (
            <div className="grid gap-grid-gap sm:grid-cols-2 xl:grid-cols-3">
              {products.data!.items.map((p) => (
                <article key={p._id} className="card card-hover overflow-hidden">
                  <div className="relative aspect-[4/3] bg-stone-100">
                    {p.images[0] ? <img src={assetUrl(p.images[0])} alt="" className="h-full w-full object-cover" loading="lazy" /> : <div className="flex h-full items-center justify-center text-stone-300"><ImagePlus className="h-8 w-8" /></div>}
                    <div className="absolute start-3 top-3 flex flex-wrap gap-1.5">
                      {p.isFeatured && <Badge tone="brand"><Star className="h-3 w-3" /> Featured</Badge>}
                      {!p.isAvailable && <Badge tone="bad">Unavailable</Badge>}
                      {p.trackStock && <Badge tone={p.stockQty > 0 ? 'neutral' : 'bad'}>{p.stockQty} left</Badge>}
                    </div>
                  </div>
                  <div className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-[15px] font-semibold leading-snug text-stone-900">{p.name.en}</h3>
                      <div className="text-end text-sm">
                        {p.promoPrice != null && p.promoPrice < p.price ? (<><p className="font-semibold text-brand">{money(p.promoPrice)}</p><p className="text-xs text-stone-400 line-through">{money(p.price)}</p></>) : <p className="font-semibold">{money(p.price)}</p>}
                      </div>
                    </div>
                    {(p.name.ur || p.name.ar) && <p className="mt-0.5 text-xs text-stone-400" dir="rtl">{[p.name.ur, p.name.ar].filter(Boolean).join(' · ')}</p>}
                    <p className="mt-1.5 text-[13px] text-stone-500">{p.variants.length} options · {p.addons.length} add-ons</p>
                    <div className="mt-4 flex items-center justify-between border-t border-stone-100 pt-4">
                      {!archived ? <Toggle checked={p.isAvailable} onChange={(v) => quick(p, { isAvailable: v }, v ? 'Available' : 'Marked unavailable')} label={<span className="text-xs">Available</span>} /> : <span />}
                      <div className="flex gap-1">
                        {archived ? (
                          <Button size="sm" variant="ghost" onClick={() => quick(p, { isArchived: false }, 'Restored')}><ArchiveRestore className="h-4 w-4" /> Restore</Button>
                        ) : (
                          <>
                            <Button size="icon" variant="ghost" onClick={() => quick(p, { isFeatured: !p.isFeatured }, p.isFeatured ? 'Unfeatured' : 'Featured')} aria-label="Toggle featured"><Star className={cn('h-4 w-4', p.isFeatured && 'fill-amber-400 text-amber-500')} /></Button>
                            <Button size="icon" variant="ghost" onClick={() => setEditProd(toForm(p, dec))} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>
                            <Button size="icon" variant="ghost" onClick={async () => { if (await fb.confirm({ title: 'Archive this dish?', body: 'It disappears from the menu; past orders and reports keep it.', confirmLabel: 'Archive' })) quick(p, { isArchived: true, isFeatured: false }, 'Archived'); }} aria-label="Archive"><Archive className="h-4 w-4" /></Button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>

      <CategoryModal value={editCat} onClose={() => setEditCat(null)} categories={cats.data?.items ?? []} stations={stations.data?.items ?? []} onSaved={() => { setEditCat(null); cats.reload(); }} />
      <ProductModal value={editProd} onClose={() => { setEditProd(null); products.reload(); }} categories={cats.data?.items ?? []} onChanged={() => products.reload()} />
      <StationsModal open={stationModal} onClose={() => { setStationModal(false); stations.reload(); }} />
    </>
  );
}

function CatRow({ c, selected, onSelect, onEdit, onDelete, onMove }: any) {
  return (
    <div className={cn('group flex items-center gap-1 rounded-lg', selected === c._id ? 'bg-brand/10' : 'hover:bg-stone-100')}>
      <button onClick={() => onSelect(c._id)} className="flex-1 truncate px-3 py-2 text-start text-sm">
        <span className={cn(!c.isActive && 'text-stone-400 line-through')}>{c.name.en}</span>
        {c.schedule?.days?.length > 0 && <span className="ms-1 text-[10px] text-stone-400">⏱</span>}
      </button>
      <div className="flex transition lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
        <button className="p-1 text-stone-400 hover:text-stone-800" onClick={() => onMove(c._id, -1)} aria-label="Move up"><ArrowUp className="h-3.5 w-3.5" /></button>
        <button className="p-1 text-stone-400 hover:text-stone-800" onClick={() => onMove(c._id, 1)} aria-label="Move down"><ArrowDown className="h-3.5 w-3.5" /></button>
        <button className="p-1 text-stone-400 hover:text-stone-800" onClick={() => onEdit({ ...c, schedule: c.schedule ?? { days: [] } })} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></button>
        <button className="p-1 text-stone-400 hover:text-red-600" onClick={() => onDelete(c)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></button>
      </div>
    </div>
  );
}

function I18nInputs({ value, onChange, label, textarea }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; label: string; textarea?: boolean }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {LANGS.map((l) => (
        <Field key={l.k} label={`${label} · ${l.label}${l.k === 'en' && !textarea ? ' *' : ''}`}>
          {textarea ? (
            <Textarea dir={l.k === 'en' ? 'ltr' : 'rtl'} value={value?.[l.k] ?? ''} onChange={(e) => onChange({ ...value, [l.k]: e.target.value })} />
          ) : (
            <Input dir={l.k === 'en' ? 'ltr' : 'rtl'} value={value?.[l.k] ?? ''} onChange={(e) => onChange({ ...value, [l.k]: e.target.value })} />
          )}
        </Field>
      ))}
    </div>
  );
}

function CategoryModal({ value, onClose, categories, stations, onSaved }: any) {
  const fb = useFeedback();
  const [v, setV] = useState<any>(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setV(value);
  }, [value]);
  if (!v) return null;
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: v.name, description: v.description, parentId: v.parentId || null, stationId: v.stationId || null, isActive: v.isActive, schedule: { days: v.schedule?.days ?? [], from: v.schedule?.from ?? '', to: v.schedule?.to ?? '' } };
      if (v._id) await api.patch(`/api/staff/menu/categories/${v._id}`, body);
      else await api.post('/api/staff/menu/categories', body);
      fb.ok('Category saved');
      onSaved();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={v._id ? 'Edit category' : 'New category'} size="lg" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} disabled={!v.name?.en}>Save</Button></>}>
      <div className="space-y-4">
        <I18nInputs label="Name" value={v.name} onChange={(name) => setV({ ...v, name })} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Parent (for subcategory)">
            <Select value={v.parentId ?? ''} onChange={(e) => setV({ ...v, parentId: e.target.value })}>
              <option value="">— Top level —</option>
              {categories.filter((c: any) => !c.parentId && c._id !== v._id).map((c: any) => <option key={c._id} value={c._id}>{c.name.en}</option>)}
            </Select>
          </Field>
          <Field label="Kitchen station" hint="Where this category's items are routed on the KDS">
            <Select value={v.stationId ?? ''} onChange={(e) => setV({ ...v, stationId: e.target.value })}>
              <option value="">Default station</option>
              {stations.map((s: any) => <option key={s._id} value={s._id}>{s.name}</option>)}
            </Select>
          </Field>
        </div>
        <div>
          <span className="label">Schedule (optional)</span>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((d, i) => {
              const on = v.schedule?.days?.includes(i);
              return <button key={d} type="button" onClick={() => setV({ ...v, schedule: { ...v.schedule, days: on ? v.schedule.days.filter((x: number) => x !== i) : [...(v.schedule?.days ?? []), i] } })} className={cn('rounded-lg border px-3 py-1.5 text-xs font-medium', on ? 'border-brand bg-brand text-brand-ink' : 'border-stone-200')}>{d}</button>;
            })}
          </div>
          <div className="mt-2 flex gap-2">
            <Field label="From"><Input type="time" value={v.schedule?.from ?? ''} onChange={(e) => setV({ ...v, schedule: { ...v.schedule, from: e.target.value } })} /></Field>
            <Field label="To"><Input type="time" value={v.schedule?.to ?? ''} onChange={(e) => setV({ ...v, schedule: { ...v.schedule, to: e.target.value } })} /></Field>
          </div>
          <p className="mt-1 text-xs text-stone-500">Leave empty to show all day, every day. E.g. Breakfast: Mon–Sun 07:00–11:30.</p>
        </div>
        <Toggle checked={v.isActive} onChange={(isActive) => setV({ ...v, isActive })} label="Visible on menu" />
        <div>
          <span className="label">Category image (optional)</span>
          {!v._id ? (
            <p className="text-xs text-stone-500">Save the category first, then add an image. It appears next to the category title on your menu.</p>
          ) : (
            <div className="flex items-center gap-4">
              <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-xl border border-stone-200 bg-stone-50 text-stone-300">
                {v.imageUrl ? <img src={assetUrl(v.imageUrl)} alt="" className="h-full w-full object-cover" /> : <ImagePlus className="h-6 w-6" />}
              </div>
              <label className="focus-within:ring-brand/50 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm font-medium text-stone-700 shadow-[0_1px_1px_rgb(28_25_23/0.04)] transition hover:border-stone-300 focus-within:ring-2">
                <ImagePlus className="h-4 w-4" /> {v.imageUrl ? 'Replace image' : 'Upload image'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    try {
                      const r = await api.upload(`/api/staff/menu/categories/${v._id}/image`, file);
                      setV({ ...v, imageUrl: r.url });
                      fb.ok('Category image updated');
                    } catch (err) {
                      fb.fail(err);
                    }
                  }}
                />
              </label>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function blankProduct(categoryId?: string) {
  return { categoryId: categoryId ?? '', name: { en: '' }, description: {}, price: '', promoPrice: '', promoEndsAt: '', variants: [], addons: [], tags: '', isFeatured: false, isAvailable: true, trackStock: false, stockQty: 0, recipe: [], prepMinutes: 10, images: [] };
}
function toForm(p: any, dec: number) {
  return {
    ...p,
    price: toMajor(p.price, dec),
    promoPrice: p.promoPrice != null ? toMajor(p.promoPrice, dec) : '',
    promoEndsAt: toLocalInputValue(p.promoEndsAt), // local time, matching how the input value is parsed back
    variants: p.variants.map((v: any) => ({ ...v, priceDelta: toMajor(v.priceDelta, dec) })),
    addons: p.addons.map((a: any) => ({ ...a, price: toMajor(a.price, dec) })),
    tags: (p.tags ?? []).join(', '),
  };
}

function ProductModal({ value, onClose, categories, onChanged }: any) {
  const fb = useFeedback();
  const { tenant, hasFeature } = useAuth();
  const dec = tenant?.settings?.currencyDecimals ?? 2;
  const [v, setV] = useState<any>(value);
  const [busy, setBusy] = useState(false);
  const [inventory, setInventory] = useState<any[]>([]);
  useEffect(() => {
    setV(value);
  }, [value]);
  useEffect(() => {
    if (value && hasFeature('inventory')) api.get('/api/staff/inventory/items?limit=200').then((r) => setInventory(r.items)).catch(() => undefined);
  }, [value, hasFeature]);
  if (!v) return null;

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        categoryId: v.categoryId,
        name: v.name,
        description: v.description,
        price: toMinor(v.price, dec),
        promoPrice: v.promoPrice === '' ? null : toMinor(v.promoPrice, dec),
        promoEndsAt: v.promoEndsAt ? new Date(v.promoEndsAt).toISOString() : null,
        variants: v.variants.map((x: any) => ({ ...(x._id ? { _id: x._id } : {}), name: x.name, priceDelta: toMinor(x.priceDelta || 0, dec) })),
        addons: v.addons.map((x: any) => ({ ...(x._id ? { _id: x._id } : {}), name: x.name, price: toMinor(x.price || 0, dec), isAvailable: x.isAvailable ?? true })),
        tags: String(v.tags).split(',').map((s) => s.trim()).filter(Boolean),
        isFeatured: v.isFeatured,
        isAvailable: v.isAvailable,
        trackStock: v.trackStock,
        stockQty: Number(v.stockQty) || 0,
        recipe: v.recipe.filter((r: any) => r.inventoryItemId && Number(r.quantity) > 0).map((r: any) => ({ inventoryItemId: r.inventoryItemId, quantity: Number(r.quantity) })),
        prepMinutes: Number(v.prepMinutes) || 0,
      };
      const saved = v._id ? await api.patch(`/api/staff/menu/products/${v._id}`, body) : await api.post('/api/staff/menu/products', body);
      fb.ok(v._id ? 'Dish saved' : 'Dish created — you can now add photos');
      onChanged();
      if (!v._id) setV(toForm(saved, dec)); // keep open so photos can be added
      else onClose();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length || !v._id) return;
    try {
      const r = await api.upload(`/api/staff/menu/products/${v._id}/images`, Array.from(files), 'files');
      setV({ ...v, images: r.images });
      onChanged();
      fb.ok('Photos uploaded');
    } catch (e) {
      fb.fail(e);
    }
  };
  const removeImg = async (url: string) => {
    try {
      const r = await api.del(`/api/staff/menu/products/${v._id}/images`, { url });
      setV({ ...v, images: r.images });
    } catch (e) {
      fb.fail(e);
    }
  };

  const listEdit = (key: 'variants' | 'addons' | 'recipe', i: number, patch: any) => setV({ ...v, [key]: v[key].map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) });
  const listDel = (key: 'variants' | 'addons' | 'recipe', i: number) => setV({ ...v, [key]: v[key].filter((_: any, j: number) => j !== i) });

  return (
    <Modal open onClose={onClose} title={v._id ? `Edit · ${v.name.en}` : 'New dish'} size="xl" footer={<><Button variant="outline" onClick={onClose}>Close</Button><Button onClick={save} loading={busy} disabled={!v.name?.en || v.price === '' || !v.categoryId}>Save</Button></>}>
      <div className="space-y-6">
        <I18nInputs label="Name" value={v.name} onChange={(name) => setV({ ...v, name })} />
        <I18nInputs label="Description" value={v.description ?? {}} onChange={(description) => setV({ ...v, description })} textarea />
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Category *">
            <Select value={v.categoryId} onChange={(e) => setV({ ...v, categoryId: e.target.value })}>
              <option value="">Choose…</option>
              {categories.map((c: any) => <option key={c._id} value={c._id}>{c.parentId ? '— ' : ''}{c.name.en}</option>)}
            </Select>
          </Field>
          <Field label={`Price (${tenant?.settings?.currency}) *`}><Input type="number" step="0.01" min="0" value={v.price} onChange={(e) => setV({ ...v, price: e.target.value })} /></Field>
          <Field label="Promo price"><Input type="number" step="0.01" min="0" value={v.promoPrice} onChange={(e) => setV({ ...v, promoPrice: e.target.value })} /></Field>
          <Field label="Promo ends"><Input type="datetime-local" value={v.promoEndsAt} onChange={(e) => setV({ ...v, promoEndsAt: e.target.value })} /></Field>
          <Field label="Prep time (min)"><Input type="number" min="0" value={v.prepMinutes} onChange={(e) => setV({ ...v, prepMinutes: e.target.value })} /></Field>
          <Field label="Tags" hint="comma separated" className="sm:col-span-3"><Input value={v.tags} onChange={(e) => setV({ ...v, tags: e.target.value })} placeholder="spicy, vegetarian, new" /></Field>
        </div>
        <div className="flex flex-wrap gap-6">
          <Toggle checked={v.isAvailable} onChange={(isAvailable) => setV({ ...v, isAvailable })} label="Available" />
          <Toggle checked={v.isFeatured} onChange={(isFeatured) => setV({ ...v, isFeatured })} label="Featured" />
          <Toggle checked={v.trackStock} onChange={(trackStock) => setV({ ...v, trackStock })} label="Track portions in stock" />
          {v.trackStock && <Input type="number" min="0" className="w-28" value={v.stockQty} onChange={(e) => setV({ ...v, stockQty: e.target.value })} aria-label="Stock quantity" />}
        </div>

        <section>
          <div className="mb-2 flex items-center justify-between"><p className="text-sm font-semibold">Options (variants)</p><Button size="sm" variant="ghost" onClick={() => setV({ ...v, variants: [...v.variants, { name: '', priceDelta: '0' }] })}><Plus className="h-4 w-4" /> Add</Button></div>
          {v.variants.length === 0 && <p className="text-xs text-stone-400">e.g. Half / Full, Small / Large. Customers must choose one.</p>}
          {v.variants.map((x: any, i: number) => (
            <div key={i} className="mb-2 flex gap-2"><Input placeholder="Name" value={x.name} onChange={(e) => listEdit('variants', i, { name: e.target.value })} /><Input className="w-36" type="number" step="0.01" placeholder="+ price" value={x.priceDelta} onChange={(e) => listEdit('variants', i, { priceDelta: e.target.value })} /><Button size="icon" variant="ghost" onClick={() => listDel('variants', i)} aria-label="Remove"><X className="h-4 w-4" /></Button></div>
          ))}
        </section>
        <section>
          <div className="mb-2 flex items-center justify-between"><p className="text-sm font-semibold">Add-ons</p><Button size="sm" variant="ghost" onClick={() => setV({ ...v, addons: [...v.addons, { name: '', price: '0', isAvailable: true }] })}><Plus className="h-4 w-4" /> Add</Button></div>
          {v.addons.map((x: any, i: number) => (
            <div key={i} className="mb-2 flex items-center gap-2"><Input placeholder="Name" value={x.name} onChange={(e) => listEdit('addons', i, { name: e.target.value })} /><Input className="w-36" type="number" step="0.01" min="0" value={x.price} onChange={(e) => listEdit('addons', i, { price: e.target.value })} /><Toggle checked={x.isAvailable ?? true} onChange={(isAvailable) => listEdit('addons', i, { isAvailable })} /><Button size="icon" variant="ghost" onClick={() => listDel('addons', i)} aria-label="Remove"><X className="h-4 w-4" /></Button></div>
          ))}
        </section>
        {hasFeature('inventory') && (
          <section>
            <div className="mb-2 flex items-center justify-between"><p className="text-sm font-semibold">Recipe (deducted from inventory when an order is accepted)</p><Button size="sm" variant="ghost" onClick={() => setV({ ...v, recipe: [...v.recipe, { inventoryItemId: '', quantity: '' }] })}><Plus className="h-4 w-4" /> Ingredient</Button></div>
            {v.recipe.map((r: any, i: number) => (
              <div key={i} className="mb-2 flex gap-2">
                <Select value={r.inventoryItemId} onChange={(e) => listEdit('recipe', i, { inventoryItemId: e.target.value })}><option value="">Ingredient…</option>{inventory.map((it) => <option key={it._id} value={it._id}>{it.name} ({it.unit})</option>)}</Select>
                <Input className="w-32" type="number" step="any" min="0" placeholder="Qty / portion" value={r.quantity} onChange={(e) => listEdit('recipe', i, { quantity: e.target.value })} />
                <Button size="icon" variant="ghost" onClick={() => listDel('recipe', i)} aria-label="Remove"><X className="h-4 w-4" /></Button>
              </div>
            ))}
          </section>
        )}
        <section>
          <p className="mb-2 text-sm font-semibold">Photos</p>
          {!v._id ? <p className="text-xs text-stone-500">Save the dish first, then add up to 8 photos.</p> : (
            <div className="flex flex-wrap gap-3">
              {v.images.map((u: string) => (
                <div key={u} className="group relative h-24 w-24 overflow-hidden rounded-lg border border-stone-200">
                  <img src={assetUrl(u)} alt="" className="h-full w-full object-cover" />
                  <button onClick={() => removeImg(u)} className="absolute end-1 top-1 rounded-full bg-white/90 p-1 shadow transition focus:opacity-100 lg:opacity-0 lg:group-hover:opacity-100" aria-label="Remove photo"><X className="h-3 w-3" /></button>
                </div>
              ))}
              {v.images.length < 8 && (
                <label className="flex h-24 w-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-stone-300 text-xs text-stone-500 hover:border-brand hover:text-brand">
                  <ImagePlus className="h-5 w-5" /> Upload
                  <input type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
                </label>
              )}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

function StationsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const fb = useFeedback();
  const { data, reload } = useApi<{ items: any[] }>(open ? '/api/staff/menu/stations?limit=100' : null, [open]);
  const [name, setName] = useState('');
  const add = async () => {
    try {
      await api.post('/api/staff/menu/stations', { name });
      setName('');
      reload();
    } catch (e) {
      fb.fail(e);
    }
  };
  const patch = async (id: string, body: any) => {
    try {
      await api.patch(`/api/staff/menu/stations/${id}`, body);
      reload();
    } catch (e) {
      fb.fail(e);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Kitchen stations" footer={<Button onClick={onClose}>Done</Button>}>
      <p className="mb-4 text-sm text-stone-500">Each category is routed to a station (e.g. Grill, Bar). Items without a station go to the default.</p>
      <ul className="mb-4 divide-y divide-stone-100 rounded-xl border border-stone-200">
        {data?.items.map((s) => (
          <li key={s._id} className="flex items-center gap-3 px-3 py-2">
            <input type="color" value={s.color} onChange={(e) => patch(s._id, { color: e.target.value })} className="h-6 w-6 cursor-pointer rounded border-0" aria-label="Color" />
            <span className="flex-1 text-sm">{s.name}</span>
            {s.isDefault ? <Badge tone="brand">Default</Badge> : <Button size="sm" variant="ghost" onClick={() => patch(s._id, { isDefault: true })}>Make default</Button>}
            <Toggle checked={s.isActive} onChange={(isActive) => patch(s._id, { isActive })} />
          </li>
        ))}
      </ul>
      <div className="flex gap-2"><Input placeholder="New station name" value={name} onChange={(e) => setName(e.target.value)} /><Button onClick={add} disabled={!name.trim()}>Add</Button></div>
    </Modal>
  );
}
