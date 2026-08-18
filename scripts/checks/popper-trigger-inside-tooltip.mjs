// Guardrail against a menu, popover or select whose trigger is nested inside a <Tooltip>.
//
// This is not a style rule. It is the bug renanfranca reported on 2026-08-18 (issue #15,
// "What do these options do? I click on them, but nothing opens"), and it had already been
// mis-diagnosed once and shipped broken for four releases.
//
// THE MECHANISM, which is invisible in the markup. reka's MenuRoot, PopoverRoot, SelectRoot and
// TooltipRoot each render a PopperRoot, and a PopperRoot `provide`s the anchor element its popper
// positions against. Every trigger registers itself through PopperAnchor, which `inject`s the
// NEAREST PopperRoot. So this shape:
//
//     <DropdownMenu>                        <- PopperRoot A
//       <Tooltip>                           <- PopperRoot B, nested inside A
//         <TooltipTrigger as-child>
//           <span>
//             <DropdownMenuTrigger as-child> <- its PopperAnchor injects B, not A
//               <Button/>
//       <DropdownMenuContent/>              <- its PopperContent injects A, which has NO anchor
//
// leaves A anchor-less. Floating UI never gets a reference element, `isPositioned` stays false, and
// PopperContent keeps its pre-position style `transform: translate(0, -200%)`. The menu genuinely
// opens — aria-expanded goes true, every item is in the DOM, no error is logged — two menu-heights
// above the top of the window. To a user it is a dead button, and to a developer reading the DOM it
// looks fine. Verified against a running 0.21.3 build: the wrapper measured (0, -594) for a 297px
// menu, with `--reka-popper-transform-origin` still empty.
//
// THE RULE: the popper's own root must be INSIDE the TooltipTrigger, so it is the nearest
// PopperRoot for both its trigger and its content:
//
//     <Tooltip>
//       <TooltipTrigger as-child>
//         <span class="inline-flex">      <- the tooltip's anchor; must be a real box
//           <DropdownMenu>                <- now the nearest PopperRoot for both of the below
//             <DropdownMenuTrigger as-child><Button/></DropdownMenuTrigger>
//             <DropdownMenuContent/>
//           </DropdownMenu>
//         </span>
//       </TooltipTrigger>
//       <TooltipContent/>
//     </Tooltip>
//
// WHY A CHECK AS WELL AS A TEST. A jsdom test CAN catch this, once you know to wait for Floating UI
// and to assert the transform rather than the rect: web/test/components/ViewOptions.test.ts does
// exactly that, and it is the better guard for the one component it covers. What it cannot do is
// scale. The defect spread by COPY-PASTE — four independent components carried it, three of them
// with a comment confidently explaining a DIFFERENT cause — and writing a mount-and-wait test for
// every future toolbar button is not a thing anyone will keep doing. This rule costs nothing per
// component and catches the fifth one on the day it is written, including in components whose
// dependencies (Monaco, async chunks) make a full mount test more trouble than it is worth.
//
// The rule is stated as "the NEAREST enclosing popper root must be the trigger's own", which is the
// actual invariant rather than a proxy for it. A trigger textually inside a <Tooltip> is perfectly
// fine — the fixed shape above is exactly that — as long as its own root sits between them.
// ContextMenu counts: its trigger registers a VIRTUAL reference through the same PopperAnchor
// (reka ContextMenuTrigger passes `reference: virtualEl`), so a shadowed root breaks it identically.
//
// DELIBERATELY NOT FLAGGED:
//   · A trigger with no popper root above it at all. That is the ui/ primitive wrapper components
//     (ui/dropdown-menu/*.vue and friends), which re-export a reka part in isolation and are
//     composed by their callers.
//   · Anything inside an HTML comment. This repo's components explain this very pattern in prose,
//     including the fixed ones, and a scan that reads a comment as markup would fail the fix.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'popper-trigger-inside-tooltip'

// Every component that renders a reka PopperRoot, i.e. every element that shadows the anchor
// context for everything beneath it. Verified against reka-ui 2.10.1: TooltipRoot, MenuRoot (which
// DropdownMenuRoot and ContextMenuRoot both render), MenuSub, PopoverRoot, SelectRoot,
// HoverCardRoot and ComboboxRoot each `createBlock(PopperRoot)`.
const POPPER_ROOTS = new Set([
  'Tooltip',
  'DropdownMenu',
  'DropdownMenuSub',
  'ContextMenu',
  'Popover',
  'Select',
  'HoverCard',
  'Combobox',
  'MenubarMenu',
])

// The parts that must resolve to their OWN root: a trigger registers the anchor, and a content
// positions against it. Both inject the nearest PopperRoot, so both have to find the right one.
const PARTS = new Map([
  ['TooltipTrigger', 'Tooltip'],
  ['TooltipContent', 'Tooltip'],
  ['DropdownMenuTrigger', 'DropdownMenu'],
  ['DropdownMenuContent', 'DropdownMenu'],
  ['DropdownMenuSubTrigger', 'DropdownMenuSub'],
  ['DropdownMenuSubContent', 'DropdownMenuSub'],
  ['ContextMenuTrigger', 'ContextMenu'],
  ['ContextMenuContent', 'ContextMenu'],
  ['PopoverTrigger', 'Popover'],
  ['PopoverAnchor', 'Popover'],
  ['PopoverContent', 'Popover'],
  ['SelectTrigger', 'Select'],
  ['SelectContent', 'Select'],
  ['HoverCardTrigger', 'HoverCard'],
  ['HoverCardContent', 'HoverCard'],
  ['ComboboxTrigger', 'Combobox'],
  ['ComboboxAnchor', 'Combobox'],
  ['ComboboxContent', 'Combobox'],
  ['MenubarTrigger', 'MenubarMenu'],
  ['MenubarContent', 'MenubarMenu'],
])

/** Blank HTML comments, preserving offsets so reported line numbers stay true. */
function blankComments(src) {
  const out = src.split('')
  let i = 0
  while (i < src.length) {
    if (src[i] === '<' && src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      const stop = end === -1 ? src.length : end + 3
      for (let k = i; k < stop; k++) if (out[k] !== '\n') out[k] = ' '
      i = stop
      continue
    }
    i++
  }
  return out.join('')
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.vue')) out.push(p)
  }
  return out
}

const TAG = /<(\/?)([A-Za-z][A-Za-z0-9]*)\b([^>]*?)(\/?)>/g

/**
 * Every popper part whose nearest enclosing PopperRoot belongs to a DIFFERENT component.
 *
 * A stack of open roots is all this needs: the part's owner must be on top when it opens. Parts
 * with an empty stack are skipped — those are the ui/ primitive wrappers, which render one reka
 * part in isolation for a caller to compose.
 */
function scan(src) {
  const body = blankComments(src)
  const tplAt = body.indexOf('<template>')
  if (tplAt < 0) return []

  const hits = []
  const stack = [] // [{ tag, index }], innermost last
  TAG.lastIndex = tplAt
  let m
  while ((m = TAG.exec(body))) {
    const [, close, name, , selfClose] = m
    if (POPPER_ROOTS.has(name)) {
      if (close) {
        // Pop to the nearest matching open, so one stray tag cannot desync the whole file.
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].tag === name) {
            stack.length = i
            break
          }
        }
      } else if (!selfClose) {
        stack.push({ tag: name, index: m.index })
      }
      continue
    }
    if (close || !PARTS.has(name)) continue
    const owner = PARTS.get(name)
    const nearest = stack[stack.length - 1]
    if (!nearest || nearest.tag === owner) continue
    hits.push({ index: m.index, name, owner, shadowedBy: nearest.tag, shadowIndex: nearest.index })
  }
  return hits
}

const lineAt = (src, index) => src.slice(0, index).split('\n').length

export const audit = {
  id: ID,
  title: "a menu/popover part must resolve to its OWN PopperRoot, not a Tooltip's",
  category: 'custom',
  domain: 'code',
  requires: {},
  // Gating: the failure is silent and total — the control does nothing, logs nothing, and looks
  // correct in the DOM. It shipped to users and was reported from the field.
  gating: true,
  async run(ctx) {
    const root = ctx?.root ?? process.cwd()
    const srcDir = join(root, 'web', 'src')
    const findings = []

    let files = []
    try {
      files = walk(srcDir)
    } catch {
      return { failed: false, findings, report: 'No web/src directory; nothing to check.' }
    }

    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const rel = relative(root, file).split('\\').join('/')
      for (const hit of scan(text)) {
        findings.push({
          id: ID,
          file: rel,
          line: lineAt(text, hit.index),
          severity: 'error',
          message:
            `<${hit.name}> belongs to <${hit.owner}>, but the nearest PopperRoot above it is the ` +
            `<${hit.shadowedBy}> opened on line ${lineAt(text, hit.shadowIndex)}. It registers its ` +
            `anchor there, so <${hit.owner}>'s own root stays empty, Floating UI never gets a ` +
            'reference element, and the content keeps `translate(0, -200%)` — it opens two heights ' +
            'above the viewport, where nobody can see it. The control reads as dead: no error, ' +
            'correct aria, nothing on screen. This is issue #15.',
          fix:
            `Nest <${hit.owner}> INSIDE the <${hit.shadowedBy}>'s trigger rather than around it: ` +
            '<Tooltip> > <TooltipTrigger as-child> > <span class="inline-flex"> > <DropdownMenu> > ' +
            "trigger + content. Keep the span — it is the tooltip's anchor and must be a real box " +
            '(`inline-flex`, never `display: contents`), and it also keeps two `as-child` triggers ' +
            'from merging onto one element. web/src/components/ui/ViewOptions.vue is the reference ' +
            'copy of the correct shape.',
        })
      }
    }

    const failed = findings.length > 0
    const report = failed
      ? `Found ${findings.length} popper trigger(s) nested inside a <Tooltip>:\n${findings
          .map((f) => `- ${f.file}:${f.line}`)
          .join('\n')}`
      : 'Every menu/popover trigger owns the nearest PopperRoot. ✓'

    return { failed, findings, report }
  },
}

// Standalone CLI (used by CI): prints the report and exits 1 on any violation. During an arkitect
// run the module is only IMPORTED, so this block is inert there; it fires only on direct invocation.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const res = await audit.run({ root: process.cwd() })
  console.log(res.report)
  if (res.failed) process.exit(1)
}
