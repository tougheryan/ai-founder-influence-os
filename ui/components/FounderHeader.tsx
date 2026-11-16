'use client';

import Link from 'next/link';
import { ArrowUpRight, Menu } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const navigationItems = [
  { id: 'for-founders', href: '#for-founders', label: '适合我吗' },
  { id: 'system', href: '#system', label: '我能获得什么' },
  { id: 'how-it-works', href: '#how-it-works', label: '如何开始' },
  { id: 'principles', href: '#principles', label: '合作边界' },
] as const;

export function FounderHeader() {
  const mobileNavRef = useRef<HTMLDetailsElement>(null);
  const [isDarkContext, setIsDarkContext] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);

  const closeMobileNav = () => {
    if (mobileNavRef.current) mobileNavRef.current.open = false;
  };

  const closeMobileNavAndFocusSummary = () => {
    closeMobileNav();
    mobileNavRef.current?.querySelector('summary')?.focus();
  };

  useEffect(() => {
    let isMounted = true;
    const darkSections = ['.dossier-method', '.dossier-closing']
      .map((selector) => document.querySelector<HTMLElement>(selector))
      .filter((section): section is HTMLElement => Boolean(section));

    if (darkSections.length === 0) return;

    const updateTheme = () => {
      if (!isMounted) return;

      setIsDarkContext(darkSections.some((section) => {
        const bounds = section.getBoundingClientRect();
        return bounds.top <= 120 && bounds.bottom > 68;
      }));
    };

    const observer = new IntersectionObserver(updateTheme, {
      rootMargin: '-68px 0px -88% 0px',
      threshold: 0,
    });

    darkSections.forEach((section) => observer.observe(section));
    updateTheme();

    return () => {
      isMounted = false;
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const topSection = document.getElementById('top');
    const sections = navigationItems
      .map(({ id }) => document.getElementById(id))
      .filter((section): section is HTMLElement => section !== null);

    if (!topSection && sections.length === 0) return;

    const observer = new IntersectionObserver((entries) => {
      if (!isMounted) return;

      const nextActiveSection = entries.find((entry) => entry.isIntersecting);
      if (!nextActiveSection) return;

      setActiveSection(nextActiveSection.target.id === 'top' ? null : nextActiveSection.target.id);
    }, {
      rootMargin: '-22% 0px -68% 0px',
      threshold: 0,
    });

    if (topSection) observer.observe(topSection);
    sections.forEach((section) => observer.observe(section));

    return () => {
      isMounted = false;
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const mobileNav = mobileNavRef.current;
    if (!mobileNav) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !mobileNav.open) return;

      event.preventDefault();
      mobileNav.open = false;
      mobileNav.querySelector('summary')?.focus();
    };

    document.addEventListener('keydown', closeOnEscape, true);
    window.addEventListener('keydown', closeOnEscape, true);

    return () => {
      document.removeEventListener('keydown', closeOnEscape, true);
      window.removeEventListener('keydown', closeOnEscape, true);
    };
  }, []);

  return (
    <header className={`dossier-header${isDarkContext ? ' dossier-header--dark' : ''}`}>
      <a className="dossier-skip-link" href="#main-content">跳至主要内容</a>
      <div className="dossier-shell dossier-header__inner">
        <Link href="#top" className="dossier-mark" aria-label="Founder AI Influence System 首页">
          <span className="dossier-mark__serial" aria-hidden="true">FA</span>
          <span><b>FOUNDER AI</b><em>INFLUENCE SYSTEM</em></span>
        </Link>

        <nav className="dossier-header__nav" aria-label="页面导航">
          {navigationItems.map((item) => {
            const isActive = activeSection === item.id;

            return (
              <a
                aria-current={isActive ? 'location' : undefined}
                className={`dossier-header__nav-link${isActive ? ' dossier-header__nav-link--active' : ''}`}
                href={item.href}
                key={item.id}
                onClick={() => setActiveSection(item.id)}
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        <a className="dossier-header__cta" href="#diagnosis">
          申请诊断 <ArrowUpRight aria-hidden="true" size={15} />
        </a>

        <details
          className="dossier-mobile-nav"
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !mobileNavRef.current?.open) return;

            event.preventDefault();
            closeMobileNavAndFocusSummary();
          }}
          ref={mobileNavRef}
        >
          <summary aria-label="页面导航" title="页面导航">
            <Menu aria-hidden="true" size={19} />
            <span className="dossier-mobile-nav__label">页面导航</span>
          </summary>
          <nav aria-label="移动页面导航">
            {navigationItems.map((item) => {
              const isActive = activeSection === item.id;

              return (
                <a
                  aria-current={isActive ? 'location' : undefined}
                  className={`dossier-mobile-nav__link${isActive ? ' dossier-mobile-nav__link--active' : ''}`}
                  href={item.href}
                  key={item.id}
                  onClick={() => {
                    setActiveSection(item.id);
                    closeMobileNav();
                  }}
                >
                  {item.label}
                </a>
              );
            })}
            <a href="#diagnosis" onClick={closeMobileNav}>申请诊断 <ArrowUpRight aria-hidden="true" size={15} /></a>
          </nav>
        </details>
      </div>
    </header>
  );
}
