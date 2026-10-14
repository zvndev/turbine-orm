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

/** Pressing on these does what they do; pressing anywhere else in the hero boosts. */
const NOT_A_BOOST = 'a, button, input, textarea, select, label, code, pre, p, h1, h2, dl, .install, .eyebrow';

/** A touch has to stay put this long before it boosts, so a scroll flick never does. */
const TOUCH_HOLD_MS = 140;

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
 *
 * The live scene answers the pointer: a mouse tilts the camera and lights
 * the asphalt under it, and pressing and holding anywhere in the hero that
 * is not text or a control boosts the lead tracer.
 */
export function HeroStage({ children }: { children: ReactNode }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [reduced, setReduced] = useState<boolean | null>(null);
  const [boosted, setBoosted] = useState(false);

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

    /* ---------- pointer ---------- */
    const hero = stage.parentElement;
    let holdTimer: number | undefined;
    let holding: number | null = null;
    const startBoost = () => {
      handle?.setBoost(true);
      setBoosted(true);
    };
    const endBoost = (e?: PointerEvent) => {
      if (e && e.pointerId !== holding) return;
      holding = null;
      if (holdTimer !== undefined) window.clearTimeout(holdTimer);
      holdTimer = undefined;
      handle?.setBoost(false);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') handle?.setPointer(e.clientX, e.clientY);
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') handle?.setPointer(null);
    };
    const onDown = (e: PointerEvent) => {
      if (!handle || holding !== null || !e.isPrimary || e.button !== 0) return;
      if ((e.target as Element | null)?.closest(NOT_A_BOOST)) return;
      holding = e.pointerId;
      if (e.pointerType === 'touch') {
        holdTimer = window.setTimeout(startBoost, TOUCH_HOLD_MS);
      } else {
        // Keeps a press-and-drag from selecting the hero text.
        e.preventDefault();
        startBoost();
      }
    };
    const onBlur = () => endBoost();
    // A long press on a touch screen would otherwise open a menu.
    const onContextMenu = (e: Event) => {
      if (holding !== null) e.preventDefault();
    };
    if (!reduced && hero) {
      hero.addEventListener('pointermove', onMove);
      hero.addEventListener('pointerleave', onLeave);
      hero.addEventListener('pointerdown', onDown);
      hero.addEventListener('contextmenu', onContextMenu);
      window.addEventListener('pointerup', endBoost);
      window.addEventListener('pointercancel', endBoost);
      window.addEventListener('blur', onBlur);
    }

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
      if (holdTimer !== undefined) window.clearTimeout(holdTimer);
      hero?.removeEventListener('pointermove', onMove);
      hero?.removeEventListener('pointerleave', onLeave);
      hero?.removeEventListener('pointerdown', onDown);
      hero?.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('pointerup', endBoost);
      window.removeEventListener('pointercancel', endBoost);
      window.removeEventListener('blur', onBlur);
      handle?.dispose();
      handle = null;
      setReady(false);
    };
  }, [reduced]);

  return (
    <>
      <div ref={stageRef} className="hero-stage" data-ready={ready ? 'true' : 'false'} aria-hidden="true">
        <div className="hero-fallback">{children}</div>
        {/* A fresh canvas per motion mode: a disposed WebGL context cannot be reused. */}
        <canvas key={String(reduced)} ref={canvasRef} className="hero-canvas" />
      </div>
      {/* Outside the stage, so the narrow-screen band's fade mask does not dim it.
          Always rendered, so revealing it never moves the layout. */}
      <p
        className="hero-hint"
        data-show={ready && reduced === false ? 'true' : 'false'}
        data-gone={boosted ? 'true' : 'false'}
        aria-hidden="true"
      >
        <span className="hero-hint-mouse">Click and hold to boost</span>
        <span className="hero-hint-touch">Touch and hold to boost</span>
      </p>
    </>
  );
}
