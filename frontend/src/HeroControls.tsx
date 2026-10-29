import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface SliderSettings {
  id: string;
  arrows: boolean;
  arrowClass: string;
  delay: number;
  pauseOnHover: boolean;
  motions: {
    key: string;
    backgroundDuration: number;
    backgroundEasing: string;
    textDelay: number;
    textDuration: number;
    textEasing: string;
    textFromY: number;
    textExitDuration: number;
    textExitEasing: string;
  }[];
}

function sourceEasing(name: string) {
  if (!['back.inOut', 'power2.inOut', 'power3.inOut'].includes(name)) throw new Error(`Unsupported source hero easing: ${name}`);
  // Sample the original GSAP easing so native animations keep its overshoot.
  const samples = Array.from({ length: 101 }, (_, index) => {
    const progress = index / 100;
    const half = progress < 0.5 ? progress * 2 : 2 - progress * 2;
    const value = name === 'back.inOut' ? half * half * (2.70158 * half - 1.70158) :
      half ** (name === 'power2.inOut' ? 3 : 4);
    return (progress < 0.5 ? value / 2 : 1 - value / 2).toFixed(5);
  });
  return `linear(${samples.join(',')})`;
}

export default function HeroControls({ settings, host, language }: {
  settings: SliderSettings; host: Element; language: string;
}) {
  const [slides] = useState(() => [...host.querySelectorAll('sr7-slide')].filter(slide =>
    slide.querySelector('sr7-bg img, .sr7-layer:not(sr7-bg)')));
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const previous = useRef<Element | null>(null);
  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const current = slides[active];
    if (!current) return;
    const outgoing = previous.current === current ? null : previous.current;
    const motion = settings.motions.find(item => item.key === current.getAttribute('data-key'));
    if (!motion) return;
    const animations: Animation[] = [];
    slides.forEach((slide, index) => {
      slide.setAttribute('data-slide-active', String(index === active));
      slide.setAttribute('aria-hidden', String(index !== active));
      slide.toggleAttribute('inert', index !== active);
      slide.removeAttribute('data-slide-exiting');
    });
    previous.current = current;
    if (reducedMotion) return;
    const background = current.querySelector('sr7-bg');
    if (background) animations.push(background.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: motion.backgroundDuration, easing: sourceEasing(motion.backgroundEasing), fill: 'both',
    }));
    for (const layer of current.querySelectorAll(':scope > .sr7-layer:not(sr7-bg)')) {
      animations.push(layer.animate([
        { opacity: 0, transform: `translateY(${motion.textFromY}px)` },
        { opacity: 1, transform: 'translateY(0)' },
      ], { delay: motion.textDelay, duration: motion.textDuration, easing: sourceEasing(motion.textEasing), fill: 'both' }));
    }
    if (outgoing) {
      outgoing.setAttribute('data-slide-exiting', '');
      for (const layer of outgoing.querySelectorAll(':scope > .sr7-layer:not(sr7-bg)')) {
        animations.push(layer.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: motion.textExitDuration, easing: sourceEasing(motion.textExitEasing), fill: 'both',
        }));
      }
    }
    const timer = window.setTimeout(() => outgoing?.removeAttribute('data-slide-exiting'), motion.backgroundDuration);
    return () => {
      window.clearTimeout(timer);
      for (const animation of animations) animation.cancel();
      outgoing?.removeAttribute('data-slide-exiting');
    };
  }, [slides, active, settings.motions, reducedMotion]);
  useEffect(() => {
    if (slides.length < 2 || paused || reducedMotion) return;
    const timer = window.setTimeout(() => setActive(index => (index + 1) % slides.length), settings.delay);
    return () => window.clearTimeout(timer);
  }, [active, slides.length, settings.delay, paused, reducedMotion]);
  useEffect(() => {
    if (!settings.pauseOnHover) return;
    const pause = () => setPaused(true);
    const resume = () => setPaused(false);
    host.addEventListener('mouseenter', pause);
    host.addEventListener('mouseleave', resume);
    host.addEventListener('focusin', pause);
    host.addEventListener('focusout', resume);
    return () => {
      host.removeEventListener('mouseenter', pause);
      host.removeEventListener('mouseleave', resume);
      host.removeEventListener('focusin', pause);
      host.removeEventListener('focusout', resume);
    };
  }, [host, settings.pauseOnHover]);
  if (!settings.arrows || slides.length < 2) return null;
  return createPortal(<>
    <button type="button" className={`${settings.arrowClass} sr7-arrows sr7-leftarrow source-hero-arrow`}
      aria-label={language === 'en' ? 'Previous slide' : '이전 슬라이드'}
      onClick={() => setActive(index => (index + slides.length - 1) % slides.length)} />
    <button type="button" className={`${settings.arrowClass} sr7-arrows sr7-rightarrow source-hero-arrow`}
      aria-label={language === 'en' ? 'Next slide' : '다음 슬라이드'}
      onClick={() => setActive(index => (index + 1) % slides.length)} />
  </>, host);
}
