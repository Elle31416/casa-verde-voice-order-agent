export interface DemoTurn {
  speaker: 'casa' | 'guest';
  text: string;
  /** Quantities to increment on the ticket. */
  add?: Record<string, number>;
  /** Absolute quantities to set on the ticket (0 removes the line). */
  set?: Record<string, number>;
}

/** Scripted "voice session" played back word-by-word for the demo. */
export const DEMO_TURNS: DemoTurn[] = [
  {
    speaker: 'casa',
    text: '¡Bienvenido to Casa Verde! I’m Verde, your host tonight. Tell me what the table is craving — add, swap, or ask me anything.',
  },
  {
    speaker: 'guest',
    text: 'Hi! Start us off with the guacamole with chips, one elote with extra lime, and two aguas frescas — a lime and a horchata.',
    add: { guacamole: 1, elote: 1, 'agua-lima': 1, horchata: 1 },
  },
  {
    speaker: 'casa',
    text: 'Done — guacamole, elote with extra lime, lime agua and horchata. Fair warning: the al pastor sells out by eight. Want me to lock in four tacos?',
  },
  {
    speaker: 'guest',
    text: 'Yes, grab us four tacos al pastor. And swap the horchata for the jamaica, please.',
    add: { 'tacos-al-pastor': 4 },
    set: { horchata: 0, 'agua-jamaica': 1 },
  },
  {
    speaker: 'casa',
    text: 'Four al pastor, horchata swapped for jamaica — nice call, we brewed it this morning. Anything sweet for after?',
  },
  {
    speaker: 'guest',
    text: 'One plate of churros con cajeta. That’s everything — send it when you can.',
    add: { churros: 1 },
  },
  {
    speaker: 'casa',
    text: 'All set. Hit send on your ticket and I’ll walk it over — the kitchen is running about fourteen minutes tonight.',
  },
];
