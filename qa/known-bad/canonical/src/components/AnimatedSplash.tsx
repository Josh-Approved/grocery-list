// KNOWN-BAD FIXTURE splash — sets letterSpacing on the wordmark but gives the
// Text NO trailing horizontal room (paddingRight/paddingHorizontal/paddingEnd),
// so rn/splash-wordmark-clip fires (the recurring "the d is cut off" defect).
// Never compiled or bundled; read as text by qa-canonical only.
import { Text } from 'react-native';

export function AnimatedSplash() {
  const style = { letterSpacing: -0.5, fontSize: 28 };
  return <Text style={style}>josh approved</Text>;
}
