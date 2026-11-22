'use client';

/** Skips to the page's <main> (any page). */
export function SkipLink() {
  return (
    <a
      href="#main"
      className="skip-link"
      onClick={(e) => {
        const el = document.querySelector<HTMLElement>('main, [role="main"], #main');
        if (!el) return;
        e.preventDefault();
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
        el.focus();
        el.scrollIntoView({ block: 'start' });
      }}
    >
      Skip to content
    </a>
  );
}
