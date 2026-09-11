export type MenuCategory = 'starters' | 'mains' | 'drinks' | 'desserts';

export interface MenuItem {
  id: string;
  name: string;
  desc: string;
  price: number;
  category: MenuCategory;
  emoji: string;
  popular?: boolean;
}

export const CATEGORIES: { id: MenuCategory | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'starters', label: 'Starters' },
  { id: 'mains', label: 'Mains' },
  { id: 'drinks', label: 'Agua & Drinks' },
  { id: 'desserts', label: 'Postres' },
];

export const MENU: MenuItem[] = [
  {
    id: 'guacamole',
    name: 'Guacamole de la Casa',
    desc: 'Tableside molcajete, charred tortillas, radish, cilantro.',
    price: 9.5,
    category: 'starters',
    emoji: '🥑',
    popular: true,
  },
  {
    id: 'elote',
    name: 'Verde Elote',
    desc: 'Grilled street corn, salsa verde crema, cotija, lime.',
    price: 6.5,
    category: 'starters',
    emoji: '🌽',
  },
  {
    id: 'nachos-verdes',
    name: 'Nachos Verdes',
    desc: 'Crispy tostadas, tomatillo queso, black beans, pico.',
    price: 11,
    category: 'starters',
    emoji: '🫔',
  },
  {
    id: 'ceviche-verde',
    name: 'Ceviche Verde',
    desc: 'Sea bass, cucumber, serrano, lime-tomatillo leche de tigre.',
    price: 15,
    category: 'starters',
    emoji: '🐟',
  },
  {
    id: 'tacos-al-pastor',
    name: 'Tacos al Pastor',
    desc: 'Spit-roasted pork, pineapple, onion, cilantro. Order of three.',
    price: 13.5,
    category: 'mains',
    emoji: '🌮',
    popular: true,
  },
  {
    id: 'birria-quesa',
    name: 'Birria Quesadilla',
    desc: 'Slow-braised beef, Oaxaca cheese, consommé for dipping.',
    price: 14.5,
    category: 'mains',
    emoji: '🧀',
    popular: true,
  },
  {
    id: 'enchiladas-verdes',
    name: 'Enchiladas Suizas Verdes',
    desc: 'Corn chicken, roasted tomatillo salsa, cream, melted jack.',
    price: 13,
    category: 'mains',
    emoji: '🌶️',
  },
  {
    id: 'chiles-rellenos',
    name: 'Chiles Rellenos Verdes',
    desc: 'Poblano, picadillo, avocado salsa, epazote rice.',
    price: 12.5,
    category: 'mains',
    emoji: '🥬',
  },
  {
    id: 'agua-lima',
    name: 'Agua Fresca de Limón',
    desc: 'Hand-pressed limes, cane sugar, mint, plenty of ice.',
    price: 4,
    category: 'drinks',
    emoji: '🍋',
  },
  {
    id: 'horchata',
    name: 'Horchata Verde',
    desc: 'Almond-cinnamon rice milk, a whisper of pistachio.',
    price: 4.5,
    category: 'drinks',
    emoji: '🥛',
  },
  {
    id: 'agua-jamaica',
    name: 'Agua de Jamaica',
    desc: 'Hibiscus brewed overnight with orange peel and clove.',
    price: 4,
    category: 'drinks',
    emoji: '🌺',
  },
  {
    id: 'michelada',
    name: 'Michelada Verde',
    desc: 'Lager, clamato, serrano-hoj santa rim, lime.',
    price: 8,
    category: 'drinks',
    emoji: '🍺',
  },
  {
    id: 'churros',
    name: 'Churros con Cajeta',
    desc: 'Cinnamon sugar, warm goat-milk caramel for dipping.',
    price: 7,
    category: 'desserts',
    emoji: '🥨',
  },
  {
    id: 'tres-leches',
    name: 'Tres Leches Verde',
    desc: 'Pistachio-vanilla sponge, three milks, torched meringue.',
    price: 6.5,
    category: 'desserts',
    emoji: '🍰',
  },
];

export const MENU_MAP: Map<string, MenuItem> = new Map(MENU.map((m) => [m.id, m]));

export const usd = (n: number): string => `$${n.toFixed(2)}`;

export const TAX_RATE = 0.0825;
