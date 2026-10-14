'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { HeroHandle } from './scene';

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

function webglAvailable(): boolean {
  try {
    const probe = document.createElement('canvas');
    return probe.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

type PowerNavigator = Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };

/** Data saver on: keep the static picture and skip the scene's download. */
function savesData(): boolean {
  return (navigator as PowerNavigator).connection?.saveData === true;
}

function isLowPower(): boolean {
  const nav = navigator as PowerNavigator;
  return (
    window.matchMedia('(max-width: 767px)').matches ||
    (nav.hardwareConcurrency ?? 8) <= 4 ||
    (nav.deviceMemory ?? 8) <= 4
  );
}

/**
 * The hero's 3D stage. The static fallback (`children`, rendered on the
 * server) is visible at first paint and stays up if WebGL is unavailable.
 * After first paint, when the browser is idle, the scene module is imported
 * and draws into the canvas, which fades in over the fallback once it has a
 * frame. With prefers-reduced-motion it renders a single still frame; with
 * data saver on it is never downloaded.
 * Rendering pauses whenever the stage is offscreen or the tab is hidden.
 */
export function HeroStage({ children }: { children: ReactNode }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [reduced, setReduced] = useState<boolean | null>(null);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (reduced === null) return;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas || savesData() || !webglAvailable()) return;

    let handle: HeroHandle | null = null;
    let cancelled = false;
    let onScreen = true;
    let pageVisible = !document.hidden;
    const sync = () => handle?.setActive(onScreen && pageVisible);

    const io = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        sync();
      },
      { threshold: 0 },
    );
    io.observe(stage);
    const onVisibility = () => {
      pageVisible = !document.hidden;
      sync();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const boot = () => {
      import('./scene')
        .then(({ startHeroScene }) => {
          if (cancelled) return;
          handle = startHeroScene(canvas, {
            still: reduced,
            lite: isLowPower(),
            onFirstFrame: () => {
              if (!cancelled) setReady(true);
            },
          });
          sync();
        })
        .catch(() => {
          // No WebGL context, a lost context, or a failed chunk load: the
          // static fallback simply stays where it is.
        });
    };

    const w = window as IdleWindow;
    let idleId: number | undefined;
    let timer: number | undefined;
    const frame = requestAnimationFrame(() => {
      if (w.requestIdleCallback) idleId = w.requestIdleCallback(boot, { timeout: 1500 });
      else timer = window.setTimeout(boot, 150);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (idleId !== undefined) w.cancelIdleCallback?.(idleId);
      if (timer !== undefined) window.clearTimeout(timer);
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      handle?.dispose();
      handle = null;
      setReady(false);
    };
  }, [reduced]);

  return (
    <div ref={stageRef} className="hero-stage" data-ready={ready ? 'true' : 'false'} aria-hidden="true">
      <div className="hero-fallback">{children}</div>
      {/* A fresh canvas per motion mode: a disposed WebGL context cannot be reused. */}
      <canvas key={String(reduced)} ref={canvasRef} className="hero-canvas" />
    </div>
  );
}
