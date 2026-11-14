import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { selectionKey, type ItemSelection } from '../offline/menuPricing';

export interface CartLine {
  key: string; // product + exact configuration + notes: different configurations never merge
  productId: string;
  name: Record<string, string>;
  image?: string;
  /** What was chosen (ids and quantities only). */
  selection: ItemSelection;
  /** Readable configuration: option, extras with quantities, choices, removed ingredients. */
  summary: string[];
  unitPrice: number; // preview from the shared pricing rules; the server prices the order itself
  quantity: number;
  notes?: string;
}

const lineKey = (l: Pick<CartLine, 'productId' | 'selection' | 'notes'>) => `${selectionKey(l.productId, l.selection)}|${l.notes ?? ''}`;

/** Carts saved by an earlier version stored variantId/addonIds/addonNames: read them into the current shape. */
function upgrade(raw: any): CartLine | null {
  if (!raw?.productId) return null;
  const selection: ItemSelection = raw.selection ?? { variantId: raw.variantId, addonIds: raw.addonIds ?? [] };
  const summary: string[] = raw.summary ?? [raw.variantName, ...(raw.addonNames ?? [])].filter(Boolean);
  const l = { ...raw, selection, summary } as CartLine;
  return { ...l, key: lineKey(l) };
}

interface CartState {
  lines: CartLine[];
  count: number;
  subtotal: number;
  tableToken: string | null;
  tableLabel: string | null;
  setTable: (token: string | null, label: string | null) => void;
  add: (l: Omit<CartLine, 'key'>) => void;
  setQty: (key: string, qty: number) => void;
  remove: (key: string) => void;
  clear: () => void;
}

const Ctx = createContext<CartState | null>(null);

export function CartProvider({ children, tenantSlug }: { children: ReactNode; tenantSlug: string }) {
  const storeKey = `cart:${tenantSlug}`;
  const [lines, setLines] = useState<CartLine[]>(() => {
    try {
      return (JSON.parse(localStorage.getItem(storeKey) || '[]') as any[]).map(upgrade).filter(Boolean) as CartLine[];
    } catch {
      return [];
    }
  });
  const [table, setTableState] = useState<{ token: string | null; label: string | null }>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(`${storeKey}:table`) || '{"token":null,"label":null}');
    } catch {
      return { token: null, label: null };
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storeKey, JSON.stringify(lines));
    } catch {
      /* storage full / private mode */
    }
  }, [lines, storeKey]);

  const setTable = useCallback(
    (token: string | null, label: string | null) => {
      setTableState({ token, label });
      try {
        sessionStorage.setItem(`${storeKey}:table`, JSON.stringify({ token, label }));
      } catch {
        /* ignore */
      }
    },
    [storeKey],
  );

  const add = useCallback((l: Omit<CartLine, 'key'>) => {
    const key = lineKey(l);
    setLines((prev) => {
      const i = prev.findIndex((x) => x.key === key);
      if (i >= 0) return prev.map((x, j) => (j === i ? { ...x, quantity: Math.min(99, x.quantity + l.quantity) } : x));
      return [...prev, { ...l, key }];
    });
  }, []);

  const setQty = useCallback((key: string, qty: number) => setLines((p) => (qty <= 0 ? p.filter((x) => x.key !== key) : p.map((x) => (x.key === key ? { ...x, quantity: Math.min(99, qty) } : x)))), []);
  const remove = useCallback((key: string) => setLines((p) => p.filter((x) => x.key !== key)), []);
  const clear = useCallback(() => setLines([]), []);

  const value = useMemo<CartState>(
    () => ({
      lines,
      count: lines.reduce((s, l) => s + l.quantity, 0),
      subtotal: lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
      tableToken: table.token,
      tableLabel: table.label,
      setTable,
      add,
      setQty,
      remove,
      clear,
    }),
    [lines, table, setTable, add, setQty, remove, clear],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCart outside provider');
  return c;
}
