// KNOWN-BAD FIXTURE colour tokens — enough shape for theme/contrast-pairing to
// resolve light/dark palettes (each needs a `bg`) and thus actually run rather
// than skip. `fgOnInk` is the trap token Bad.tsx pairs as a foreground.
// Never compiled or imported by a real app; read as text only.
export const c = {
  fgOnInk: '#ffffff',
  inkButton: '#101010',
  inkButtonText: '#ffffff',
};

const light = { bg: '#ffffff', fg: '#101010', inkButton: '#101010' };
const dark = { bg: '#101010', fg: '#f2f2f2', inkButton: '#f2f2f2' };

export const palettes = { light, dark };
