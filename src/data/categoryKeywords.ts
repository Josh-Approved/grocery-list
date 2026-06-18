/**
 * Localized keyword source of truth for aisle inference.
 *
 * `inferCategory` (categories.ts) matches a freshly typed item name against
 * these substring keywords to guess an aisle. The matcher is locale-aware: it
 * tries the active locale's keyword set first, then falls back to English, so
 * English input still sorts in any language mode and a user typing in their own
 * language stops landing everything in "Other" (Josh's bug: app in Spanish →
 * "manzanas"/"jugo de naranja" → Otros).
 *
 * This module is PURE DATA — no imports — so the structural verifier
 * (`scratch/verify-categorization.mjs`) can load it directly with Node. It is
 * the single source of truth: categories.ts imports `KEYWORDS_BY_LOCALE.en`
 * instead of an inline English list.
 *
 * Rules for the lists:
 *   - Every locale uses the SAME category keys as the `Category` union
 *     (the stable internal English keys). 'Other' has no keywords (it is the
 *     fallback) and is intentionally absent.
 *   - Keywords are lowercase substrings. Prefer stems so plurals/inflections
 *     match for free ('manzana' also matches 'manzanas'). Multi-word entries
 *     ('jugo de naranja') are fine.
 *   - Categories are scanned in DEFAULT_CATEGORY_ORDER and the FIRST hit wins,
 *     so a word that should land later (e.g. Spanish 'jugo de naranja' →
 *     Beverages) must not also be a substring of an earlier category's
 *     keyword — that's why Spanish Produce omits the bare orange word, exactly
 *     as English Produce+Beverages already sends 'orange juice' → Produce.
 *   - English is the per-key fallback, so non-English lists must NOT contain
 *     English words.
 */

export const KEYWORDS_BY_LOCALE: Record<string, Record<string, string[]>> = {
  // -------------------------------------------------------------------------
  // English — migrated verbatim out of categories.ts. Source of truth + the
  // universal fallback applied under every other locale.
  // -------------------------------------------------------------------------
  en: {
    Produce: [
      'apple', 'banana', 'orange', 'lemon', 'lime', 'grape', 'berry', 'berries',
      'strawberr', 'blueberr', 'avocado', 'tomato', 'potato', 'onion', 'garlic',
      'lettuce', 'spinach', 'kale', 'carrot', 'celery', 'pepper', 'cucumber',
      'broccoli', 'cauliflower', 'mushroom', 'zucchini', 'squash', 'corn',
      'salad', 'herb', 'cilantro', 'parsley', 'basil', 'ginger', 'melon',
      'peach', 'pear', 'plum', 'mango', 'pineapple', 'cabbage', 'asparagus',
    ],
    Bakery: [
      'bread', 'bagel', 'bun', 'roll', 'baguette', 'croissant', 'muffin',
      'tortilla', 'pita', 'naan', 'cake', 'donut', 'doughnut', 'pastry',
    ],
    'Meat & seafood': [
      'chicken', 'beef', 'pork', 'steak', 'bacon', 'sausage', 'ham', 'turkey',
      'lamb', 'mince', 'ground beef', 'fish', 'salmon', 'tuna', 'shrimp',
      'prawn', 'cod', 'tilapia', 'crab', 'lobster', 'meat',
    ],
    'Dairy & eggs': [
      'milk', 'cheese', 'butter', 'yogurt', 'yoghurt', 'cream', 'egg',
      'sour cream', 'cottage', 'mozzarella', 'cheddar', 'parmesan', 'feta',
      'margarine', 'half and half', 'creamer',
    ],
    Frozen: [
      'frozen', 'ice cream', 'popsicle', 'fries', 'frozen pizza', 'waffle',
    ],
    Pantry: [
      'rice', 'pasta', 'noodle', 'flour', 'sugar', 'salt', 'oil', 'olive oil',
      'vinegar', 'sauce', 'ketchup', 'mustard', 'mayo', 'mayonnaise', 'beans',
      'lentil', 'canned', 'can of', 'soup', 'cereal', 'oats', 'oatmeal',
      'peanut butter', 'jam', 'jelly', 'honey', 'spice', 'stock', 'broth',
      'tomato sauce', 'salsa', 'baking', 'yeast', 'cornstarch', 'tea bag',
    ],
    Snacks: [
      'chip', 'crisps', 'cracker', 'cookie', 'biscuit', 'candy', 'chocolate',
      'popcorn', 'pretzel', 'nuts', 'almond', 'cashew', 'granola bar',
      'snack', 'trail mix', 'gum',
    ],
    Beverages: [
      'water', 'juice', 'soda', 'pop', 'cola', 'coffee', 'tea', 'beer',
      'wine', 'drink', 'sparkling', 'lemonade', 'kombucha', 'energy drink',
    ],
    Household: [
      'paper towel', 'toilet paper', 'tissue', 'napkin', 'detergent', 'soap',
      'dish', 'sponge', 'trash bag', 'bin bag', 'cleaner', 'bleach', 'wipes',
      'foil', 'plastic wrap', 'ziploc', 'battery', 'bulb', 'light bulb',
      'laundry', 'fabric softener',
    ],
    'Personal care': [
      'shampoo', 'conditioner', 'toothpaste', 'toothbrush', 'deodorant',
      'floss', 'razor', 'shaving', 'lotion', 'sunscreen', 'tampon', 'pad',
      'diaper', 'vitamin', 'medicine', 'bandage', 'body wash', 'hand soap',
      'mouthwash', 'q-tip', 'cotton',
    ],
  },

  // -------------------------------------------------------------------------
  // Spanish. Produce deliberately omits the bare "naranja" so 'jugo de
  // naranja' resolves to Beverages (Produce is scanned first); 'fruta',
  // 'mandarina' etc. keep citrus/produce coverage.
  // -------------------------------------------------------------------------
  es: {
    Produce: [
      'manzana', 'plátano', 'platano', 'banana', 'banano', 'limón', 'limon',
      'lima', 'uva', 'fresa', 'frutilla', 'frambuesa', 'arándano', 'arandano',
      'mora', 'aguacate', 'palta', 'tomate', 'jitomate', 'patata', 'papa',
      'cebolla', 'ajo', 'lechuga', 'espinaca', 'acelga', 'zanahoria', 'apio',
      'pimiento', 'pimentón', 'pepino', 'brócoli', 'brocoli', 'coliflor',
      'champiñón', 'champinon', 'seta', 'calabacín', 'calabacin', 'calabaza',
      'maíz', 'maiz', 'elote', 'ensalada', 'hierba', 'cilantro', 'perejil',
      'albahaca', 'jengibre', 'melón', 'melon', 'sandía', 'sandia', 'durazno',
      'melocotón', 'melocoton', 'pera', 'ciruela', 'mango', 'piña', 'pina',
      'repollo', 'espárrago', 'esparrago', 'fruta', 'verdura', 'mandarina',
      'kiwi',
    ],
    Bakery: [
      'pan', 'panecillo', 'bolillo', 'baguette', 'croissant', 'cruasán',
      'magdalena', 'tortilla', 'pita', 'bagel', 'bollo', 'rosca', 'pastel',
      'tarta', 'dona', 'rosquilla', 'repostería', 'reposteria', 'pan dulce',
    ],
    'Meat & seafood': [
      'pollo', 'carne', 'ternera', 'carne de res', 'cerdo', 'puerco', 'chuleta',
      'bistec', 'filete', 'tocino', 'beicon', 'salchicha', 'chorizo', 'jamón',
      'jamon', 'pavo', 'cordero', 'carne molida', 'carne picada', 'pescado',
      'salmón', 'salmon', 'atún', 'atun', 'gambas', 'camarón', 'camaron',
      'langostino', 'bacalao', 'merluza', 'tilapia', 'cangrejo', 'langosta',
      'marisco', 'sardina',
    ],
    'Dairy & eggs': [
      'leche', 'queso', 'mantequilla', 'manteca', 'yogur', 'yogurt', 'nata',
      'crema', 'huevo', 'requesón', 'requeson', 'cuajada', 'mozzarella',
      'cheddar', 'parmesano', 'feta', 'margarina', 'crema agria', 'kéfir',
      'kefir',
    ],
    Frozen: [
      'congelado', 'congelada', 'helado', 'nieve', 'paleta', 'polo', 'hielo',
      'pizza congelada', 'papas congeladas', 'gofre',
    ],
    Pantry: [
      'arroz', 'pasta', 'fideo', 'harina', 'azúcar', 'azucar', 'sal', 'aceite',
      'aceite de oliva', 'vinagre', 'salsa', 'kétchup', 'ketchup', 'catsup',
      'mostaza', 'mayonesa', 'frijol', 'alubia', 'judías', 'judias', 'garbanzo',
      'lenteja', 'lata', 'enlatado', 'conserva', 'sopa', 'cereal', 'avena',
      'mermelada', 'miel', 'especia', 'levadura', 'maicena', 'caldo',
    ],
    Snacks: [
      'papas fritas', 'patatas fritas', 'papitas', 'chips', 'galleta',
      'galleta salada', 'dulce', 'caramelo', 'chocolate', 'golosina',
      'palomitas', 'pretzel', 'frutos secos', 'nuez', 'nueces', 'almendra',
      'anacardo', 'cacahuate', 'cacahuete', 'maní', 'mani', 'barra de granola',
      'snack', 'botana', 'chicle', 'totopos',
    ],
    Beverages: [
      'agua', 'jugo', 'zumo', 'jugo de naranja', 'refresco', 'gaseosa', 'soda',
      'cola', 'café', 'cafe', 'té', 'infusión', 'infusion', 'manzanilla',
      'cerveza', 'vino', 'bebida', 'agua con gas', 'limonada', 'naranjada',
      'kombucha', 'batido',
    ],
    Household: [
      'papel higiénico', 'papel higienico', 'papel de baño', 'toalla de papel',
      'servilleta', 'pañuelo', 'panuelo', 'detergente', 'jabón', 'jabon',
      'lavavajillas', 'lavaplatos', 'esponja', 'bolsa de basura', 'limpiador',
      'lejía', 'lejia', 'cloro', 'toallitas', 'papel aluminio', 'papel film',
      'film transparente', 'pilas', 'batería', 'bateria', 'bombilla', 'foco',
      'suavizante',
    ],
    'Personal care': [
      'champú', 'champu', 'acondicionador', 'dentífrico', 'dentifrico',
      'cepillo de dientes', 'desodorante', 'hilo dental', 'cuchilla',
      'rasuradora', 'navaja', 'afeitar', 'loción', 'locion', 'protector solar',
      'bloqueador', 'tampón', 'tampon', 'compresa', 'toalla sanitaria', 'pañal',
      'panal', 'vitamina', 'medicina', 'medicamento', 'venda', 'tirita',
      'curita', 'gel de baño', 'enjuague bucal', 'hisopo', 'algodón', 'algodon',
      'maquillaje',
    ],
  },

  // -------------------------------------------------------------------------
  // German.
  // -------------------------------------------------------------------------
  de: {
    Produce: [
      'apfel', 'äpfel', 'apfelsine', 'banane', 'orange', 'zitrone', 'limette',
      'traube', 'beere', 'erdbeere', 'blaubeere', 'himbeere', 'avocado',
      'tomate', 'kartoffel', 'zwiebel', 'knoblauch', 'salat', 'spinat',
      'grünkohl', 'karotte', 'möhre', 'sellerie', 'paprika', 'gurke',
      'brokkoli', 'blumenkohl', 'pilz', 'champignon', 'zucchini', 'kürbis',
      'mais', 'kräuter', 'petersilie', 'basilikum', 'ingwer', 'melone',
      'pfirsich', 'birne', 'pflaume', 'mango', 'ananas', 'kohl', 'spargel',
      'obst', 'gemüse',
    ],
    Bakery: [
      'brot', 'brötchen', 'semmel', 'baguette', 'croissant', 'hörnchen',
      'muffin', 'tortilla', 'fladenbrot', 'bagel', 'kuchen', 'donut', 'gebäck',
      'toast', 'vollkornbrot',
    ],
    'Meat & seafood': [
      'huhn', 'hähnchen', 'hühnchen', 'rind', 'rindfleisch', 'schwein',
      'schweinefleisch', 'steak', 'speck', 'wurst', 'schinken', 'pute',
      'truthahn', 'lamm', 'hackfleisch', 'fleisch', 'fisch', 'lachs',
      'thunfisch', 'garnele', 'krabbe', 'kabeljau', 'forelle', 'hummer',
      'meeresfrüchte', 'hering',
    ],
    'Dairy & eggs': [
      'milch', 'käse', 'butter', 'joghurt', 'sahne', 'rahm', 'eier', 'rührei',
      'quark', 'frischkäse', 'mozzarella', 'cheddar', 'parmesan', 'feta',
      'margarine', 'schlagsahne', 'hüttenkäse', 'buttermilch', 'kefir',
    ],
    Frozen: [
      'gefroren', 'tiefkühl', 'tiefgekühlt', 'eiscreme', 'speiseeis',
      'eis am stiel', 'pommes', 'waffel', 'tiefkühlkost',
    ],
    Pantry: [
      'reis', 'nudel', 'spaghetti', 'mehl', 'zucker', 'salz', 'öl', 'olivenöl',
      'speiseöl', 'essig', 'soße', 'sauce', 'ketchup', 'senf', 'mayonnaise',
      'bohne', 'linsen', 'dose', 'konserve', 'suppe', 'müsli', 'haferflocken',
      'hafer', 'erdnussbutter', 'marmelade', 'konfitüre', 'honig', 'gewürz',
      'brühe', 'backpulver', 'hefe', 'stärke', 'teebeutel',
    ],
    Snacks: [
      'chips', 'cracker', 'keks', 'plätzchen', 'bonbon', 'süßigkeit',
      'schokolade', 'popcorn', 'brezel', 'nüsse', 'mandel', 'cashew',
      'müsliriegel', 'snack', 'knabberei', 'kaugummi', 'erdnuss',
    ],
    Beverages: [
      'wasser', 'saft', 'orangensaft', 'limonade', 'cola', 'soda', 'sprudel',
      'kaffee', 'tee', 'bier', 'wein', 'getränk', 'mineralwasser', 'smoothie',
      'kakao', 'eistee',
    ],
    Household: [
      'küchenrolle', 'toilettenpapier', 'klopapier', 'taschentuch', 'serviette',
      'waschmittel', 'spülmittel', 'seife', 'schwamm', 'müllbeutel', 'reiniger',
      'bleiche', 'feuchttücher', 'alufolie', 'frischhaltefolie', 'batterie',
      'glühlampe', 'leuchtmittel', 'wäsche', 'weichspüler', 'putzmittel',
    ],
    'Personal care': [
      'shampoo', 'spülung', 'zahnpasta', 'zahncreme', 'zahnbürste', 'deo',
      'deodorant', 'zahnseide', 'rasierer', 'rasieren', 'rasur', 'lotion',
      'sonnencreme', 'sonnenschutz', 'tampon', 'binde', 'windel', 'vitamin',
      'medizin', 'medikament', 'pflaster', 'duschgel', 'handseife',
      'mundspülung', 'wattestäbchen', 'watte', 'kosmetik',
    ],
  },

  // -------------------------------------------------------------------------
  // French. 'ail' (garlic) is omitted from Produce so 'volaille' (poultry)
  // sorts to Meat; non-juice beverage cases avoid the orange/jus collision.
  // -------------------------------------------------------------------------
  fr: {
    Produce: [
      'pomme', 'banane', 'orange', 'citron', 'citron vert', 'raisin', 'fraise',
      'framboise', 'myrtille', 'baie', 'avocat', 'tomate', 'pomme de terre',
      'patate', 'oignon', 'laitue', 'salade', 'épinard', 'chou', 'chou-fleur',
      'carotte', 'céleri', 'poivron', 'concombre', 'brocoli', 'champignon',
      'courgette', 'courge', 'maïs', 'herbe', 'persil', 'basilic', 'gingembre',
      'melon', 'pêche', 'poire', 'prune', 'mangue', 'ananas', 'asperge',
      'fruit', 'légume', 'pamplemousse', 'clémentine',
    ],
    Bakery: [
      'pain', 'baguette', 'croissant', 'brioche', 'muffin', 'tortilla', 'pita',
      'gâteau', 'beignet', 'viennoiserie', 'pâtisserie', 'biscotte',
      'petit pain',
    ],
    'Meat & seafood': [
      'poulet', 'volaille', 'bœuf', 'boeuf', 'porc', 'steak', 'bifteck',
      'bacon', 'lard', 'saucisse', 'saucisson', 'jambon', 'dinde', 'agneau',
      'viande hachée', 'viande', 'poisson', 'saumon', 'thon', 'crevette',
      'crabe', 'cabillaud', 'morue', 'homard', 'fruits de mer', 'merlu',
    ],
    'Dairy & eggs': [
      'lait', 'fromage', 'beurre', 'yaourt', 'yogourt', 'crème', 'œuf', 'oeuf',
      'crème fraîche', 'fromage blanc', 'mozzarella', 'cheddar', 'parmesan',
      'feta', 'margarine', 'kéfir',
    ],
    Frozen: [
      'surgelé', 'congelé', 'glace', 'crème glacée', 'esquimau', 'frites',
      'pizza surgelée', 'gaufre',
    ],
    Pantry: [
      'riz', 'pâtes', 'nouilles', 'farine', 'sucre', 'sel', 'huile',
      "huile d'olive", 'vinaigre', 'sauce', 'ketchup', 'moutarde', 'mayonnaise',
      'haricot', 'lentille', 'conserve', 'boîte', 'soupe', 'céréales', 'avoine',
      'flocons', 'beurre de cacahuète', 'confiture', 'miel', 'épice',
      'bouillon', 'levure', 'fécule', 'sachet de thé',
    ],
    Snacks: [
      'chips', 'craquelin', 'biscuit', 'cookie', 'bonbon', 'chocolat',
      'pop-corn', 'bretzel', 'noix', 'amande', 'cajou', 'barre de céréales',
      'en-cas', 'goûter', 'chewing-gum', 'cacahuète', 'friandise',
    ],
    Beverages: [
      'eau', 'jus', "jus d'orange", 'soda', 'limonade', 'cola', 'café', 'thé',
      'bière', 'vin', 'boisson', 'eau gazeuse', 'eau pétillante', 'smoothie',
      'sirop', 'infusion',
    ],
    Household: [
      'essuie-tout', 'papier toilette', 'papier hygiénique', 'mouchoir',
      'serviette', 'lessive', 'détergent', 'savon', 'liquide vaisselle',
      'éponge', 'sac poubelle', 'nettoyant', 'eau de javel', 'javel',
      'lingettes', 'papier aluminium', 'film alimentaire', 'pile', 'ampoule',
      'adoucissant',
    ],
    'Personal care': [
      'shampoing', 'après-shampoing', 'dentifrice', 'brosse à dents',
      'déodorant', 'fil dentaire', 'rasoir', 'rasage', 'lotion', 'crème solaire',
      'écran solaire', 'tampon', 'serviette hygiénique', 'couche', 'vitamine',
      'médicament', 'pansement', 'gel douche', 'savon pour les mains',
      'bain de bouche', 'coton-tige', 'coton', 'maquillage',
    ],
  },

  // -------------------------------------------------------------------------
  // Italian.
  // -------------------------------------------------------------------------
  it: {
    Produce: [
      'mela', 'banana', 'arancia', 'limone', 'lime', 'uva', 'fragola',
      'lampone', 'mirtillo', 'frutto di bosco', 'avocado', 'pomodoro', 'patata',
      'cipolla', 'aglio', 'lattuga', 'insalata', 'spinaci', 'cavolo',
      'cavolfiore', 'carota', 'sedano', 'peperone', 'cetriolo', 'broccoli',
      'fungo', 'funghi', 'zucchina', 'zucca', 'mais', 'granoturco', 'erba',
      'prezzemolo', 'basilico', 'zenzero', 'melone', 'pesca', 'pera', 'prugna',
      'mango', 'ananas', 'asparago', 'frutta', 'verdura', 'pompelmo',
    ],
    Bakery: [
      'pane', 'panino', 'baguette', 'cornetto', 'croissant', 'brioche',
      'muffin', 'tortilla', 'piadina', 'focaccia', 'torta', 'ciambella',
      'pasticcino', 'pane integrale',
    ],
    'Meat & seafood': [
      'pollo', 'manzo', 'carne', 'maiale', 'suino', 'bistecca', 'pancetta',
      'bacon', 'salsiccia', 'salame', 'prosciutto', 'tacchino', 'agnello',
      'carne macinata', 'macinato', 'pesce', 'salmone', 'tonno', 'gambero',
      'gamberetto', 'granchio', 'merluzzo', 'aragosta', 'frutti di mare',
      'vongole', 'sgombro',
    ],
    'Dairy & eggs': [
      'latte', 'formaggio', 'burro', 'yogurt', 'panna', 'uovo', 'uova',
      'ricotta', 'mozzarella', 'cheddar', 'parmigiano', 'grana', 'feta',
      'margarina', 'mascarpone', 'panna acida', 'kefir',
    ],
    Frozen: [
      'surgelato', 'congelato', 'gelato', 'ghiacciolo', 'ghiaccio',
      'pizza surgelata', 'cialda',
    ],
    Pantry: [
      'riso', 'pasta', 'spaghetti', 'tagliatelle', 'farina', 'zucchero', 'sale',
      'olio', "olio d'oliva", 'aceto', 'salsa', 'sugo', 'ketchup', 'senape',
      'maionese', 'fagioli', 'lenticchie', 'scatola', 'in scatola', 'zuppa',
      'minestra', 'cereali', 'avena', 'burro di arachidi', 'marmellata', 'miele',
      'spezia', 'brodo', 'lievito', 'amido',
    ],
    Snacks: [
      'patatine', 'cracker', 'biscotto', 'caramella', 'cioccolato',
      'cioccolata', 'popcorn', 'salatini', 'nocciola', 'noci', 'mandorla',
      'anacardi', 'barretta', 'snack', 'merendina', 'gomma da masticare',
      'arachidi', 'grissini',
    ],
    Beverages: [
      'acqua', 'succo', "succo d'arancia", 'aranciata', 'bibita', 'soda', 'cola',
      'caffè', 'tè', 'birra', 'vino', 'bevanda', 'acqua frizzante',
      'acqua gassata', 'limonata', 'frullato', 'spremuta',
    ],
    Household: [
      'carta igienica', 'carta assorbente', 'fazzoletto', 'tovagliolo',
      'detersivo', 'sapone', 'spugna', 'sacco spazzatura', 'detergente',
      'candeggina', 'salviette', 'pellicola', 'alluminio', 'batteria', 'pila',
      'lampadina', 'ammorbidente',
    ],
    'Personal care': [
      'shampoo', 'balsamo', 'dentifricio', 'spazzolino', 'deodorante',
      'filo interdentale', 'rasoio', 'rasatura', 'lozione', 'crema solare',
      'protezione solare', 'tampone', 'assorbente', 'pannolino', 'vitamina',
      'medicina', 'farmaco', 'cerotto', 'bagnoschiuma', 'collutorio',
      'cotton fioc', 'cotone', 'trucco',
    ],
  },

  // -------------------------------------------------------------------------
  // Portuguese (Brazil).
  // -------------------------------------------------------------------------
  'pt-BR': {
    Produce: [
      'maçã', 'banana', 'laranja', 'limão', 'lima', 'uva', 'morango',
      'framboesa', 'mirtilo', 'amora', 'abacate', 'tomate', 'batata', 'cebola',
      'alho', 'alface', 'salada', 'espinafre', 'couve', 'couve-flor', 'cenoura',
      'aipo', 'pimentão', 'pepino', 'brócolis', 'brocolis', 'cogumelo',
      'abobrinha', 'abóbora', 'milho', 'salsinha', 'manjericão', 'gengibre',
      'melão', 'melancia', 'pêssego', 'pera', 'ameixa', 'manga', 'abacaxi',
      'repolho', 'aspargo', 'fruta', 'legume', 'verdura', 'mexerica',
      'tangerina',
    ],
    Bakery: [
      'pão', 'pao', 'pãozinho', 'baguete', 'croissant', 'broa', 'bisnaga',
      'muffin', 'tortilla', 'pita', 'bolo', 'rosquinha', 'sonho', 'pão de forma',
      'pão francês', 'torrada',
    ],
    'Meat & seafood': [
      'frango', 'carne', 'boi', 'carne bovina', 'porco', 'bife', 'bacon',
      'toucinho', 'linguiça', 'linguica', 'salsicha', 'presunto', 'peru',
      'cordeiro', 'carne moída', 'carne moida', 'peixe', 'salmão', 'salmao',
      'atum', 'camarão', 'camarao', 'caranguejo', 'bacalhau', 'lagosta',
      'frutos do mar', 'sardinha',
    ],
    'Dairy & eggs': [
      'leite', 'queijo', 'manteiga', 'iogurte', 'creme', 'nata', 'ovo',
      'requeijão', 'requeijao', 'mussarela', 'parmesão', 'parmesao', 'cheddar',
      'feta', 'margarina', 'creme de leite', 'kefir',
    ],
    Frozen: [
      'congelado', 'congelada', 'sorvete', 'picolé', 'picole', 'gelo',
      'batata frita congelada', 'pizza congelada', 'waffle',
    ],
    Pantry: [
      'arroz', 'macarrão', 'macarrao', 'massa', 'farinha', 'açúcar', 'acucar',
      'sal', 'óleo', 'oleo', 'azeite', 'vinagre', 'molho', 'ketchup', 'mostarda',
      'maionese', 'feijão', 'feijao', 'lentilha', 'lata', 'enlatado', 'sopa',
      'cereal', 'aveia', 'pasta de amendoim', 'geleia', 'mel', 'especiaria',
      'tempero', 'caldo', 'fermento', 'amido',
    ],
    Snacks: [
      'batata frita', 'salgadinho', 'biscoito', 'bolacha', 'cracker', 'bala',
      'doce', 'chocolate', 'pipoca', 'pretzel', 'castanha', 'amêndoa', 'amendoa',
      'amendoim', 'nozes', 'barra de cereal', 'chiclete', 'petisco',
    ],
    Beverages: [
      'água', 'agua', 'suco', 'suco de laranja', 'refrigerante', 'soda', 'cola',
      'café', 'cafe', 'chá', 'cerveja', 'vinho', 'bebida', 'água com gás',
      'limonada', 'refresco', 'smoothie', 'achocolatado',
    ],
    Household: [
      'papel higiênico', 'papel higienico', 'papel toalha', 'lenço', 'lenco',
      'guardanapo', 'detergente', 'sabão', 'sabao', 'sabonete', 'esponja',
      'saco de lixo', 'desinfetante', 'água sanitária', 'alvejante',
      'lenços umedecidos', 'papel alumínio', 'plástico filme', 'pilha',
      'bateria', 'lâmpada', 'lampada', 'amaciante',
    ],
    'Personal care': [
      'shampoo', 'xampu', 'condicionador', 'pasta de dente', 'escova de dente',
      'desodorante', 'fio dental', 'lâmina', 'lamina', 'barbear', 'loção',
      'locao', 'protetor solar', 'absorvente', 'fralda', 'vitamina', 'remédio',
      'remedio', 'medicamento', 'curativo', 'enxaguante bucal', 'cotonete',
      'algodão', 'algodao', 'maquiagem',
    ],
  },

  // -------------------------------------------------------------------------
  // Japanese (no word spaces — substring matching works on kana/kanji).
  // -------------------------------------------------------------------------
  ja: {
    Produce: [
      'りんご', 'リンゴ', 'バナナ', 'オレンジ', 'みかん', 'ミカン', 'レモン',
      'ライム', 'ぶどう', 'ブドウ', 'いちご', 'イチゴ', 'ベリー', 'アボカド',
      'トマト', 'じゃがいも', 'ジャガイモ', 'ポテト', 'たまねぎ', '玉ねぎ',
      'タマネギ', 'にんにく', 'ニンニク', 'レタス', 'サラダ', 'ほうれん草',
      'ホウレンソウ', 'キャベツ', 'にんじん', 'ニンジン', 'セロリ', 'ピーマン',
      'きゅうり', 'キュウリ', 'ブロッコリー', 'カリフラワー', 'きのこ', 'キノコ',
      'ナス', 'かぼちゃ', 'カボチャ', 'とうもろこし', 'トウモロコシ', 'しょうが',
      'ショウガ', 'メロン', '梨', 'ナシ', 'すいか', 'スイカ', 'マンゴー',
      'パイナップル', '野菜', '果物', 'フルーツ', 'グレープフルーツ',
    ],
    Bakery: [
      'パン', '食パン', 'バゲット', 'クロワッサン', 'マフィン', 'トルティーヤ',
      'ベーグル', 'ケーキ', 'ドーナツ', '菓子パン', 'ロールパン', 'ピタ',
    ],
    'Meat & seafood': [
      '鶏肉', 'とり肉', 'チキン', '牛肉', '肉', '豚肉', 'ポーク', 'ステーキ',
      'ベーコン', 'ソーセージ', 'ウインナー', 'ハム', '七面鳥', 'ターキー',
      'ラム肉', 'ひき肉', '魚', '鮭', 'サーモン', 'まぐろ', 'マグロ', 'ツナ',
      'えび', 'エビ', '海老', 'かに', 'カニ', 'たら', 'タラ', 'ロブスター',
      '魚介', 'シーフード', 'いわし',
    ],
    'Dairy & eggs': [
      '牛乳', 'ミルク', 'チーズ', 'バター', 'ヨーグルト', '生クリーム',
      'ホイップクリーム', '卵', 'たまご', 'タマゴ', '玉子', '練乳', 'モッツァレラ',
      'チェダー', 'パルメザン', 'マーガリン', 'ケフィア',
    ],
    Frozen: [
      '冷凍', 'アイスクリーム', 'アイスバー', 'アイス', '氷', '冷凍ピザ',
      'ワッフル', '冷凍食品', 'フライドポテト',
    ],
    Pantry: [
      '米', 'ごはん', 'ご飯', 'パスタ', 'スパゲッティ', '麺', '小麦粉', '砂糖',
      '塩', '油', 'オイル', 'オリーブオイル', '酢', 'ソース', 'ケチャップ',
      'マスタード', 'マヨネーズ', '豆', 'レンズ豆', '缶詰', 'スープ', 'シリアル',
      'オートミール', 'ピーナッツバター', 'ジャム', 'はちみつ', '蜂蜜', 'スパイス',
      '出汁', 'だし', 'イースト', '片栗粉', 'ティーバッグ', '醤油', 'しょうゆ',
    ],
    Snacks: [
      'ポテトチップス', 'ポテチ', 'チップス', 'クラッカー', 'ビスケット',
      'クッキー', '飴', 'キャンディ', 'チョコ', 'チョコレート', 'ポップコーン',
      'プレッツェル', 'ナッツ', 'アーモンド', 'カシューナッツ', 'お菓子',
      'スナック', 'ガム', 'せんべい', 'ピーナッツ',
    ],
    Beverages: [
      '水', 'お茶', '茶', 'ジュース', 'オレンジジュース', 'ソーダ', '炭酸',
      'コーラ', 'コーヒー', '紅茶', '緑茶', '麦茶', 'ビール', 'ワイン', '飲み物',
      'レモネード', 'スムージー', 'ミネラルウォーター',
    ],
    Household: [
      'トイレットペーパー', 'ティッシュ', 'ナプキン', '洗剤', '石鹸', 'せっけん',
      'スポンジ', 'ゴミ袋', '漂白剤', '除菌', 'ウェットティッシュ', 'アルミホイル',
      'ラップ', '電池', 'バッテリー', '電球', '柔軟剤', 'キッチンペーパー',
    ],
    'Personal care': [
      'シャンプー', 'コンディショナー', 'リンス', '歯磨き粉', '歯ブラシ',
      'デオドラント', 'デンタルフロス', 'カミソリ', '髭剃り', 'ローション',
      '日焼け止め', 'タンポン', '生理用ナプキン', 'おむつ', 'オムツ', 'ビタミン',
      '薬', '医薬品', '絆創膏', 'ボディソープ', 'ハンドソープ', 'マウスウォッシュ',
      '綿棒', 'コットン', '化粧品', '化粧水',
    ],
  },
};
