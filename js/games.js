// The games shown on the game-selection screen. "Coming soon" placeholders are
// replaced by real games as they're built.

/** @type {{id: string, name: string, description: string, available: boolean}[]} */
export const GAMES = [
  { id: 'target-practice', name: 'Target Practice', description: 'Hit the targets as they appear.', available: true },
  { id: 'balloon-pop', name: 'Balloon Pop', description: 'Pop the balloons before they float away.', available: true },
  { id: 'brick-breaker', name: 'Brick Breaker', description: 'Smash every brick on the wall.', available: true },
  { id: 'demolition-day', name: 'Demolition Day', description: 'Flatten the block, then move on to the next level.', available: true },
  { id: 'fielders-choice', name: 'Fielder’s Choice', description: 'Play the field: make the right throw before the runner gets there.', available: true },
  { id: 'gap-shot', name: 'Gap Shot', description: 'Bat for the Rattlers: hit it where the fielders aren’t.', available: true },
  { id: 'dunk-the-clown', name: 'Dunk the Clown', description: 'Hit the bullseye and dunk the clowns.', available: true },
  { id: 'golden-boot', name: 'Golden Boot', description: 'Take ten penalties. Beat the keeper.', available: true },
  { id: 'ball-test', name: 'Ball Test', description: 'Check that throws are being detected.', available: true },
];
