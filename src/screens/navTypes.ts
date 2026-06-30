/**
 * Navigation prop types for the tab screens.
 *
 * Lives in a `.ts` module (not inline in each screen) so the composite type is
 * declared once — and kept out of the .tsx files, where the multiline
 * `CompositeScreenProps<…>,\n…<…>` generic reads like raw JSX text to the
 * i18n linter's heuristic.
 *
 * A tab screen can navigate to its sibling tab AND to any parent-stack route, so
 * its navigation prop is the composite of both.
 */

import type { CompositeScreenProps } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList, TabParamList } from '../../App';

export type ListsTabProps = CompositeScreenProps<
  BottomTabScreenProps<TabParamList, 'ListsTab'>,
  NativeStackScreenProps<RootStackParamList>
>;

export type KitsTabProps = CompositeScreenProps<
  BottomTabScreenProps<TabParamList, 'KitsTab'>,
  NativeStackScreenProps<RootStackParamList>
>;
