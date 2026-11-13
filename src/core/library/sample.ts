// The demo's sample library: the iPhone app's DemoLibrary.swift, with its picture (Phase 19 brought
// attachments), plus a welcome note. Every item is marked origin 'sample' so it never goes into an account.
import type { Clock } from '../clock.ts'
import type { Library } from './library.ts'
import { RADIATION_SHIELD_PNG_BASE64, RADIATION_SHIELD_PNG_SHA256 } from './sample-image.ts'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

const WELCOME = `This is the real FeatherMark, running in your browser with some sample notes. Write, organise and search as much as you like.

- Notes here aren't saved: closing the tab starts over.
- Nothing you type leaves this browser.
- The Mac, iPhone and iPad apps keep your notes for good, and Feather Cloud syncs them, encrypted.`

/** Fills an empty library; one that already has notes or notebooks is left alone. */
export function seedSampleLibrary(library: Library, clock: Clock): void {
  const c = library.counts()
  if (c.all > 0 || c.trash > 0 || library.notebooks().length > 0) return

  const s = 'sample' as const
  const personal = library.createNotebook('Personal', null, s)
  const projects = library.createNotebook('Projects', null, s)
  const home = library.createNotebook('Home', projects.id, s)
  const work = library.createNotebook('Work', projects.id, s)
  const travel = library.createNotebook('Travel', null, s)

  const hardware = library.createTag('hardware', s)
  library.createTag('ideas', s)
  const reading = library.createTag('reading', s)
  library.createTag('to-do', s)

  const now = clock()
  const ago = (ms: number) => now - ms
  const note = (title: string, body: string, notebookId: string | null, modified: number, tagIds: string[] = []) =>
    library.createNote({ title, body, notebookId, tagIds, modified, created: now, origin: s })

  const draft = note('Old draft', "Notes for a talk I didn't give.", personal.id, ago(20 * DAY))
  library.trashNote(draft.id)
  note('Bread notes', 'Starter fed at 8, ready by 2.\n\n- 500 g flour, 350 g water, 100 g starter, 10 g salt\n- Fold every 30 minutes for 2 hours', personal.id, ago(8 * DAY))
  note('1:1 with Mara', '## Agenda\n\n1. Release dates\n2. Hiring for the spring\n\n> Keep the scope small enough to ship.', work.id, ago(5 * DAY))
  note('Reading list 2027', '- [ ] *The Overstory*\n- [ ] *Braiding Sweetgrass*\n- [x] *Piranesi*', personal.id, ago(DAY), [reading.id])
  note('Lisbon, spring trip', 'Flights land at 10:40. Tram 28 from Martim Moniz early, before the queues.\n\nSee the [tram map](https://www.carris.pt) before going.', travel.id, ago(3 * DAY))
  const groceries = note('Groceries', '- [ ] Oat milk\n- [ ] Lemons\n- [x] Rye flour', personal.id, ago(180 * MINUTE))
  library.setPinned(groceries.id, true)
  const shield = library.addAttachment({
    bytes: Uint8Array.from(atob(RADIATION_SHIELD_PNG_BASE64), (c) => c.charCodeAt(0)),
    filename: 'radiation-shield.png',
    mime: 'image/png',
    sha256: RADIATION_SHIELD_PNG_SHA256,
    origin: s,
  })
  const weather = note(
    'Weather station build',
    `Goal: reliable readings **through winter**. The sensor is a Bosch \`BME280\`; the old DHT22 drifted.\n\n![Radiation shield](feather://attachment/${shield.id})\n\n## Parts\n\n- Raspberry Pi Zero 2 W\n- Radiation shield\n- [x] Order the sensor\n- [ ] Print the mount\n\n> Mount it two metres up, away from the wall.\n\n\`\`\`swift\nlet celsius = Double(raw) / 100\n\`\`\``,
    home.id,
    ago(20 * MINUTE),
    [hardware.id],
  )
  library.setPinned(weather.id, true)
  const welcome = note('Welcome to the FeatherMark demo', WELCOME, null, now)
  library.setPinned(welcome.id, true)
}
