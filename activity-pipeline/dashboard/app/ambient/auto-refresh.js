'use client';

import { useEffect } from 'react';

// Reloads the page every `seconds` so the wallpaper/PWA stays current.
export default function AutoRefresh({ seconds = 60 }) {
  useEffect(() => {
    const id = setTimeout(() => window.location.reload(), seconds * 1000);
    return () => clearTimeout(id);
  }, [seconds]);
  return null;
}
