import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface CartLine {
  key: string; // product + variant + addons signature
  productId: string;
  name: Record<string, string>;
  image?: string;
  variantId?: string;
  variantName?: string;
  addonIds: string[];
  addonNames: string[];
  unitPrice: number; // display estimate only — server recomputes
  quantity: number;
  notes?: string;
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
      return JSON.parse(localStorage.getItem(storeKey) || '[]');
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
    const key = [l.productId, l.variantId ?? '', [...l.addonIds].sort().join('+'), l.notes ?? ''].join('|');
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
