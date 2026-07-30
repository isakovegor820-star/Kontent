"use client";

import { useEffect, useRef } from "react";
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from "motion/react";

const DIRECTIONS = ["left", "right", "up"] as const;

/**
 * Общая режиссура скролла для основного лендинга.
 * Контент остаётся полностью доступным без JS и при reduced-motion.
 */
export function V3ScrollMotion() {
  const markerRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const smoothProgress = useSpring(scrollYProgress, {
    stiffness: 150,
    damping: 28,
    mass: 0.32,
  });
  const ghostX = useTransform(smoothProgress, [0, 1], ["20vw", "-118vw"]);
  const ghostRotate = useTransform(smoothProgress, [0, 1], [-2, 2]);

  useEffect(() => {
    if (reduce) return;

    const root = markerRef.current?.closest<HTMLElement>(".aurora-variants");
    if (!root) return;

    const scenes = Array.from(root.querySelectorAll<HTMLElement>(":scope > main > section"));
    const viewportEdge = window.innerHeight * 0.9;

    scenes.forEach((scene, index) => {
      scene.classList.add("v3-scroll-scene");
      scene.dataset.scrollDirection = DIRECTIONS[index % DIRECTIONS.length];

      const box = scene.getBoundingClientRect();
      if (box.top < viewportEdge && box.bottom > 0) {
        scene.classList.add("v3-scroll-scene--visible");
      }
    });

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("v3-scroll-scene--visible");
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );

    scenes
      .filter((scene) => !scene.classList.contains("v3-scroll-scene--visible"))
      .forEach((scene) => observer.observe(scene));

    const readyFrame = window.requestAnimationFrame(() => {
      root.classList.add("v3-scroll-motion-ready");
    });

    return () => {
      window.cancelAnimationFrame(readyFrame);
      observer.disconnect();
      root.classList.remove("v3-scroll-motion-ready");
      scenes.forEach((scene) => {
        scene.classList.remove("v3-scroll-scene", "v3-scroll-scene--visible");
        delete scene.dataset.scrollDirection;
      });
    };
  }, [reduce]);

  return (
    <>
      <div ref={markerRef} className="v3-scroll-progress" aria-hidden="true">
        <motion.div
          className="v3-scroll-progress__fill"
          style={{ scaleX: reduce ? scrollYProgress : smoothProgress }}
        />
      </div>
      <motion.div
        className="v3-scroll-watermark"
        style={reduce ? undefined : { x: ghostX, rotate: ghostRotate }}
        aria-hidden="true"
      >
        АВРОРА · АВРОРА · АВРОРА
      </motion.div>
    </>
  );
}
