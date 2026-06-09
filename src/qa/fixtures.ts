// QA fixtures — deterministic data the app boots with under QA_MODE (the capture
// pipeline builds with EXPO_PUBLIC_QA_MODE=1). Built with the app's OWN
// constructors so it's valid by construction; ids/timestamps don't appear in
// screenshots, so their randomness is harmless. Names span aisles to fill the
// categorized list nicely.
import { makeList, makeItem, type GroceryList } from '../data/list';

export function qaLists(): GroceryList[] {
  const list = makeList('Weekly shop');
  const names = [
    'Bananas', 'Whole milk', 'Sourdough', 'Eggs', 'Chicken thighs',
    'Baby spinach', 'Cheddar', 'Olive oil', 'Coffee beans', 'Greek yogurt',
    'Tomatoes', 'Pasta',
  ];
  list.items = names.map(makeItem);
  // A couple checked off so the progress UI reads as a real, mid-shop list.
  for (const i of [1, 4]) {
    list.items[i].checked = true;
    list.items[i].checkedAt = list.items[i].updatedAt;
  }
  return [list];
}
