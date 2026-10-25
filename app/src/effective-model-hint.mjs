// Renderer rule of the Auto-model hint (contract v3.53), pure so it is testable.
/**
 * The one-line "managers work best on Opus" hint shows only for Auto + an inherited Haiku + manager mode.
 * @param {string} selected the boss model picker's value ('auto' or a model)
 * @param {{ family?: string | null, manager?: boolean } | null | undefined} eff the IPC answer
 */
export function showHaikuManagerHint(selected, eff) {
  return selected === 'auto' && !!eff && eff.family === 'haiku' && eff.manager === true;
}
