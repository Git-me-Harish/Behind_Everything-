import { useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'be.theme';

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Resolves the theme onto <html data-theme> and follows the system setting when the choice is "system". */
export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(read);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = choice === 'system' ? (mq.matches ? 'dark' : 'light') : choice;
    };
    apply();
    mq.addEventListener('change', apply);
    try { localStorage.setItem(KEY, choice); } catch { /* private mode */ }
    return () => mq.removeEventListener('change', apply);
  }, [choice]);
  return [choice, setChoice];
}
