"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Reveals its children as they scroll into view.
 *
 * Uses IntersectionObserver rather than a scroll listener so the browser does
 * the work off the main thread, and unobserves after the first reveal — the
 * animation is a one-shot entrance, and leaving observers attached to a long
 * page costs more than it gains.
 *
 * Falls back to visible-immediately when IntersectionObserver is unavailable,
 * so content is never hidden by a missing API.
 */
export default function Reveal({
  children,
  delay = 0,
  className = "",
  as = "div",
}: {
  children: React.ReactNode;
  /** Stagger, in ms — use small increments for lists. */
  delay?: number;
  className?: string;
  as?: "div" | "section" | "article" | "li" | "p" | "h2" | "h3";
}) {
  // A small closed set of tags: typing this as `keyof JSX.IntrinsicElements`
  // makes the JSX below a union of ~175 element types, which TypeScript
  // rejects (TS2590) and which would fail `next build` in CI.
  const Tag = as as React.ElementType;
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    // Anything already on screen at mount is shown straight away rather than
    // waiting for an intersection callback that may never come.
    const rect = node.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.unobserve(entry.target);
        }
      },
      // Start the transition slightly before the element reaches the viewport
      // so it has finished by the time the reader's eye arrives.
      { threshold: 0.12, rootMargin: "0px 0px -60px 0px" }
    );
    observer.observe(node);

    /*
     * Safety net. This animation is decoration; the content underneath is the
     * product. IntersectionObserver can fail to deliver callbacks in
     * environments that never composite a frame — a background or headless
     * tab, some embedded webviews, print/preview rendering — and without this
     * the page would stay permanently blank rather than merely un-animated.
     * A watchdog costs one timer and removes that whole failure class.
     */
    const watchdog = window.setTimeout(() => setVisible(true), 1600);

    return () => {
      observer.disconnect();
      window.clearTimeout(watchdog);
    };
  }, []);

  return (
    <Tag
      ref={ref}
      className={`reveal ${visible ? "is-visible" : ""} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </Tag>
  );
}
