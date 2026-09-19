export interface PerpToggles {
  tradingEnabled: boolean;
  samplingEnabled: boolean;
}

/**
 * Enforces the PERP toggle dependency rule: enabling trading forces
 * sampling on; disabling sampling forces trading off. Each explicitly
 * patched field's cascade is applied immediately after that field is
 * set, so the two rules never fight each other when only one toggle
 * is flipped at a time (the normal UI interaction).
 */
export function applyToggleRules(
  current: PerpToggles,
  patch: Partial<PerpToggles>,
): PerpToggles {
  const next: PerpToggles = { ...current };

  if (patch.tradingEnabled !== undefined) {
    next.tradingEnabled = patch.tradingEnabled;
    if (next.tradingEnabled) {
      next.samplingEnabled = true;
    }
  }

  if (patch.samplingEnabled !== undefined) {
    next.samplingEnabled = patch.samplingEnabled;
    if (!next.samplingEnabled) {
      next.tradingEnabled = false;
    }
  }

  return next;
}
