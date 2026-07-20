# Holey Moley

## Design notes

### Material dig speed

Multiplier applied to the mole's base move/dig speed per material (1 = normal walking speed):

| Material  | Speed |
| --------- | ----- |
| Walking   | 1     |
| Climbing  | 0.8   |
| Sand      | 0.6   |
| Soil      | 0.5   |
| Dirt      | 0.4   |
| Roots     | 0.2   |
| Gravel    | 0.1   |
| Rock      | 0     |

### Terrain layering

The layer right under the grass should be mostly sand, transitioning to soil, then dirt, then
gravel, and finally rock. Some randomization, but in general the material gets denser the
deeper you dig.

### Waterlogging / rain (future)

Once the rain system exists, tiles can darken when waterlogged. Rain adds a dig-speed
multiplier to soil types that decreases with depth - how much depends on both the tile's depth
from the surface and how long it's been raining. After the rain stops, soil dries out at the
inverse ratio, returning to its base dig speed over time.

### Overhang collapse

Each ground material can only support so much of an unsupported "shelf" above open space
before it collapses into the space below. The harder a material is to dig (lower dig-speed
multiplier), the more overhang of that material it can support before collapsing.

### Future features / ideas

- Day/night cycle
- Rain
- Lawn sprinklers
- Poison/gas
- Concrete
- Bees
- Dynamite
- Gasoline, explosives, fire
- Hawk/Owl
- Dog
- Shovel
- Hold a button to dig?
- Rival moles fighting for territory?
- Farmer or lawn-obsessed homeowner as the "villain"
- **Lawn mower**: passes over the surface periodically at random. Grass and flowers slowly
  regrow after being cut. If the mole is caught on the surface, it's a gruesome game over.
  Screen shakes/rumbles as the mower gets closer - more rumble near the surface, less the
  deeper down the mole is.
- **Multiplayer**: share a code (or a link containing the code) with a friend to join the same
  session, two moles playing with shared game state. The sender's copy is the "server" and
  source of truth; the recipient is a client that sends actions and receives updates. Needs
  some way to hash/sync game state between the two.

### Worm creature (future)

- Head/tail sprites plus repeatable middle segments, randomized length
- Small, medium, and large thickness variants
- Grows over time like the Snake game, up to a maximum length
- Biting a worm in the middle splits it into two independent worms that then move off in
  opposite directions
- Worms aerate the soil (makes it softer/faster to dig) but can also open paths for rain to
  seep in or destabilize overhangs

### Level editor (future)

Palette-based block placement - sortable/categorized groups, plus bookmarks for the
most-frequently-used blocks. Something like a Minecraft inventory.
