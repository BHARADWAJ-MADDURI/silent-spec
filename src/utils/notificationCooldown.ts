const lastShownAt = new Map<string, number>();

export function shouldShowNotification(key: string, cooldownMs = 30_000): boolean {
  const now = Date.now();
  const lastShown = lastShownAt.get(key) ?? 0;
  if (now - lastShown < cooldownMs) {
    return false;
  }
  lastShownAt.set(key, now);
  return true;
}

