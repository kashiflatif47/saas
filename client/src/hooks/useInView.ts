import { useEffect, useRef, useState } from 'react';

/**
 * Adds `is-visible` to an element (with the `.reveal` class) the first time it scrolls into view.
 * No library: one IntersectionObserver per element, disconnected after it fires. Under
 * prefers-reduced-motion the `.reveal` class is a no-op in CSS, so content is never hidden.
 */
export function useReveal<T extends HTMLElement>(threshold = 0.12) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      el.classList.add('is-visible');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          el.classList.add('is-visible');
          io.disconnect();
        }
      },
      { threshold, rootMargin: '0px 0px -40px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return ref;
}

/**
 * Scroll-spy: returns the id of the section currently under the sticky navigation bar.
 * `offset` is the height of everything stuck to the top of the viewport.
 */
export function useScrollSpy(ids: string[], offset = 160) {
  const [active, setActive] = useState<string>(ids[0] ?? '');
  const key = ids.join('|');
  useEffect(() => {
    if (!ids.length) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        let current = ids[0];
        for (const id of ids) {
          const el = document.getElementById(id);
          if (el && el.getBoundingClientRect().top - offset <= 0) current = id;
        }
        setActive(current);
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, offset]);
  return active;
}
