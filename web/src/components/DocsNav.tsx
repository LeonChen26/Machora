"use client";

import { useEffect, useState } from "react";

// Docs 左侧目录：滚动时高亮当前可见章节（scrollspy，替代无定位的纯锚点列表）
export function DocsNav({
  sections,
}: {
  sections: { label: string; items: { href: string; label: string }[] }[];
}) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const ids = sections
      .flatMap((s) => s.items.map((i) => i.href.replace(/^#/, "")))
      .filter(Boolean);
    const els = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => !!el);
    if (els.length === 0) return;

    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // 高亮最后进入视口顶部区域（110px 判定线，避开 sticky 目录自身）的章节
        let cur: string | null = null;
        for (const el of els) {
          if (el.getBoundingClientRect().top <= 110) cur = el.id;
        }
        // 滚动到底部时锁定最后一个章节
        if (
          window.innerHeight + window.scrollY >= document.body.scrollHeight - 4
        ) {
          cur = els[els.length - 1].id;
        }
        setActive(cur);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [sections]);

  return (
    <nav className="docs-nav" aria-label="文档目录">
      {sections.map((section) => (
        <div key={section.label} className="docs-nav-section">
          <div className="docs-nav-label">{section.label}</div>
          {section.items.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className={active === item.href.slice(1) ? "active" : undefined}
            >
              {item.label}
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
}
